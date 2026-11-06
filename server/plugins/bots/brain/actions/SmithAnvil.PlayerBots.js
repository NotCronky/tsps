"use strict";

const Smithing = require("../../../skills/Smithing.plugin");
const { resolveCatalogObjectIds } = require("../ObjectCatalog.PlayerBots");
const { playerState } = require("../ActionState.PlayerBots");
const { createObjectReachChecker } = require("../../behaviours/navigation/ObjectReach.PlayerBots");
const { approachBlockedObject, approachObject } = require("../../behaviours/navigation/Navigation.PlayerBots");

const ANVIL_IDS = Object.freeze(resolveCatalogObjectIds({ catalog: "anvil" }));
const MAX_DIRECT_ROUTE_TILES = 20;
const INTERACT_COOLDOWN_MS = 1500;
const SMITH_ALL = 28;
// Tries at the anvil that start nothing: it can't smith this (no hammer, a level, a quest).
const FAILED_TRIES = 3;

/**
 * Smiths `itemId` from the carried bars at the nearest anvil, completing when the bars for one
 * more are gone (the activity then banks and repeats). The bars are used on the anvil (the
 * normal item-on-object code) and the product picked through the Smithing plugin's bot entry,
 * as choosing it in the smithing interface would, so its checks and XP apply.
 *
 * JSON: { "type": "smithAnvil", "itemId": productItemId, "barId": barItemId, "bars": barsEach }
 */
function createSmithAnvilAction(spec, world) {
  const { itemId, barId, bars = 1 } = spec;
  const canReach = createObjectReachChecker(world.core);
  const stateFor = (player) => playerState(action, player, () => ({ lastClickAt: 0, tries: 0 }));

  function nearestAnvil(player) {
    const loc = player.getLocation();
    let best = null;
    let bestDistSq = Infinity;
    for (const object of world.objectSearch?.findCandidatesByIds?.(player, ANVIL_IDS, {
      regionRadius: 2, z: loc.getZ(), privateArea: player.getPrivateArea?.() ?? null,
    }) ?? []) {
      const at = object?.getLocation?.();
      if (!at || at.getZ() !== loc.getZ()) continue;
      const distSq = (at.getX() - loc.getX()) ** 2 + (at.getY() - loc.getY()) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = object;
      }
    }
    return best;
  }

  const action = {
    id: "smithAnvil",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (Smithing.isSmithingActive?.(player)) {
        bot.tries = 0;
        return "running";
      }
      if (player.getInventory().getAmount(barId) < bars) return "success";
      const anvil = nearestAnvil(player);
      if (!anvil) return "failed";
      const at = anvil.getLocation();
      const loc = player.getLocation();
      if (Math.max(Math.abs(loc.getX() - at.getX()), Math.abs(loc.getY() - at.getY())) > MAX_DIRECT_ROUTE_TILES) {
        approachObject(player, anvil, { nowMs, reason: "brain_anvil_approach" });
        return "running";
      }
      if (player.getForceMovement?.() != null || player.getMovementQueue?.()?.size?.() > 0) return "running";
      if (nowMs - bot.lastClickAt < INTERACT_COOLDOWN_MS) return "running";
      if (bot.tries >= FAILED_TRIES) return "failed";
      bot.lastClickAt = nowMs;
      if (approachBlockedObject(player, anvil, { nowMs, reason: "brain_anvil_approach", canReach })) return "running";
      bot.tries += 1;
      player.getMovementQueue().walkToObject(anvil, {
        execute: () => {
          player.setPositionToFace?.(at);
          Smithing.startBotSmithing?.(player, itemId, SMITH_ALL);
        },
      });
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.lastClickAt = 0;
      bot.tries = 0;
    },
    describe() {
      return `smith ${itemId} at an anvil`;
    },
  };
  return action;
}

module.exports = { createSmithAnvilAction };
