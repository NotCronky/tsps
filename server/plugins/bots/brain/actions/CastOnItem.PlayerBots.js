"use strict";

const { PluginManager } = require("../../../../src/main/typescript/elvarg/plugins/PluginManager");
const { playerState } = require("../ActionState.PlayerBots");

/**
 * Casts a spell on inventory items, one after another, as a player clicks the spell then the
 * item: through the spell-on-item hooks the spell plugins answer (superheat, enchanting), else
 * the core's alchemy. The spell's own code takes the runes, checks the level and gives the XP.
 * Completes when none of `items` is left; fails when casts stop doing anything (no runes left,
 * a level it lacks).
 *
 * JSON: { "type": "castOnItem", "spell": "High Level Alchemy", "items": [itemId, ...] }
 */
const CAST_MS = 1800;
// Casts in a row that change nothing: it can't cast it.
const FAILED_CASTS = 4;

function createCastOnItemAction(spec, world) {
  const { core } = world;
  const spell = String(spec.spell);
  const alchemy = /alchemy/i.test(spell);
  const targets = new Set(spec.items ?? []);
  const stateFor = (player) => playerState(action, player, () => ({ castAt: null, held: null, failures: 0 }));
  const heldOf = (player) => player.getInventory().getItems().reduce((sum, item) => sum + (targets.has(item?.getId?.()) ? item.getAmount() : 0), 0);

  function cast(player) {
    const slot = player.getInventory().getItems().findIndex((item) => targets.has(item?.getId?.()));
    if (slot < 0) return;
    const itemId = player.getInventory().getItems()[slot].getId();
    if (alchemy) {
      core.castAlchemy(player, spell.toLowerCase(), itemId, slot);
      return;
    }
    PluginManager.emitSpellOnItem({ player, spellName: spell, spellWidget: -1, spellItemId: -1, itemId, slot, handled: false });
  }

  const action = {
    id: "castOnItem",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      const held = heldOf(player);
      if (held <= 0) return "success";
      if (bot.castAt !== null && nowMs - bot.castAt < CAST_MS) return "running";
      if (bot.held !== null && held >= bot.held && ++bot.failures > FAILED_CASTS) return "failed";
      if (held < (bot.held ?? Infinity)) bot.failures = 0;
      bot.held = held;
      bot.castAt = nowMs;
      cast(player);
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.castAt = null;
      bot.held = null;
      bot.failures = 0;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).failures === 0;
    },
    describe() {
      return `casting ${spell}`;
    },
  };
  return action;
}

module.exports = { createCastOnItemAction };
