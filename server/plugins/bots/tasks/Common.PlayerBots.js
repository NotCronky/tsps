"use strict";

const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { ItemIds } = require("../../../src/main/typescript/elvarg/util/IdEnums");
const Supplies = require("../lib/Supplies.PlayerBots");

/**
 * What every task shares. A task is a plain object:
 *   { id, name, group, skill, places, minutes,
 *     check(player, ctx) -> { ok, reason },  what stops the character doing it now
 *     build(player, ctx) -> activity,       a brain activity built from the registry's actions }
 * `ctx` is { registry, world }. A task only reads real state: levels, owned items, coins.
 */
const ok = () => ({ ok: true, reason: null });
const no = (reason) => ({ ok: false, reason });

function skillOf(name) {
  return Skill[String(name).toUpperCase()] ?? null;
}

/** The character's real (unboosted) level in a skill, by name. */
function level(player, name) {
  const skill = skillOf(name);
  return skill ? player.getSkillManager().getMaxLevel(skill) : 0;
}

function itemId(name) {
  if (Number.isInteger(name)) return name;
  return ItemIds[String(name).trim().toUpperCase().replace(/[\s-]+/g, "_")] ?? null;
}

/** Owned, or affordable at a shop that sells it (with a little room for the markup). */
function canGet(player, id) {
  if (!Number.isInteger(id)) return false;
  if (Supplies.ownedAmount(player, id) > 0) return true;
  return Supplies.canBuy(id) && Supplies.coins(player) >= Supplies.priceEstimate(id) * 2;
}

/** The registry activities of one mode the character's level allows, best (highest level) first. */
function activitiesFor(registry, mode, levelNow) {
  return registry.activities
    .filter((activity) => activity.mode === mode && activity.manual !== true && activity.ephemeral !== true)
    .map((activity) => ({ activity, level: registry.levelOf(activity.id) }))
    .filter((entry) => entry.level <= levelNow)
    .sort((a, b) => b.level - a.level);
}

module.exports = { activitiesFor, canGet, itemId, level, no, ok, skillOf };
