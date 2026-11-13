/**
 * 玄武赐福（通行证活动）批量任务
 * 顺序执行：任务领取 -> 通行证奖励 -> 免费珍宝 -> 抽奖 -> 点卯 -> 抽奖后二次领取
 * 抽奖会推进任务进度（如"抽奖X次"类任务），故抽奖后需重新拉取并再领一轮
 */

import { getXuanwuActBase } from "@/utils/towerActId";

// 活动ID后缀（前缀为当天日期 YYMMDD）
const WAR_ORDER_SUFFIX = "1";
const SIGN_SUFFIX = "5";
const GOODS_SUFFIX = "41";

// 每日任务要求：抽奖 10 次 + 竞技场战斗 1 次（2026-11 游戏改版）
// 任务进度在 warOrderActivityInfo.complete 里，id 规则 = actId + "01"(抽奖) / "02"(竞技场)
const DRAW_MISSION_SUFFIX = "01";
const ARENA_MISSION_SUFFIX = "02";
const DEFAULT_DRAW_TIMES = 10;
const DEFAULT_ARENA_TIMES = 1;

// 通行证奖励领取最大轮数
const MAX_REWARD_ROUNDS = 10;

// 点卯补领天数（patchDay 0-6）
const SIGN_MAX_DAY = 6;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatReward = (reward = []) =>
  reward
    .map((r) => {
      if (r.type === 2) return `金砖x${r.value}`;
      if (r.type === 3) return `道具${r.itemId}x${r.value}`;
      return `类型${r.type}x${r.value}`;
    })
    .join(", ");

/**
 * 创建玄武赐福批量任务执行器
 * @param {object} deps - 依赖项
 * @returns {object} 任务函数集合
 */
export function createTasksXuanwuBlessing(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
    delayConfig,
    batchSettings,
    pickArenaTargetId,
    loadSettings,
  } = deps;

  const commandDelay = delayConfig?.command || delayConfig?.action || 300;

  const log = (msg, type = "info") =>
    addLog({ time: new Date().toLocaleTimeString(), message: msg, type });

  /** 拉取通行证活动信息 */
  const fetchWarOrder = async (tokenId, actId) => {
    try {
      const res = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_warorderget",
        { actId },
        8000,
      );
      return res?.activity?.warOrderActivityInfo?.[actId] || null;
    } catch {
      return null;
    }
  };

  /** 解析当前活动ID：先用日期推导，取不到再逐天回退探测 */
  const resolveWarOrder = async (tokenId) => {
    const candidates = [];
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      candidates.push(Number(getXuanwuActBase(date) + WAR_ORDER_SUFFIX));
    }

    for (const actId of candidates) {
      const info = await fetchWarOrder(tokenId, actId);
      if (info) return { actId, info };
    }

    return null;
  };

  /** 领取通行证任务（每日/每周/本期），返回领取/跳过数 */
  const claimTasks = async (tokenId, actId, info, tokenName) => {
    const complete = info?.complete || {};
    const claimedMap = info?.taskClaimed || {};
    let claimed = 0;
    let skipped = 0;

    for (const [missionIdStr, progress] of Object.entries(complete)) {
      if (shouldStop.value) break;
      if (claimedMap[missionIdStr] === true) continue;
      if (!(progress > 0)) continue;

      try {
        const res = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_warordertaskclaim",
          { actId, missionId: Number(missionIdStr) },
          8000,
        );
        const latest =
          res?.activity?.warOrderActivityInfo?.[actId]?.taskClaimed;
        if (latest) Object.assign(claimedMap, latest);

        if (res?.reward?.length) {
          log(
            `${tokenName} 任务${missionIdStr}领取: ${formatReward(res.reward)}`,
            "success",
          );
          claimed++;
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }
      await delay(commandDelay);
    }

    if (claimed > 0 || skipped > 0) {
      log(
        `${tokenName} 通行证任务: 领取 ${claimed}, 跳过 ${skipped}`,
        claimed > 0 ? "success" : "info",
      );
    }
    return { claimed, skipped };
  };

  /** 通行证奖励领取（可能产出抽奖券），返回领取轮数 */
  const claimPassRewards = async (tokenId, actId, tokenName) => {
    let rounds = 0;
    for (let round = 0; round < MAX_REWARD_ROUNDS; round++) {
      if (shouldStop.value) break;
      try {
        const res = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_warorderrewardclaim",
          { actId },
          8000,
        );
        if (!res?.reward?.length) break;
        log(
          `${tokenName} 通行证奖励领取: ${formatReward(res.reward)}`,
          "success",
        );
        rounds++;
      } catch {
        // 已无可领取奖励
        break;
      }
      await delay(commandDelay);
    }
    if (rounds > 0) {
      log(`${tokenName} 通行证奖励: 领取 ${rounds} 次`, "success");
    }
    return rounds;
  };

  /** 免费珍宝购买（产出抽奖券） */
  const buyFreeGoods = async (tokenId, goodsId, tokenName) => {
    try {
      const res = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_commonbuygoods",
        { goodsId },
        8000,
      );
      log(
        `${tokenName} 免费珍宝购买成功${res?.reward?.length ? `: ${formatReward(res.reward)}` : ""}`,
        "success",
      );
      return true;
    } catch {
      log(`${tokenName} 免费珍宝今日已购买或不可购买`);
      return false;
    }
  };

  /** 抽奖（会推进抽奖类任务进度） */
  const doLottery = async (tokenId, tokenName, times = DEFAULT_DRAW_TIMES) => {
    try {
      const lotteryInfo = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_getlotteryinfo",
        {},
        8000,
      );
      log(
        `${tokenName} 抽奖信息: ${JSON.stringify(lotteryInfo?.lotteryInfo || {})}`,
      );
    } catch {
      // 抽奖信息获取失败不影响抽奖
    }

    let count = 0;
    for (let i = 0; i < times; i++) {
      if (shouldStop.value) break;
      try {
        const res = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_lottery",
          { times: 1 },
          8000,
        );
        log(
          `${tokenName} 抽奖第${i + 1}次: ${formatReward(res?.reward || []) || "无奖励"}`,
          "success",
        );
        count++;
      } catch (error) {
        log(`${tokenName} 抽奖失败: ${error.message || "未知错误"}`, "warning");
        break;
      }
      await delay(commandDelay);
    }
    return count;
  };

  /** 补竞技场战斗（玄武每日任务要求 1 次）；门票不足/未开赛只记 warning，不拖垮整个任务 */
  const ensureArenaBattle = async (tokenId, tokenName, times) => {
    if (!(times > 0)) return 0;

    let role = tokenStore.gameData?.roleInfo?.role;
    if (!role) {
      try {
        role = (await tokenStore.sendGetRoleInfo(tokenId))?.role;
      } catch {}
    }
    const ticketCount = role?.items?.[1007]?.quantity || 0;
    if (ticketCount <= 0) {
      log(`${tokenName} 咸神门票不足，跳过竞技场补次`, "warning");
      return 0;
    }

    const tokenSettings = loadSettings ? loadSettings(tokenId) || {} : {};
    try {
      const teamInfo = await tokenStore.sendMessageWithPromise(
        tokenId,
        "presetteam_getinfo",
        {},
        5000,
      );
      const cur = teamInfo?.presetTeamInfo?.useTeamId;
      const want = tokenSettings.arenaFormation || 1;
      if (cur !== want) {
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "presetteam_saveteam",
          { teamId: want },
          5000,
        );
        log(`${tokenName} 竞技场阵容切换到${want}`);
      }
    } catch {}

    const fights = Math.min(times, ticketCount);
    let done = 0;
    for (let i = 0; i < fights; i++) {
      if (shouldStop.value) break;
      try {
        await tokenStore.sendMessageWithPromise(tokenId, "arena_startarea", {});
        const targets = await tokenStore.sendMessageWithPromise(
          tokenId,
          "arena_getareatarget",
          {},
        );
        const targetId = pickArenaTargetId ? pickArenaTargetId(targets) : null;
        if (!targetId) {
          log(`${tokenName} 竞技场未找到可用目标`, "warning");
          break;
        }
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "fight_startareaarena",
          { targetId },
        );
        done++;
        log(`${tokenName} 竞技场补次 ${i + 1}/${fights} 完成`, "success");
      } catch (error) {
        log(`${tokenName} 竞技场补次失败: ${error.message || error}`, "warning");
        break;
      }
      await delay(commandDelay);
    }
    return done;
  };

  /** 玄武点卯（patchDay 0-6 补领） */
  const claimSign = async (tokenId, signActivityId, tokenName) => {
    let claimed = 0;
    let skipped = 0;
    for (let patchDay = 0; patchDay <= SIGN_MAX_DAY; patchDay++) {
      if (shouldStop.value) break;
      try {
        const res = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_claimsignreward",
          { activityId: signActivityId, patchDay },
          8000,
        );
        if (res?.reward?.length) {
          log(
            `${tokenName} 点卯第${patchDay + 1}天领取: ${formatReward(res.reward)}`,
            "success",
          );
          claimed++;
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }
      await delay(commandDelay);
    }
    log(
      `${tokenName} 玄武点卯: 领取 ${claimed} 天, 跳过 ${skipped} 天`,
      claimed > 0 ? "success" : "info",
    );
    return claimed;
  };

  /** 批量执行玄武赐福 */
  const batchXuanwuBlessing = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);
      try {
        log(`=== 开始玄武赐福: ${token.name} ===`);
        await ensureConnection(tokenId);
        if (shouldStop.value) return;

        const resolved = await resolveWarOrder(tokenId);
        if (!resolved) {
          throw new Error("未找到玄武赐福活动，请确认活动是否开启");
        }
        const { actId, info } = resolved;
        const base = String(actId).slice(0, 6);
        const signActivityId = Number(base + SIGN_SUFFIX);
        const goodsId = Number(base + GOODS_SUFFIX);

        // 1. 先领一轮任务 + 通行证奖励，同时攒抽奖券
        const first = await claimTasks(tokenId, actId, info, token.name);
        let passRewards = await claimPassRewards(tokenId, actId, token.name);

        // 2. 免费珍宝购买（产出抽奖券）
        await buyFreeGoods(tokenId, goodsId, token.name);
        await delay(commandDelay);

        // 2.5 先点卯再抽奖：点卯是当天的抽奖券来源（今天不领，今天就可能一次都抽不了）
        const signCnt = await claimSign(tokenId, signActivityId, token.name);

        // 3. 按需补齐每日任务：抽奖 10 次 + 竞技场 1 次（进度看 complete，缺多少补多少）
        const drawTarget =
          Number(batchSettings?.xuanwuDrawTimes) || DEFAULT_DRAW_TIMES;
        const arenaTarget =
          Number(batchSettings?.xuanwuArenaBattles) || DEFAULT_ARENA_TIMES;
        const beforeComplete = (await fetchWarOrder(tokenId, actId))?.complete || info?.complete || {};
        const arenaId = `${actId}${ARENA_MISSION_SUFFIX}`;
        // 抽奖次数只能看 lotteryInfo.lotteryNum：complete 里 01 号任务是别的计数（实测抽奖不涨）
        let drawDone = 0;
        try {
          const lotteryInfo = await tokenStore.sendMessageWithPromise(
            tokenId,
            "activity_getlotteryinfo",
            {},
            8000,
          );
          drawDone = Number(lotteryInfo?.lotteryInfo?.lotteryNum) || 0;
        } catch {}
        const arenaDone = Number(beforeComplete[arenaId] || 0);
        const drawNeed = Math.max(0, drawTarget - drawDone);
        const arenaNeed = Math.max(0, arenaTarget - arenaDone);
        if (drawNeed > 0) {
          log(`${token.name} 抽奖进度 ${drawDone}/${drawTarget}（lotteryNum），补 ${drawNeed} 次`);
        }
        if (arenaNeed > 0) {
          log(`${token.name} 竞技场进度 ${arenaDone}/${arenaTarget}，补 ${arenaNeed} 次`);
        }
        const lotteryCnt = await doLottery(tokenId, token.name, drawNeed);
        if (lotteryCnt > 0) {
          // 抽完再看一次：lotteryNum 是累计次数，boxPackIdList 是待领/待开的宝箱（诊断累计返还没领到时看这里）
          try {
            const after = await tokenStore.sendMessageWithPromise(
              tokenId,
              "activity_getlotteryinfo",
              {},
              8000,
            );
            const li = after?.lotteryInfo || {};
            log(
              `${token.name} 抽奖后：次数=${li.lotteryNum} 待开宝箱=${JSON.stringify(li.boxPackIdList || [])}`,
            );
          } catch {}
        }
        const arenaCnt = await ensureArenaBattle(tokenId, token.name, arenaNeed);

        // 5. 抽奖/点卯/竞技场后先补一轮通行证奖励（抽奖 1/5/10 次的档位是这里领的），
        //    再反复「拉取 → 领取任务」：游戏是分段解锁的，一轮领取拿不全
        passRewards += await claimPassRewards(tokenId, actId, token.name);

        let secondClaimed = 0;
        let claimRounds = 0;
        if (lotteryCnt > 0 || arenaCnt > 0 || signCnt > 0) {
          for (let round = 0; round < 5; round++) {
            if (shouldStop.value) break;
            const latestInfo = await fetchWarOrder(tokenId, actId);
            if (!latestInfo) break;
            const next = await claimTasks(tokenId, actId, latestInfo, token.name);
            if (next.claimed === 0) break;
            secondClaimed += next.claimed;
            claimRounds++;
            passRewards += await claimPassRewards(tokenId, actId, token.name);
            await delay(commandDelay);
          }
          if (claimRounds > 0) {
            log(`${token.name} 分段任务领取 ${claimRounds} 轮，共 ${secondClaimed} 个`, "success");
          }
        }

        log(
          `${token.name} 玄武赐福完成: 任务${first.claimed + secondClaimed}, 通行证奖励${passRewards}, 点卯${signCnt}, 抽奖${lotteryCnt}, 竞技场${arenaCnt}`,
          "success",
        );

        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        log(
          `${token.name} 玄武赐福失败: ${error.message || "未知错误"}`,
          "error",
        );
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        log(`${token.name} 连接已关闭`);
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量玄武赐福结束");
  };

  return {
    batchXuanwuBlessing,
  };
}
