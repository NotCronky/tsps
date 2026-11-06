"use strict";

const { playerState } = require("../ActionState.PlayerBots");

/**
 * Clicks an inventory item's first option, one item after another, as a player buries bones or
 * cleans herbs: through the normal item action code, so the plugin's delays, levels and XP apply.
 * Completes when none of `items` is left (the activity banks and goes again).
 *
 * JSON: { "type": "clickItem", "items": [itemId, ...] }
 */
const CLICK_MS = 1200;
// Clicks in a row that use nothing up: it can't (a level it lacks).
const FAILED_CLICKS = 4;

function createClickItemAction(spec, world) {
  const { core } = world;
  const ids = new Set(spec.items ?? []);
  const stateFor = (player) => playerState(action, player, () => ({ clickedAt: null, failures: 0, held: null }));
  const heldOf = (player) => player.getInventory().getItems().reduce((sum, item) => sum + (ids.has(item?.getId?.()) ? item.getAmount() : 0), 0);

  const action = {
    id: "clickItem",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      const slot = player.getInventory().getItems().findIndex((item) => ids.has(item?.getId?.()));
      if (slot < 0) return "success";
      if (bot.clickedAt !== null && nowMs - bot.clickedAt < CLICK_MS) return "running";
      const held = heldOf(player);
      if (bot.held !== null && held >= bot.held && ++bot.failures > FAILED_CLICKS) return "failed";
      if (held < (bot.held ?? Infinity)) bot.failures = 0;
      bot.held = held;
      bot.clickedAt = nowMs;
      const itemId = player.getInventory().getItems()[slot].getId();
      core.ItemActionPacketListener.handleAction(player, core.Inventory.INTERFACE_ID, itemId, slot, 1);
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.clickedAt = null;
      bot.failures = 0;
      bot.held = null;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).failures === 0;
    },
    describe() {
      return `click ${[...ids].join(",")}`;
    },
  };
  return action;
}

module.exports = { createClickItemAction };
