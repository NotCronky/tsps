"use strict";

const fs = require("fs");
const path = require("path");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { SkillManager } = require("../../../src/main/typescript/elvarg/game/content/skill/SkillManager");
const { Flag } = require("../../../src/main/typescript/elvarg/game/model/Flag");
const { Item } = require("../../../src/main/typescript/elvarg/game/model/Item");
const { Equipment } = require("../../../src/main/typescript/elvarg/game/model/container/impl/Equipment");
const { ItemIdentifiers } = require("../../../src/main/typescript/elvarg/util/ItemIdentifiers");
const { TOOLS } = require("../brain/actions/EquipTool.PlayerBots");

/**
 * A new bot account starts somewhere along the game, like the people who play it: early, mid
 * or late (data/stages.json). Its levels are rolled for the stage, and it owns what someone at
 * those levels would: the best gear and tools its levels allow, food, and coins in the bank.
 * This happens once, on the account's first login; after that it plays and earns like anyone.
 */
const STAGES_FILE = path.join(__dirname, "..", "data", "stages.json");
const GEAR_FILE = path.join(process.cwd(), "data", "definitions", "bot-combat-gear.json");
const COMBAT_SKILLS = [Skill.ATTACK, Skill.STRENGTH, Skill.DEFENCE, Skill.HITPOINTS, Skill.RANGED, Skill.MAGIC, Skill.PRAYER];
const FISHING_KIT = [[1, "SMALL_FISHING_NET", 1], [5, "FISHING_ROD", 1], [5, "FISHING_BAIT", 500], [16, "BIG_FISHING_NET", 1],
  [20, "FLY_FISHING_ROD", 1], [20, "FEATHER", 500], [35, "HARPOON", 1], [40, "LOBSTER_POT", 1]];

/** Cosmetic clothes for the slots combat gear leaves empty, by outfit tier. */
const OUTFITS = Object.freeze({
  novice: { cape: ["BLUE_CAPE", "RED_CAPE", "GREEN_CAPE", "YELLOW_CAPE", "ORANGE_CAPE", "PURPLE_CAPE"], amulet: ["AMULET_OF_STRENGTH", "AMULET_OF_DEFENCE", "AMULET_OF_MAGIC"] },
  mid: { cape: ["BLACK_CAPE", "BLUE_CAPE", "RED_CAPE", "GREEN_CAPE", "PURPLE_CAPE"], amulet: ["AMULET_OF_STRENGTH", "AMULET_OF_DEFENCE", "AMULET_OF_POWER"] },
  elite: { cape: ["BLACK_CAPE", "GREEN_CAPE", "PURPLE_CAPE", "ORANGE_CAPE"], amulet: ["AMULET_OF_GLORY", "AMULET_OF_POWER"] },
});
const OUTFIT_SLOTS = { cape: Equipment.CAPE_SLOT, amulet: Equipment.AMULET_SLOT };

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const pick = (list, random) => list[Math.floor(random() * list.length)];
const between = ([min, max], random) => Math.round(min + random() * (max - min));

function pickWeighted(weights, random) {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  let roll = random() * entries.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [key, weight] of entries) {
    if ((roll -= weight) < 0) return key;
  }
  return entries.at(-1)[0];
}

/** A new account's stage and what it likes doing: { stage, style, focus }. */
function rollProfile(data = readJson(STAGES_FILE), random = Math.random) {
  return { stage: pickWeighted(data.weights, random), style: pickWeighted(data.profiles, random), focus: pick(data.focuses, random) };
}

function combatLevelOf([attack, strength, defence, hp, ranged, magic, prayer]) {
  return SkillManager.calculateCombatLevel([attack, defence, strength, hp, ranged, prayer, magic]);
}

/**
 * Combat stats (COMBAT_SKILLS order) whose combat level lands in [min, max]: aim at a level in
 * the band, find the even stat level that reaches it, then jitter each a little so no two bots
 * match. Falls back to the even stats if the jitter leaves the band.
 */
function rollCombatStats([min, max], random = Math.random) {
  const clamp = (level, floor = 1) => Math.max(floor, Math.min(99, level));
  const even = (level) => COMBAT_SKILLS.map((skill) => clamp(level, skill === Skill.HITPOINTS ? 10 : 1));
  const target = min + Math.floor(random() * (max - min + 1));
  let base = 1;
  while (base < 99 && combatLevelOf(even(base)) < target) base++;
  for (let attempt = 0; attempt < 20; attempt++) {
    const stats = even(base).map((level, index) =>
      clamp(level + Math.floor(random() * 9) - 4, COMBAT_SKILLS[index] === Skill.HITPOINTS ? 10 : 1));
    const combat = combatLevelOf(stats);
    if (combat >= min && combat <= max) return stats;
  }
  return even(base);
}

/** Every skill's level for the stage; the focus skill a little higher. */
function applyLevels(player, stage, focus, focusBonus, random) {
  const manager = player.getSkillManager();
  const combat = rollCombatStats(stage.combat, random);
  for (const skill of Skill.values()) {
    const name = String(skill.getName?.() ?? "").toLowerCase();
    const combatIndex = COMBAT_SKILLS.indexOf(skill);
    let level = combatIndex >= 0 ? combat[combatIndex] : between(stage.skills, random);
    if (combatIndex < 0 && name === focus) level += focusBonus;
    level = Math.max(skill === Skill.HITPOINTS ? 10 : 1, Math.min(99, level));
    manager.setCurrentLevel(skill, level, false).setMaxLevels(skill, level, false)
      .setExperience(skill, SkillManager.getExperienceForLevel(level));
  }
}

/** Whether the character meets an item's wear requirements. */
function canWear(player, id) {
  const requirements = new Item(id, 1).getDefinition().getRequirements() ?? [];
  const manager = player.getSkillManager();
  return !requirements.some((required, index) => {
    const skill = Skill.values().find((entry) => entry.getIndex() === index);
    return skill && required > manager.getMaxLevel(skill);
  });
}

/** One random item of `names` the character can wear, or null. */
function wearable(player, names, random) {
  const ids = (names ?? []).filter(Boolean).map((name) => ItemIdentifiers[name]).filter(Number.isInteger)
    .filter((id) => canWear(player, id));
  return ids.length ? pick(ids, random) : null;
}

/** Melee gear for its levels: a weapon by Attack, armour by Defence (data/definitions/bot-combat-gear.json). */
function equipCombatGear(player, random) {
  const tiers = readJson(GEAR_FILE).combat_training.gearTiers;
  const manager = player.getSkillManager();
  const tierFor = (skill) => tiers.filter((tier) => manager.getMaxLevel(skill) >= tier.minLevel).pop();
  const equipment = player.getEquipment();
  const weapon = wearable(player, tierFor(Skill.ATTACK)?.weapons, random);
  if (weapon) equipment.set(Equipment.WEAPON_SLOT, new Item(weapon, 1));
  for (const [slotName, names] of Object.entries(tierFor(Skill.DEFENCE)?.armour ?? {})) {
    const slot = Equipment[slotName];
    const id = wearable(player, names, random);
    if (Number.isInteger(slot) && id && !(slot === Equipment.SHIELD_SLOT && weapon && new Item(weapon, 1).getDefinition().isDoubleHanded?.())) {
      equipment.set(slot, new Item(id, 1));
    }
  }
}

function equipOutfit(player, tier, random) {
  const pool = OUTFITS[tier] ?? OUTFITS.novice;
  const equipment = player.getEquipment();
  for (const [key, slot] of Object.entries(OUTFIT_SLOTS)) {
    if ((equipment.getItems()[slot]?.getId?.() ?? -1) > 0) continue;
    const id = ItemIdentifiers[pick(pool[key], random)];
    if (Number.isInteger(id)) equipment.set(slot, new Item(id, 1));
  }
}

/** Tools for its levels, food and coins, in the bank; some food carried. */
function stockBank(player, stage, random) {
  const bank = player.getBank(0);
  const manager = player.getSkillManager();
  const add = (id, amount) => {
    if (Number.isInteger(id) && amount > 0) bank.adds(id, amount);
  };
  for (const tool of Object.keys(TOOLS)) add(TOOLS[tool](player)[0], 1);
  for (const [needed, name, amount] of FISHING_KIT) {
    if (manager.getMaxLevel(Skill.FISHING) >= needed) add(ItemIdentifiers[name], amount);
  }
  add(ItemIdentifiers.TINDERBOX, 1);
  add(ItemIdentifiers.COINS, between(stage.coins, random));
  for (const [name, amount] of stage.bank ?? []) add(ItemIdentifiers[name], amount);
  for (const [name, amount] of stage.carried ?? []) {
    if (Number.isInteger(ItemIdentifiers[name])) player.getInventory().adds(ItemIdentifiers[name], amount);
  }
  const [foodName, carried] = stage.food ?? [];
  const food = ItemIdentifiers[foodName];
  if (Number.isInteger(food)) {
    player.getInventory().adds(food, carried);
    add(food, carried * 3);
  }
}

/** Sets a brand-new account up for its stage (data/stages.json). */
function setUpNewAccount(player, profile, random = Math.random, data = readJson(STAGES_FILE)) {
  const stage = data.stages[profile.stage] ?? data.stages.early;
  applyLevels(player, stage, profile.focus, data.focusBonus ?? 0, random);
  equipCombatGear(player, random);
  equipOutfit(player, stage.outfit, random);
  if (Number.isInteger(ItemIdentifiers[stage.amulet])) player.getEquipment().set(Equipment.AMULET_SLOT, new Item(ItemIdentifiers[stage.amulet], 1));
  stockBank(player, stage, random);
  player.getEquipment().refreshItems();
  player.getInventory().refreshItems();
  player.getUpdateFlag?.()?.flag?.(Flag.APPEARANCE);
}

module.exports = { rollCombatStats, rollProfile, setUpNewAccount, combatLevelOf };
