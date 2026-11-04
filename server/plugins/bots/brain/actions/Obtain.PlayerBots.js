"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { createBankAction } = require("./Bank.PlayerBots");
const { createBuyItemsAction } = require("./BuyItems.PlayerBots");
const Supplies = require("../../lib/Supplies.PlayerBots");

// Coins taken out for a purchase: the estimate with room for shop markup, plus a little.
const COIN_MARGIN = 3;
const COIN_SPARE = 200;

/**
 * Gets `items` ([{ item, amount }]) into the inventory the way a player would: what is carried
 * already counts, the rest comes out of the bank, and what isn't owned at all is bought with the
 * character's own coins (taken out of the bank first if need be). Fails when an item is neither
 * owned nor sold anywhere, or the coins run short; the task then picks something else.
 */
function createObtainAction(spec, world) {
  const items = (spec.items ?? []).filter((entry) => Number.isInteger(entry?.item))
    .map((entry) => ({ item: entry.item, amount: Math.max(1, Math.floor(Number(entry.amount ?? 1))) }));
  const stateFor = (player) => playerState(action, player, () => ({ step: null, stepKey: null }));

  function missing(player) {
    return items
      .map((entry) => ({ ...entry, need: entry.amount - Supplies.carriedAmount(player, entry.item) }))
      .filter((entry) => entry.need > 0);
  }

  /** The next step towards having everything, or null when there is nothing left to try. */
  function planStep(player, wanted) {
    const banked = wanted
      .map((entry) => ({ item: entry.item, amount: Math.min(entry.need, Supplies.bankedAmount(player, entry.item)) }))
      .filter((entry) => entry.amount > 0);
    if (banked.length > 0) {
      return { key: `withdraw:${banked.map((entry) => entry.item).join(",")}`, action: createBankAction({ withdraw: banked }, world) };
    }
    const toBuy = wanted.find((entry) => Supplies.canBuy(entry.item));
    if (!toBuy) return null;
    const cost = Supplies.priceEstimate(toBuy.item) * toBuy.need * COIN_MARGIN + COIN_SPARE;
    const carriedCoins = Supplies.carriedAmount(player, Supplies.COINS);
    const bankedCoins = Supplies.bankedAmount(player, Supplies.COINS);
    if (carriedCoins < cost && bankedCoins > 0) {
      const take = Math.min(bankedCoins, cost - carriedCoins);
      return { key: `coins:${take}`, action: createBankAction({ withdraw: [{ item: Supplies.COINS, amount: carriedCoins + take }] }, world) };
    }
    if (carriedCoins <= 0) return null;
    return { key: `buy:${toBuy.item}`, action: createBuyItemsAction({ item: toBuy.item, amount: toBuy.need }, world) };
  }

  const action = {
    id: "obtain",
    update(ctx) {
      const { player } = ctx;
      const bot = stateFor(player);
      const wanted = missing(player);
      if (wanted.length === 0) {
        bot.step = null;
        return "success";
      }
      if (!bot.step) {
        const step = planStep(player, wanted);
        if (!step) return "failed";
        bot.step = step.action;
        bot.stepKey = step.key;
      }
      const result = bot.step.update(ctx);
      if (result === "success" || result === "failed") {
        bot.step.stop?.(ctx);
        bot.step = null;
        // A failed step is final: the same plan would fail again.
        return result === "failed" ? "failed" : "running";
      }
      if (result === "wait") ctx.waitTicks = ctx.waitTicks ?? 1;
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.step?.stop?.(ctx);
      bot.step = null;
    },
    madeProgress(ctx) {
      const bot = stateFor(ctx.player);
      if (typeof bot.step?.madeProgress === "function") return bot.step.madeProgress(ctx);
      // A step that doesn't say (a bank trip): walking towards it is progress.
      const loc = ctx.player.getLocation();
      const position = `${loc.getX()},${loc.getY()},${loc.getZ()}`;
      const moved = bot.position !== undefined && bot.position !== position;
      bot.position = position;
      return moved;
    },
    describe(ctx) {
      return `obtain ${items.map((entry) => `${entry.amount}x${entry.item}`).join(",")}${stateFor(ctx.player).stepKey ? ` (${stateFor(ctx.player).stepKey})` : ""}`;
    },
  };
  return action;
}

module.exports = { createObtainAction };
