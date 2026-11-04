"use strict";

const { Skill } = require("../../../../src/main/typescript/elvarg/game/model/Skill");
const Woodcutting = require("../../../skills/Woodcutting.plugin");
const Mining = require("../../../skills/Mining.plugin");
const Supplies = require("../../lib/Supplies.PlayerBots");
const { createObtainAction } = require("./Obtain.PlayerBots");
const { playerState } = require("../ActionState.PlayerBots");

// Coins a purchase may use up, at most: a bot keeps some back rather than spend its last coin.
const SPEND_SHARE = 0.5;

/** The tools a skill can use at the character's level, best first. */
const TOOLS = {
  axe(player) {
    const level = player.getSkillManager().getCurrentLevel(Skill.WOODCUTTING);
    return [...Woodcutting.AXES].reverse().filter((axe) => axe.standard && level >= axe.requiredLevel).map((axe) => axe.id);
  },
  pickaxe(player) {
    const level = player.getSkillManager().getCurrentLevel(Skill.MINING);
    return (Mining.PICKAXES_DESC ?? []).filter((entry) => level >= entry.requiredLevel).map((entry) => entry.id);
  },
};

/**
 * Has the skill's tool on hand: the best one the character owns (carried, or taken out of the
 * bank), or else the best one it can afford, bought at a shop. The skill plugins use a tool
 * from the inventory as well as worn, so it isn't wielded (axes need Attack to wield).
 */
function createEquipToolAction(spec, world) {
  const usable = TOOLS[spec.tool];
  if (!usable) {
    throw new Error(`[bot activities] unknown tool '${spec.tool}'`);
  }
  const stateFor = (player) => playerState(action, player, () => ({ toolId: null, obtain: null }));

  /** The tool to use: owned first, else the best affordable one a shop sells. */
  function choose(player) {
    const ids = usable(player);
    const owned = Supplies.bestOwned(player, ids);
    if (owned) return owned.id;
    const budget = Supplies.coins(player) * SPEND_SHARE;
    return ids.find((id) => Supplies.canBuy(id) && Supplies.priceEstimate(id) <= budget) ?? null;
  }

  const action = {
    id: "equipTool",
    update(ctx) {
      const { player } = ctx;
      const bot = stateFor(player);
      if (!bot.obtain) {
        const toolId = choose(player);
        if (!toolId) return "failed";
        if (Supplies.carriedAmount(player, toolId) > 0) return "success";
        bot.toolId = toolId;
        bot.obtain = createObtainAction({ items: [{ item: toolId, amount: 1 }] }, world);
      }
      const result = bot.obtain.update(ctx);
      if (result === "success" || result === "failed") {
        bot.obtain.stop?.(ctx);
        bot.obtain = null;
      }
      return result;
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.obtain?.stop?.(ctx);
      bot.obtain = null;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).obtain?.madeProgress?.(ctx) ?? false;
    },
  };
  return action;
}

/** Whether the character owns a usable `tool` ("axe", "pickaxe") or can afford one at a shop. */
function canGetTool(tool, player) {
  const ids = TOOLS[tool]?.(player) ?? [];
  if (Supplies.bestOwned(player, ids)) return true;
  const budget = Supplies.coins(player) * SPEND_SHARE;
  return ids.some((id) => Supplies.canBuy(id) && Supplies.priceEstimate(id) <= budget);
}

module.exports = {
  TOOLS,
  canGetTool,
  createEquipToolAction,
};
