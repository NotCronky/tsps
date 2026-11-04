// The standard spellbook's Sailing spells (cache objs 31714 and 31715, params 604 level and
// 365-370 runes): Summon Boat (56, 66 xp) and Teleport to Boat (67, 77 xp), Wiki. Both can only be
// cast after Pandemonium. "Last Boat" is their right-click option (op 2).
const LAW_RUNE = 563;
const EARTH_RUNE = 557;
const WATER_RUNE = 555;

const SPELLS = {
  "summon boat": { level: 56, experience: 66, runes: [[LAW_RUNE, 2], [EARTH_RUNE, 1], [WATER_RUNE, 1]] },
  "teleport to boat": { level: 67, experience: 77, runes: [[LAW_RUNE, 2], [EARTH_RUNE, 2], [WATER_RUNE, 2]] },
};
const LAST_BOAT_OP = 2;
const NEEDS_QUEST = "You need to complete Pandemonium to cast this spell.";

/** The spell named in a spell cast event, if it is one of these. */
function sailingSpell(event) {
  return SPELLS[String(event?.spellName ?? "").trim().toLowerCase()] ?? null;
}

function spellFor(core, data) {
  const spell = new (class extends core.Spell {
    spellId() { return -1; }
    levelRequired() { return data.level; }
    baseExperience() { return data.experience; }
    itemsRequired() { return data.runes.map(([id, amount]) => new core.Item(id, amount)); }
    equipmentRequired() { return []; }
    startCast() {}
    getSpellbook() { return core.MagicSpellbook.NORMAL; }
  })();
  spell.members = true;
  return spell;
}

/** Whether the player may cast it now: Pandemonium done, and the level and runes (not used up). */
function canCast(api, player, data) {
  const request = { player, name: "Pandemonium", complete: false };
  api.emitCustomEvent("quest:is-complete", request);
  if (!request.complete) {
    player.sendMessage(NEEDS_QUEST);
    return false;
  }
  return spellFor(api.core, data).canCast(player, false);
}

/** Uses the runes and gives the experience; false (with the refusal sent) when they're gone. */
function payFor(api, player, data) {
  const spell = spellFor(api.core, data);
  if (!spell.canCast(player, false) || !spell.canCast(player, true)) return false;
  player.getSkillManager().addExperiences(api.core.Skill.MAGIC, data.experience);
  return true;
}

module.exports = { SPELLS, LAST_BOAT_OP, NEEDS_QUEST, sailingSpell, canCast, payFor };
