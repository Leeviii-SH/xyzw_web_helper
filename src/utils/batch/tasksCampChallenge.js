/**
 * 营地挑战类任务
 * 包含: batchCampChallenge, batchCampChallengePet, batchCampClaimTasks
 */

/**
 * 创建营地挑战类任务执行器
 * @param {object} deps - 依赖项
 * @returns {object} 任务函数集合
 */
export function createTasksCampChallenge(deps) {
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
    loadSettings,
  } = deps;

  /**
   * 一键营地挑战
   */
  const batchCampChallenge = async () => {
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
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始营地挑战: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);
        if (shouldStop.value) return;

        // 1. 获取我方阵容配置（参考 QuenchAnalysisCard.refreshHeroes）
        const [presetTeamResult, roleInfoResult] = await Promise.all([
          tokenStore.sendMessageWithPromise(
            tokenId,
            "presetteam_getinfo",
            {},
            5000,
          ),
          tokenStore.sendMessageWithPromise(
            tokenId,
            "role_getroleinfo",
            {},
            15000,
          ),
        ]);

        const lordWeaponId = roleInfoResult?.role?.lordWeaponId || 0;

        // 解析阵容数据，优先使用竞技场阵容
        const tokenSettings = loadSettings ? loadSettings(tokenId) : {};
        const formationId = String(tokenSettings?.arenaFormation || 1);
        const root =
          presetTeamResult?.presetTeamInfo?.presetTeamInfo ||
          presetTeamResult?.presetTeamInfo ||
          {};
        const teamInfoData =
          root[formationId]?.teamInfo || root["1"]?.teamInfo || {};

        const battleTeam = {};
        for (const [pos, hero] of Object.entries(teamInfoData)) {
          const hid = hero?.heroId ?? hero?.id;
          if (hid) {
            battleTeam[pos] = Number(hid);
          }
        }

        if (Object.keys(battleTeam).length === 0) {
          throw new Error(`无法获取阵容${formationId}数据`);
        }

        const teamSetParams = {
          lordWeaponId,
          petUId: "",
          battleTeam,
        };

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 使用阵容${formationId}: ${Object.values(battleTeam).join(", ")}`,
          type: "info",
        });

        // 2. 获取营地信息和挑战目标
        const res = await tokenStore.sendMessageWithPromise(
          tokenId,
          "club_getinfo",
          {},
          8000,
        );

        // 检查今日挑战次数
        const now = new Date();
        const todayKey =
          String(now.getFullYear() % 100).padStart(2, "0") +
          String(now.getMonth() + 1).padStart(2, "0") +
          String(now.getDate()).padStart(2, "0");
        const siege = res?.siege || {};
        const attackMap = siege.attackMap || {};
        const todayAttack = attackMap[todayKey] || {};
        const attackCnt = todayAttack.attackCnt || 0;
        const maxAttacks = 10;

        if (attackCnt >= maxAttacks) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 今日挑战次数已达上限(${attackCnt}/${maxAttacks})`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 今日已挑战 ${attackCnt}/${maxAttacks} 次`,
          type: "info",
        });

        const oppoMap = res?.club?.oppoMap || {};
        const opponents = Object.entries(oppoMap).sort(
          ([a], [b]) => Number(a) - Number(b),
        );

        if (opponents.length === 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 没有可挑战的目标`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        // 3. 收集所有可挑战的防守者，随机顺序挑战（最多3次）
        const remainingAttacks = Math.min(maxAttacks - attackCnt, 3);
        let attackCount = 0;

        // 收集所有未击败的防守者到一个池子
        const availableTargets = [];
        for (const [oppoKey, opponent] of opponents) {
          const defenders = opponent.defenders || {};
          for (const [nodeId, defender] of Object.entries(defenders)) {
            if (!defender.defeated) {
              availableTargets.push({
                oppoKey,
                opponentName: opponent.name,
                nodeId,
                defender,
              });
            }
          }
        }

        if (availableTargets.length === 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 所有目标均已击败或无可挑战目标`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        // 随机打乱顺序
        for (let i = availableTargets.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [availableTargets[i], availableTargets[j]] = [
            availableTargets[j],
            availableTargets[i],
          ];
        }

        for (const target of availableTargets) {
          if (shouldStop.value || attackCount >= remainingAttacks) break;

          const { opponentName, nodeId, defender } = target;

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 挑战目标(${attackCount + 1}/${remainingAttacks}): ${opponentName} - ${defender.name} (节点${nodeId})`,
            type: "info",
          });

          try {
            // 获取目标阵容
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_gettargetteam",
              { targetId: defender.roleId },
              5000,
            );

            // 发起挑战
            const attackRes = await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_attack",
              {
                nodeId: Number(nodeId),
                targetId: defender.roleId,
                challengeCnt: defender.challengeCnt || 0,
                failCnt: defender.failCnt || 0,
                useItem: false,
                teamSetParams,
              },
              8000,
            );

            // 判断战斗结果
            const battleResult =
              attackRes?.battleData?.result?.accept?.ext?.curHP;
            const isWin = battleResult === 0;
            const rewardCount = attackRes?.reward?.length || 0;

            attackCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${isWin ? "胜利" : "失败"}: ${opponentName} - ${defender.name}${rewardCount > 0 ? ` (获得${rewardCount}个奖励)` : ""}`,
              type: isWin ? "success" : "error",
            });

            if (isWin) {
              defender.defeated = true;
            }
          } catch (err) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 挑战 ${defender.name} 失败: ${err.message || "未知错误"}`,
              type: "error",
            });
          }
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 营地挑战完成，共挑战 ${attackCount} 次`,
          type: "info",
        });

        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 营地挑战失败: ${error.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量营地挑战结束");

    // 领取任务奖励
    await batchCampClaimTasks();
  };

  /**
   * 一键营地挑战宠物
   */
  const batchCampChallengePet = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const maxRounds = 3;
    for (let round = 1; round <= maxRounds; round++) {
      if (shouldStop.value) break;

      const taskPromises = selectedTokens.value.map(async (tokenId) => {
        if (shouldStop.value) return;
        tokenStatus.value[tokenId] = "running";
        const token = tokens.value.find((t) => t.id === tokenId);
        try {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 营地挑战宠物 ${token.name} (第${round}/${maxRounds}轮) ===`,
            type: "info",
          });
          await ensureConnection(tokenId);
          if (shouldStop.value) return;

          // 获取我方阵容配置
          const [presetTeamResult, roleInfoResult] = await Promise.all([
            tokenStore.sendMessageWithPromise(
              tokenId,
              "presetteam_getinfo",
              {},
              5000,
            ),
            tokenStore.sendMessageWithPromise(
              tokenId,
              "role_getroleinfo",
              {},
              15000,
            ),
          ]);

          const lordWeaponId = roleInfoResult?.role?.lordWeaponId || 0;

          // 解析阵容数据，优先使用竞技场阵容
          const tokenSettings = loadSettings ? loadSettings(tokenId) : {};
          const formationId = String(tokenSettings?.arenaFormation || 1);
          const root =
            presetTeamResult?.presetTeamInfo?.presetTeamInfo ||
            presetTeamResult?.presetTeamInfo ||
            {};
          const teamInfoData =
            root[formationId]?.teamInfo || root["1"]?.teamInfo || {};

          const battleTeam = {};
          for (const [pos, hero] of Object.entries(teamInfoData)) {
            const hid = hero?.heroId ?? hero?.id;
            if (hid) {
              battleTeam[pos] = Number(hid);
            }
          }

          if (Object.keys(battleTeam).length === 0) {
            throw new Error(`无法获取阵容${formationId}数据`);
          }

          const teamSetParams = {
            lordWeaponId,
            petUId: "",
            battleTeam,
          };

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 使用阵容${formationId}: ${Object.values(battleTeam).join(", ")}`,
            type: "info",
          });

          // 挑战宠物
          const attackRes = await tokenStore.sendMessageWithPromise(
            tokenId,
            "club_attackmonster",
            {
              useItem: false,
              teamSetParams,
            },
            8000,
          );

          const battleResult =
            attackRes?.battleData?.result?.accept?.ext?.curHP;
          const isWin = battleResult === 0;
          const rewardCount = attackRes?.reward?.length || 0;

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 挑战宠物${isWin ? "胜利" : "失败"}${rewardCount > 0 ? ` (获得${rewardCount}个奖励)` : ""}`,
            type: isWin ? "success" : "error",
          });

          tokenStatus.value[tokenId] = "completed";
        } catch (error) {
          console.error(error);
          tokenStatus.value[tokenId] = "failed";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 营地挑战宠物失败: ${error.message || "未知错误"}`,
            type: "error",
          });
        } finally {
          tokenStore.closeWebSocketConnection(tokenId);
          releaseConnectionSlot();
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 连接已关闭`,
            type: "info",
          });
        }
      });

      await Promise.all(taskPromises);
    }

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量营地挑战宠物结束");

    // 领取任务奖励
    await batchCampClaimTasks();
  };

  /**
   * 领取营地挑战任务奖励
   * 通过 role_getroleinfo 获取 siege.taskProgress 和 siege.taskClaimedMap
   * taskProgress: 1/2/3 是3个区域(值为1可领取), 4是挑战3次(值>=3可领取)
   * taskClaimedMap 中已有的 key 表示已领取
   */
  const batchCampClaimTasks = async () => {
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
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始领取营地任务奖励: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);
        if (shouldStop.value) return;

        await tokenStore.sendMessageWithPromise(
          tokenId,
          "club_getinfo",
          {},
          15000,
        );

        let claimedCount = 0;
        for (const confId of [1, 2, 3, 4]) {
          if (shouldStop.value) break;
          try {
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_taskclaim",
              { confId },
              5000,
            );
            claimedCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 成功领取任务 ${confId} 奖励`,
              type: "success",
            });
          } catch (err) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 领取任务 ${confId} 失败: ${err.message || "未知错误"}`,
              type: "error",
            });
          }
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 营地任务奖励领取完成，共领取 ${claimedCount} 个`,
          type: "info",
        });

        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 领取营地任务奖励失败: ${error.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量领取营地任务奖励结束");
  };


  /**
   * 营地挑战（按战力挑选目标）：
   * 只打「还没到目标胜次、且敌人战力打得过」的点位，镜像位带 targetIsMirror。
   * 参数（region/tier/wins/attempts/powerWin/powerEasy/losses）由页面传入；
   * 协议字段全部来自客户端抓包（targetIsMirror / useDiamond / petUId）。
   */
  const batchCampChallengeSmart = async (cfg = {}) => {
    if (selectedTokens.value.length === 0) return;
    const opt = {
      region: 1, tier: 3, wins: 3, attempts: 10,
      powerWin: 5_000_000_000, powerEasy: 3_000_000_000, losses: 3,
      ...cfg,
    };
    const now = new Date();
    const weekday = now.getDay();
    if (weekday < 2 || weekday > 4) {
      message.warning("营地挑战只在周二/三/四开放");
      return;
    }
    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const oppoKey = String(weekday); // 2=周二 3=周三 4=周四（oppoMap 的键就是星期）
    const [from, to] = opt.region === 1 ? [1, 10] : opt.region === 2 ? [11, 20] : [21, 30];
    const nodeIds = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const powers = new Map(); // roleId → 战力，跨号共享，省请求
    const winsOf = (d) => Math.max(0, Number(d?.challengeCnt || 0) - Number(d?.failCnt || 0));
    const todayKey = String(now.getFullYear() % 100).padStart(2, "0") + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");

    await Promise.all(selectedTokens.value.map(async (tokenId) => {
      const token = tokens.value.find((t) => t.id === tokenId);
      let wins = 0, attempts = 0, streak = 0;
      const blocked = new Set();
      try {
        tokenStatus.value[tokenId] = "running";
        currentRunningTokenId.value = tokenId;
        addLog({ time: new Date().toLocaleTimeString(), message: `=== 营地挑战(按战力) 开始: ${token.name} ===`, type: "info" });
        await ensureConnection(tokenId);

        const info = await tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 12000);
        const role = info?.role || {};
        const battleTeam = {};
        for (const [pos, hero] of Object.entries(role.battleTeam || {})) {
          const hid = hero?.heroId ?? hero?.id;
          if (hid) battleTeam[pos] = Number(hid);
        }
        if (!Object.keys(battleTeam).length) throw new Error("主线阵容为空");
        const teamSetParams = {
          lordWeaponId: role.lordWeaponId || 0,
          petUId: role.pet?.petUId || "",
          battleTeam,
        };

        while (!shouldStop.value && wins < opt.wins && attempts < opt.attempts && streak < opt.losses) {
          const res = await tokenStore.sendMessageWithPromise(tokenId, "club_getinfo", {}, 10000);
          const stat = (res?.siege?.attackMap || {})[todayKey] || {};
          const wonToday = Math.max(Number(stat.aSuccessCnt || 0), wins);
          const usedToday = Math.max(Number(stat.attackCnt || 0), attempts);
          if (wonToday >= opt.wins) { addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 今日已贡献 ${wonToday} 胜，跳过`, type: "info" }); break; }
          if (usedToday >= opt.attempts) { addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 今日次数已用完（${usedToday}/${opt.attempts}）`, type: "warning" }); break; }

          const defenders = res?.club?.oppoMap?.[oppoKey]?.defenders || {};
          for (const nid of nodeIds) {
            const d = defenders[nid] ?? defenders[String(nid)];
            if (!d || powers.has(d.roleId)) continue;
            let power = NaN;
            try {
              const t = await tokenStore.sendMessageWithPromise(tokenId, "club_gettargetteam", { targetId: d.roleId }, 6000);
              power = Number(t?.roleBattleTeam?.role?.power ?? NaN);
            } catch { /* 回退下一个接口 */ }
            if (!Number.isFinite(power)) {
              try {
                const t2 = await tokenStore.sendMessageWithPromise(tokenId, "role_gettargetteam", { targetId: d.roleId }, 6000);
                power = Number(t2?.teamInfo?.power ?? NaN);
              } catch { power = NaN; }
            }
            powers.set(d.roleId, power);
          }

          const cands = [];
          for (const nid of nodeIds) {
            if (blocked.has(nid)) continue;
            const d = defenders[nid] ?? defenders[String(nid)];
            if (!d) continue;
            const w = winsOf(d);
            const deficit = opt.tier - w;
            if (d.defeated || deficit <= 0) continue;
            const power = Number(powers.get(d.roleId));
            if (!Number.isFinite(power) || power > opt.powerWin) continue;
            cands.push({ nodeId: nid, d, deficit, power, easy: power <= opt.powerEasy });
          }
          cands.sort((a, b) => b.deficit - a.deficit || (b.easy - a.easy) || a.power - b.power || a.nodeId - b.nodeId);
          if (!cands.length) { addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 区域${opt.region} 没有可打的目标`, type: "warning" }); break; }

          const t = cands[0];
          addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 打点位${t.nodeId} ${t.d.name}（${winsOf(t.d)}/${opt.tier} 胜，战力 ${(t.power / 1e8).toFixed(2)} 亿${t.d.mirror ? "，镜像" : ""}）`, type: "info" });
          attempts++;
          try {
            const atk = await tokenStore.sendMessageWithPromise(tokenId, "club_attack", {
              nodeId: t.nodeId,
              targetId: t.d.roleId,
              targetIsMirror: Boolean(t.d.mirror),
              challengeCnt: Number(t.d.challengeCnt || 0),
              failCnt: Number(t.d.failCnt || 0),
              useItem: false,
              teamSetParams,
              useDiamond: 0,
            }, 12000);
            const ok = typeof atk?.battleData?.result?.isWin === "boolean"
              ? atk.battleData.result.isWin
              : atk?.battleData?.result?.accept?.ext?.curHP === 0;
            if (ok) { wins++; streak = 0; addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 胜利 ${wins}/${opt.wins}`, type: "success" }); }
            else { streak++; blocked.add(t.nodeId); addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 失败（连续失败 ${streak}/${opt.losses}）`, type: "warning" }); }
          } catch (err) {
            streak++;
            blocked.add(t.nodeId);
            addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 挑战出错 ${String(err?.message || err).slice(0, 60)}（连续失败 ${streak}/${opt.losses}）`, type: "warning" });
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        const reason = wins >= opt.wins ? "达到胜利上限" : streak >= opt.losses ? "连续失败过多" : attempts >= opt.attempts ? "尝试次数用尽" : "无可打目标";
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 结束（胜 ${wins}，尝试 ${attempts}，${reason}）`, type: "info" });
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        tokenStatus.value[tokenId] = "failed";
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 营地挑战失败: ${error?.message || error}`, type: "error" });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 连接已关闭`, type: "info" });
      }
    }));

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("营地挑战（按战力挑选）结束");
  };

  return {
    batchCampChallenge,
    batchCampChallengePet,
    batchCampClaimTasks,
    batchCampChallengeSmart,
  };
}
