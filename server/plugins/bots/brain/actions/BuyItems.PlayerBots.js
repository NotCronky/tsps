"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { requestMovement, peekMovementRequest } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { nearestClusters, npcClustersFor } = require("../NpcClusterIndex.PlayerBots");
const Supplies = require("../../lib/Supplies.PlayerBots");

// Close enough to the shopkeeper to trade (the Trade option's reach, roughly).
const TRADE_RANGE = 3;
// Not moving this long on the way to a shop: give up so the task backs off.
const STUCK_MS = 30000;

/**
 * Walks to the nearest keeper of a shop that stocks `item` (found through the NPC cluster
 * index, no hard-coded shop locations) and buys `amount` through the normal shop code: prices,
 * stock and coins as for a player. Fails when no shop stocks it or the coins run short.
 */
function createBuyItemsAction(spec, world) {
  const itemId = spec.item;
  const amount = Math.max(1, Math.floor(Number(spec.amount ?? 1)));
  const shops = Supplies.shopsSelling(itemId);
  const shopByKeeper = new Map();
  for (const shop of shops) for (const npcId of shop.npcIds) shopByKeeper.set(npcId, shop.shopId);
  const keeperShop = (npc) => shopByKeeper.get(npc?.getDefinition?.()?.getId?.());
  const stateFor = (player) => playerState(action, player, () => ({ position: null, movedAt: 0, moved: false }));

  function nearestShop(player) {
    const loc = player.getLocation();
    const index = npcClustersFor(world, `shopKeepers:${itemId}`,
      (definition) => (shopByKeeper.has(definition?.getId?.()) ? "keeper" : null));
    return nearestClusters(index, ["keeper"], { x: loc.getX(), y: loc.getY(), z: loc.getZ() })[0] ?? null;
  }

  function buy(player, shopId) {
    const { ShopManager } = world.core;
    if (!ShopManager.open(player, shopId, true)) return false;
    const missing = amount - Supplies.carriedAmount(player, itemId);
    if (missing > 0) ShopManager.buy(player, itemId, missing);
    ShopManager.close(player);
    return Supplies.carriedAmount(player, itemId) >= amount;
  }

  const action = {
    id: "buyItems",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (Supplies.carriedAmount(player, itemId) >= amount) return "success";
      if (shopByKeeper.size === 0) return "failed";
      const bot = stateFor(player);
      const loc = player.getLocation();
      const position = `${loc.getX()},${loc.getY()},${loc.getZ()}`;
      if (position !== bot.position) {
        bot.position = position;
        bot.movedAt = nowMs;
        bot.moved = true;
      } else if (nowMs - bot.movedAt > STUCK_MS) {
        return "failed";
      }
      const keeper = world.core.World.getNpcsNear(loc, 16, player.getPrivateArea?.() ?? null)
        .find((npc) => keeperShop(npc) !== undefined && npc.isRegistered?.() !== false);
      const at = keeper?.getLocation();
      if (at && Math.max(Math.abs(at.getX() - loc.getX()), Math.abs(at.getY() - loc.getY())) <= TRADE_RANGE) {
        return buy(player, keeperShop(keeper)) ? "success" : "failed";
      }
      if (player.getMovementQueue().size() > 0 || peekMovementRequest(player)) return "running";
      const shop = at ? { x: at.getX(), y: at.getY(), z: at.getZ() } : nearestShop(player);
      if (!shop) return "failed";
      requestMovement(player, shop.x, shop.y, { nowMs, z: shop.z, reason: "brain_buy_walk", basicPather: true });
      return "running";
    },
    stop(ctx) {
      stateFor(ctx.player).position = null;
    },
    madeProgress(ctx) {
      const bot = stateFor(ctx.player);
      const moved = bot.moved;
      bot.moved = false;
      return moved;
    },
    describe() {
      return `buy ${amount} x ${itemId}`;
    },
  };
  return action;
}

module.exports = { createBuyItemsAction };
