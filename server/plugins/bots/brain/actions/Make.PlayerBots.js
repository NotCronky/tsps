"use strict";

const { playerState } = require("../ActionState.PlayerBots");

/**
 * Makes something from what the character carries the way a player does: uses one item on the
 * other (knife on logs, string on a bow, herb on a vial, chisel on a gem) through the normal
 * item-on-item code, and picks `output` in the make menu that opens, "All". The skill plugin
 * then does the work, its own checks, timing and XP included. Completes when the inventory no
 * longer holds both items (the activity banks and goes again).
 *
 * JSON: { "type": "make", "use": itemId, "on": itemId, "output": itemId }
 * `use` is the tool or first material, `on` the material it's used on.
 */
// The make menu's "All".
const MAKE_ALL = 28;
// Nothing used up for this long while the items are still there: use them again (a level-up,
// a batch of sets finished, a menu that didn't open).
const IDLE_MS = 6000;
// Uses in a row that change nothing: the character can't make it (a level, a quest, a tool).
const FAILED_USES = 3;

function createMakeAction(spec, world) {
  const { core } = world;
  const { use, on, output } = spec;
  const stateFor = (player) => playerState(action, player, () => ({ usedAt: 0, failures: 0, count: null }));

  const slotOf = (player, id, skip = -1) => player.getInventory().getItems()
    .findIndex((item, slot) => slot !== skip && item?.getId?.() === id);

  /** What it holds of the inputs: any change means the work is going on. */
  const countOf = (player) => `${player.getInventory().getAmount(use)}:${player.getInventory().getAmount(on)}`;

  function answerMenu(player) {
    const menu = player.getCreationMenu?.();
    if (!menu) return;
    const items = menu.getItems?.() ?? [];
    const pick = items.includes(output) ? output : items[0];
    player.getPacketSender().closeCreationMenu?.();
    if (pick !== undefined) menu.execute(pick, MAKE_ALL);
  }

  const action = {
    id: "make",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      const useSlot = slotOf(player, use);
      const onSlot = use === on ? slotOf(player, on, useSlot) : slotOf(player, on);
      if (useSlot < 0 || onSlot < 0) return "success";
      const count = countOf(player);
      if (bot.count !== null && count !== bot.count) {
        bot.count = count;
        bot.failures = 0;
        bot.usedAt = nowMs;
        return "running";
      }
      bot.count = count;
      if (bot.usedAt > 0 && nowMs - bot.usedAt < IDLE_MS) return "running";
      if (bot.usedAt > 0 && ++bot.failures > FAILED_USES) return "failed";
      bot.usedAt = nowMs;
      core.UseItemPacketListener.itemOnItem(player, useSlot, onSlot);
      answerMenu(player);
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.usedAt = 0;
      bot.failures = 0;
      bot.count = null;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).failures === 0;
    },
    describe() {
      return `make ${output} (${use} on ${on})`;
    },
  };
  return action;
}

module.exports = { createMakeAction };
