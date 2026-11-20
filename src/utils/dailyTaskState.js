const configsByVersion = new Map();
const activeTokenRuns = new Set();

// The official HangUpInviteDialog exposes four help slots, independently of daily tasks.
const HANG_UP_HELP_SLOTS = 4;

/**
 * Keep daily and hang-up operations for one account from overlapping.
 * @param {string} tokenId Account identity.
 * @param {Function} execute Operation to execute once.
 * @returns {Promise<*>} The operation result; the lock is always released.
 */
export async function runWithDailyTaskLock(tokenId, execute) {
  if (activeTokenRuns.has(tokenId))
    throw new Error("该账号的日常或挂机任务正在执行中");
  activeTokenRuns.add(tokenId);
  try {
    return await execute();
  } finally {
    activeTokenRuns.delete(tokenId);
  }
}

/**
 * Count unexpired help slots using the official client's checkFriendTimeout order.
 * @param {object} role Fresh role_getroleinfo data, including hangUp.helpFriend.
 * @param {number} serverTime Server response timestamp in milliseconds.
 * @returns {{active: number, remaining: number}} Occupied slots and slots to fill.
 * @throws {Error} When the server snapshot or server clock cannot be trusted.
 */
export function getHangUpState(role, serverTime) {
  const hangUp = role?.hangUp;
  const helpers = hangUp?.helpFriend;
  if (
    !Number.isFinite(serverTime) ||
    serverTime <= 0 ||
    !Number.isFinite(hangUp?.checkTime) ||
    hangUp.checkTime < 0 ||
    !Array.isArray(helpers) ||
    helpers.length > HANG_UP_HELP_SLOTS ||
    helpers.some(
      (helper) =>
        !Number.isInteger(helper?.helpTime) ||
        helper.helpTime <= 0 ||
        !Number.isInteger(helper.slot) ||
        helper.slot < 0 ||
        helper.slot >= HANG_UP_HELP_SLOTS,
    ) ||
    new Set(helpers.map((helper) => helper.slot)).size !== helpers.length
  ) {
    const error = new Error("服务器挂机槽位或时间不完整，不能判断加钟状态");
    error.hangUpStateUnavailable = true;
    throw error;
  }
  let elapsed = Math.max(serverTime / 1000 - hangUp.checkTime, 0);
  let active = 0;
  for (const helper of helpers) {
    if (elapsed >= helper.helpTime) elapsed -= helper.helpTime;
    else active++;
  }
  return { active, remaining: HANG_UP_HELP_SLOTS - active };
}

/**
 * Fill only the server's empty help slots, then verify with one fresh snapshot.
 * No local completion cache or automatic write retry is used.
 * @param {object} options Transport, account, cancellation, logging and read/send hooks.
 * @param {object} options.tokenStore Live account transport and connection state.
 * @param {string} options.tokenId Account to query and extend.
 * @param {Function} [options.readRole] Read a fresh role snapshot without retries.
 * @param {Function} [options.sendCommand] Send one hang-up share command.
 * @param {Function} [options.check] Check cancellation before another operation.
 * @param {Function} [options.onLog] Report execution and server verification.
 * @param {Function} [options.sleep] Await the requested delay.
 * @param {number} [options.delay] Delay after each share acknowledgement.
 * @returns {Promise<object>} Sent request count and server-confirmed remaining slots.
 * @throws {Error} On unavailable state, disconnect, cancellation or command failure.
 */
export async function fillHangUpTime({
  tokenStore,
  tokenId,
  readRole = () =>
    tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 15000),
  sendCommand = () =>
    tokenStore.sendMessageWithPromise(
      tokenId,
      "system_mysharecallback",
      { isSkipShareCard: true, type: 2 },
      8000,
    ),
  check = () => {},
  onLog = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delay = 500,
}) {
  let snapshotClient;
  const assertConnected = () => {
    check();
    const status = tokenStore.getWebSocketStatus?.(tokenId);
    if (
      (status && status !== "connected") ||
      (snapshotClient &&
        snapshotClient !== tokenStore.wsConnections?.[tokenId]?.client)
    ) {
      const error = new Error(
        "WebSocket 已断开，停止加钟并等待重新读取服务器状态",
      );
      error.interrupted = true;
      throw error;
    }
  };
  const readState = async () => {
    assertConnected();
    // role_getroleinfo is limited independently of the share command.
    await sleep(1000);
    assertConnected();
    const client = tokenStore.wsConnections?.[tokenId]?.client;
    const response = await readRole();
    assertConnected();
    if (client !== tokenStore.wsConnections?.[tokenId]?.client) {
      const error = new Error("连接会话已变化，请重新读取服务器挂机状态");
      error.interrupted = true;
      throw error;
    }
    snapshotClient = client;
    return getHangUpState(response?.role, client?.serverTime);
  };
  const before = await readState();
  if (!before.remaining) {
    onLog("跳过挂机加钟：服务器确认助力槽位已满");
    return { sent: 0, ...before };
  }
  onLog(
    `服务器挂机槽位 ${before.active}/${HANG_UP_HELP_SLOTS}，补加钟 ${before.remaining} 次`,
  );
  for (let i = 0; i < before.remaining; i++) {
    assertConnected();
    onLog(`执行挂机加钟 ${i + 1}/${before.remaining}`);
    await sendCommand();
    assertConnected();
    await sleep(delay);
  }
  const after = await readState();
  onLog(
    after.remaining
      ? `加钟后服务器仍有 ${after.remaining} 个空槽位，保留待继续`
      : "服务器确认挂机加钟已补满",
  );
  return { sent: before.remaining, ...after };
}

/**
 * Load task targets from the official data version returned by the game server.
 * Only immutable configuration is cached; role progress is never cached here.
 * @param {object} tokenStore Live command transport.
 * @param {string} tokenId Selected account identity.
 * @param {Function} [fetchConfig] Fetch implementation for the official CDN.
 * @returns {Promise<object>} Validated task definitions and point-reward thresholds.
 */
// 官方配置拿不到时的本地兜底（2026-11 更新后 config.json 404）。
// 目标次数来自历史成功日志与代码：登录1/分享1/赠币3/招募2/挂机5/点金3/宝箱3/黑市1/竞技场1/盐罐1。
// 奖励表留空：点奖励暂时不领（服务器会拒绝也不影响任务本身），等官方配置恢复后自动走官方数据。
const FALLBACK_DAILY_TASKS = [
  { id: 1, completeCondition: 1, completeValue: 1 },
  { id: 2, completeCondition: 2, completeValue: 1 },
  { id: 3, completeCondition: 3, completeValue: 3 },
  { id: 4, completeCondition: 4, completeValue: 2 },
  { id: 5, completeCondition: 5, completeValue: 5 },
  { id: 6, completeCondition: 6, completeValue: 3 },
  { id: 7, completeCondition: 7, completeValue: 3 },
  { id: 8, completeCondition: 12, completeValue: 1 },
  { id: 9, completeCondition: 13, completeValue: 1 },
  { id: 10, completeCondition: 14, completeValue: 1 },
];

function buildFallbackConfig() {
  return {
    tasks: FALLBACK_DAILY_TASKS.map((t) => ({ ...t })),
    dailyRewards: [],
    weeklyRewards: [],
    fallback: true,
  };
}

// 官方配置的真实获取路径（2026-11 更新后 /data/<ver>/config.json 已下线）：
// 客户端用的是 Cocos 资源包 —— /remote/config/config.<ver>.json 是包清单，
// 其中 name="config" 的 cc.JsonAsset 才是整份配置 JSON（约 11MB，外面套一层序列化数组）。
// 这份配置只有游戏更新（dataBundleVer 变化）才会变，而且整包 11MB、本机下载要 60s+。
// 只把用得到的 4 张表（约 22KB）按版本号落盘，下次同版本进程直接读。
// 注意：这段只在 Node 侧生效（服务端任务），浏览器构建里没有 fs，自动跳过、退回内存缓存。
const CACHE_KEYS = ["DailyTaskConf", "DayLimitConf", "WeekLimitConf", "ConstantConf"];
let diskModules;

async function loadDiskModules() {
  if (diskModules !== undefined) return diskModules;
  try {
    if (typeof window !== "undefined" || !globalThis.process?.versions?.node) {
      diskModules = null;
    } else {
      const [fsMod, pathMod] = await Promise.all([import("node:fs"), import("node:path")]);
      diskModules = { fs: fsMod.default ?? fsMod, path: pathMod.default ?? pathMod };
    }
  } catch {
    diskModules = null;
  }
  return diskModules;
}

function cacheFile(mods, version) {
  const dir = globalThis.process?.env?.XYZW_DAILY_CONFIG_CACHE || mods.path.join(globalThis.process.cwd(), "data", "state");
  return mods.path.join(dir, `xyzw-daily-config-${version}.json`);
}

async function readCachedConfig(version) {
  const mods = await loadDiskModules();
  if (!mods) return null;
  try {
    const parsed = JSON.parse(mods.fs.readFileSync(cacheFile(mods, version), "utf8"));
    return parsed?.DailyTaskConf ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCachedConfig(version, config) {
  const mods = await loadDiskModules();
  if (!mods) return;
  try {
    const file = cacheFile(mods, version);
    mods.fs.mkdirSync(mods.path.dirname(file), { recursive: true });
    const slim = {};
    for (const key of CACHE_KEYS) if (config[key]) slim[key] = config[key];
    mods.fs.writeFileSync(file, JSON.stringify(slim));
  } catch {}
}

const RES_CDN = "https://xxz-xyzw-res.hortorgames.com";
const B64_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const HEX_CHARS = "0123456789abcdef";

/** Cocos 压缩 uuid(22 位) → 标准 uuid */
function decompressUuid(uuid) {
  if (!uuid || uuid.length !== 22) return uuid;
  const out = [uuid[0], uuid[1]];
  for (let i = 2, j = 2; i < 22; i += 2) {
    const lhs = B64_KEYS.indexOf(uuid[i]);
    const rhs = B64_KEYS.indexOf(uuid[i + 1]);
    out[j++] = HEX_CHARS[lhs >> 2];
    out[j++] = HEX_CHARS[((lhs & 3) << 2) | (rhs >> 4)];
    out[j++] = HEX_CHARS[rhs & 15];
  }
  const hex = out.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function jsonFromBundlePayload(raw) {
  if (!Array.isArray(raw)) return raw;
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    for (const item of entry) {
      if (Array.isArray(item) && typeof item[2] === "object" && item[2] !== null) {
        if (item[2].DailyTaskConf) return item[2];
      }
    }
  }
  return null;
}

async function fetchOfficialConfig(version, fetchConfig) {
  const cached = await readCachedConfig(version);
  if (cached) return cached;
  const timeout = { signal: AbortSignal.timeout(120000) };
  const manifestRes = await fetchConfig(`${RES_CDN}/remote/config/config.${version}.json`, timeout);
  if (!manifestRes.ok) throw new Error(`配置包清单 HTTP ${manifestRes.status}`);
  const manifest = await manifestRes.json();
  const paths = manifest?.paths || {};
  const types = manifest?.types || [];
  let assetIndex = null;
  for (const [idx, info] of Object.entries(paths)) {
    if (info?.[0] === "config" && types[info?.[1]] === "cc.JsonAsset") {
      assetIndex = Number(idx);
      break;
    }
  }
  if (assetIndex === null) throw new Error("配置包里找不到 config JSON 资源");
  const importVers = manifest?.versions?.import || [];
  let hash = null;
  for (let i = 0; i + 1 < importVers.length; i += 2) {
    if (Number(importVers[i]) === assetIndex) hash = importVers[i + 1];
  }
  if (!hash) throw new Error("配置包缺少资源版本号");
  const uuid = decompressUuid(manifest?.uuids?.[assetIndex]);
  if (!uuid) throw new Error("配置包缺少资源 uuid");
  const assetUrl = `${RES_CDN}/remote/config/import/${uuid.slice(0, 2)}/${uuid}.${hash}.json`;
  const assetRes = await fetchConfig(assetUrl, timeout);
  if (!assetRes.ok) throw new Error(`配置资源 HTTP ${assetRes.status}`);
  const raw = await assetRes.json();
  const config = jsonFromBundlePayload(raw);
  if (!config) throw new Error("配置资源里没有 DailyTaskConf");
  await writeCachedConfig(version, config);
  return config;
}

export async function loadDailyTaskConfig(
  tokenStore,
  tokenId,
  fetchConfig = globalThis.fetch,
) {
  const response = await tokenStore.sendMessageWithPromise(
    tokenId,
    "system_getdatabundlever",
    {},
    15000,
  );
  const version = response?.dataBundleVer;
  if (typeof version !== "string" || !/^[\w-]+$/.test(version))
    throw new Error("服务器未提供有效的任务配置版本");
  if (!configsByVersion.has(version)) {
    const loading = (async () => {
      try {
        const config = await fetchOfficialConfig(version, fetchConfig);
        return validateDailyTaskConfig(config);
      } catch (error) {
        // 官方配置不可用 → 用本地兜底，任务照常跑（目标次数写死，奖励表留空）
        console.warn(
          `[dailyTask] 官方任务配置读取失败（${String(error?.message || error)}），改用本地兜底配置`,
        );
        return buildFallbackConfig();
      }
    })();
    configsByVersion.set(version, loading);
    loading.catch(() => {
      if (configsByVersion.get(version) === loading)
        configsByVersion.delete(version);
    });
    for (const key of configsByVersion.keys()) {
      if (key !== version) configsByVersion.delete(key);
    }
  }
  return configsByVersion.get(version);
}

/**
 * Validate official task IDs separately from their completion-condition IDs.
 * @param {object} config Official configuration response.
 * @returns {object} Minimal task and reward configuration.
 * @throws {Error} When targets or reward thresholds cannot be trusted.
 */
export function validateDailyTaskConfig(config) {
  const tasks = Object.values(config?.DailyTaskConf ?? {});
  const dailyRewards = Object.values(config?.DayLimitConf ?? {});
  const weeklyRewards = Object.values(config?.WeekLimitConf ?? {});
  if (
    !tasks.length ||
    !dailyRewards.length ||
    !weeklyRewards.length ||
    tasks.some(
      (task) =>
        !Number.isInteger(task.id) ||
        task.id <= 0 ||
        !Number.isInteger(task.completeCondition) ||
        task.completeCondition <= 0 ||
        !Number.isInteger(task.completeValue) ||
        task.completeValue <= 0,
    ) ||
    new Set(tasks.map((task) => task.id)).size !== tasks.length ||
    new Set(tasks.map((task) => task.completeCondition)).size !==
      tasks.length ||
    [dailyRewards, weeklyRewards].some(
      (rewards) =>
        new Set(rewards.map((reward) => reward.id)).size !== rewards.length,
    ) ||
    [...dailyRewards, ...weeklyRewards].some(
      (reward) =>
        !Number.isInteger(reward.id) ||
        reward.id <= 0 ||
        !Number.isFinite(reward.limit) ||
        reward.limit < 0,
    )
  )
    throw new Error("官方每日任务配置无效，停止执行");
  const claimSeconds = config?.ConstantConf?.stayRewardTime;
  return {
    tasks,
    dailyRewards,
    weeklyRewards,
    ...(Number.isFinite(claimSeconds) && claimSeconds > 0
      ? { hangUpClaimInterval: claimSeconds * 1000 }
      : {}),
  };
}

/**
 * Decode a freshly fetched role's daily progress, including unclaimed completion.
 * Missing counters in an otherwise valid server map represent zero progress.
 * @param {object} role Role returned by the live role_getroleinfo response.
 * @param {object} config Validated official definitions.
 * @returns {Array<object>} Pending, claimable or claimed tasks with remaining counts.
 * @throws {Error} When the server snapshot is incomplete or malformed.
 */
export function getDailyTaskStates(role, config) {
  const daily = role?.dailyTask;
  if (
    !Number.isFinite(daily?.dailyTime) ||
    daily.dailyTime <= 0 ||
    !daily.complete ||
    typeof daily.complete !== "object" ||
    Array.isArray(daily.complete)
  )
    throw new Error("服务器任务列表不完整，不能判断完成状态");
  return config.tasks.map((task) => {
    const value = Object.hasOwn(daily.complete, task.completeCondition)
      ? daily.complete[task.completeCondition]
      : 0;
    if (!Number.isInteger(value) || value < -1)
      throw new Error("服务器任务进度无效，停止执行");
    const claimed = value === -1;
    const progress = claimed ? task.completeValue : value;
    return {
      id: task.id,
      condition: task.completeCondition,
      required: task.completeValue,
      progress,
      remaining: Math.max(task.completeValue - progress, 0),
      status: claimed
        ? "claimed"
        : progress >= task.completeValue
          ? "claimable"
          : "pending",
    };
  });
}

/**
 * Determine point rewards from the server's point total and claimed-reward map.
 * @param {object} daily Server dailyTask data.
 * @param {Array<object>} definitions Official reward IDs and thresholds.
 * @param {boolean} [weekly] Select weekPoint/weekReward instead of daily fields.
 * @returns {Array<number>} Only eligible, unclaimed server reward IDs.
 */
export function getClaimablePointRewards(daily, definitions, weekly = false) {
  const points = daily?.[weekly ? "weekPoint" : "dailyPoint"];
  const claimed = daily?.[weekly ? "weekReward" : "dailyReward"];
  if (
    !Number.isFinite(points) ||
    !claimed ||
    typeof claimed !== "object" ||
    Array.isArray(claimed) ||
    Object.values(claimed).some((value) => typeof value !== "boolean")
  )
    throw new Error("服务器积分奖励状态不完整");
  return definitions
    .filter((reward) => points >= reward.limit && claimed[reward.id] !== true)
    .map((reward) => reward.id);
}
