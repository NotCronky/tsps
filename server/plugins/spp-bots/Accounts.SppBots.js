"use strict";

/**
 * Writes a simulated account onto a bot through the game's own APIs (docs/playerbots.md, Phase 2):
 * ironman mode by its event, quests by QuestRuntime's complete() (quest points, the quest's own
 * rewards, quest:completed), skills, then items. Runs once, on the bot's first login.
 */

const path = require("path");
const { simulate, rollProfile, SKILLS, levelForXp, createRandom } = require("./Simulator.SppBots");
const { planGear } = require("./Gear.SppBots");
const { questList, registeredQuest } = require("./Quests.SppBots");
const { isMembersWorld } = require("./Imports.SppBots");

const accounts = require(path.join(__dirname, "data", "accounts.json"));
const training = require(path.join(__dirname, "data", "training.json"));
const gear = require(path.join(__dirname, "data", "gear.json"));

/** Skill levels and xp exactly as simulated: run after quests so their reward xp isn't counted twice. */
function applySkills(player, Skill, xp) {
  const skills = player.getSkillManager();
  SKILLS.forEach((name, index) => {
    const skill = Skill[name.toUpperCase()];
    if (!skill) return;
    const level = levelForXp(xp[index]);
    skills.setCurrentLevel(skill, level, false).setMaxLevels(skill, level, false).setExperiences(skill, xp[index], false);
  });
}

function itemId(ItemIds, key) {
  const id = ItemIds[key];
  if (!Number.isInteger(id)) throw new Error(`[spp-bots] unknown item ${key} in data/gear.json`);
  return id;
}

function applyItems(api, player, plan) {
  const { Item, Equipment, ItemIds, Bank } = api.core;
  // Quest rewards (lamps, books, gems, coins) land in the inventory; this player banked them long ago.
  Bank.depositItems(player, player.getInventory(), true);
  if (plan.starterKit) {
    const inventory = player.getInventory();
    for (const [key, amount] of gear.starterKit.items) inventory.adds(itemId(ItemIds, key), amount);
  }
  const equipment = player.getEquipment();
  for (const [slot, value] of Object.entries(plan.equipment)) {
    // A stack (arrows, bolts) is [key, amount].
    const [key, amount] = Array.isArray(value) ? value : [value, 1];
    equipment.set(Equipment[slot], new Item(itemId(ItemIds, key), amount));
  }
  equipment.refreshItems();
  const bank = player.getBank(0);
  const coins = plan.coins + (plan.starterKit ? gear.starterKit.coins : 0);
  if (coins > 0) bank.adds(ItemIds.COINS, coins);
  for (const [key, amount] of plan.bank) bank.adds(itemId(ItemIds, key), amount);
  api.getBonusManager().update(player);
  api.core.WeaponInterfaceManager?.assign?.(player);
}

/** A new roster entry's profile: who this account is. Nothing is simulated until first login. */
function newProfile(seed, overrides = {}) {
  return rollProfile(accounts, seed, overrides);
}

/**
 * Simulates `profile` and writes it to `player`. Returns a summary for the roster. `log` reports
 * quests whose completion threw (their reward code), which are skipped rather than stopping the bot.
 */
function generateAccount(api, player, profile, log = () => {}) {
  const { Skill, CacheDefinitions, Flag } = api.core;
  const members = isMembersWorld();
  const result = simulate({ profile, training, accounts, quests: questList(CacheDefinitions), members });

  if (profile.ironman) {
    const request = { player, mode: "ironman" };
    api.emitCustomEvent("ironman:set-mode", request);
    if (!request.handled) log("spp_bots_ironman_unavailable", { name: player.getUsername() });
  }

  applySkills(player, Skill, result.xp);
  const completed = [];
  for (const key of result.quests) {
    const quest = registeredQuest(key);
    if (!quest) continue;
    try {
      quest.complete(player, { scroll: false, announce: false });
      completed.push(quest.name);
    } catch (error) {
      log("spp_bots_quest_failed", { name: player.getUsername(), quest: key, error: String(error?.message ?? error) });
    }
  }
  applySkills(player, Skill, result.xp);

  const plan = planGear(gear, {
    levels: result.levels,
    combatLevel: result.combatLevel,
    questNames: completed,
    gp: result.gp,
    ironman: profile.ironman,
    archetype: profile.archetype,
    stage: profile.stage,
    members,
  }, createRandom(profile.seed ^ 0x27d4eb2d));
  applyItems(api, player, plan);

  for (const skill of Skill.values()) player.getSkillManager().updateSkill(skill);
  player.getUpdateFlag().flag(Flag.APPEARANCE);
  return {
    combatLevel: result.combatLevel,
    totalLevel: result.totalLevel,
    quests: completed.length,
    questPoints: result.questPoints,
    hours: result.hours,
    coins: plan.coins,
    travelKit: TRAVEL_KIT_VERSION,
  };
}

/**
 * For a bot generated before accounts had (this version of) a travel kit: the travel items newer
 * than `since` (gear.json "travel", by `kit`) its account plans to, put in its bank once. The
 * simulation is seeded, so it's the same account.
 */
/** The newest travel kit version in gear.json (entries' `kit`, default 1). */
// The newest `kit` anywhere in gear.json: bots generated before it get what's newer at login.
const SPELLS_KIT = 5;
const TRAVEL_KIT_VERSION = Math.max(1, SPELLS_KIT, ...JSON.stringify(gear).match(/"kit":\s*\d+/g).map((text) => Number(text.split(":")[1])));

function grantTravelKit(api, player, profile, since = 0, { skipOwned = false } = {}) {
  const { CacheDefinitions, ItemIds } = api.core;
  const members = isMembersWorld();
  const result = simulate({ profile, training, accounts, quests: questList(CacheDefinitions), members });
  const plan = planGear(gear, {
    levels: result.levels,
    combatLevel: result.combatLevel,
    questNames: result.quests.map((key) => registeredQuest(key)?.name).filter(Boolean),
    gp: result.gp,
    ironman: profile.ironman,
    archetype: profile.archetype,
    stage: profile.stage,
    members,
  }, createRandom(profile.seed ^ 0x27d4eb2d));
  // Every entry newer than the bot's kit (travel, styles, ammo, supplies; a spell's runes count with
  // its spells), from the bank plan and, for a set it would now wear, from the equipment plan.
  const newer = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    if (typeof value.item === "string" && (value.kit ?? 1) > since) newer.add(value.item);
    if (value.runes && since < SPELLS_KIT) Object.keys(value.runes).forEach((rune) => newer.add(rune));
    Object.values(value).forEach(walk);
  };
  walk(gear);
  const worn = Object.values(plan.equipment).map((value) => (Array.isArray(value) ? value : [value, 1]));
  let kit = [...plan.bank, ...worn].filter(([key]) => newer.has(key));
  if (skipOwned) {
    // A re-grant: nothing the bot already has (in any bank tab, its pack or worn).
    const have = new Set();
    const note = (item) => item && item.getId?.() > 0 && have.add(item.getId());
    for (let tab = 0; tab < (api.core.Bank.TOTAL_BANK_TABS ?? 1); tab++) for (const item of player.getBank(tab)?.getItems?.() ?? []) note(item);
    for (const item of player.getInventory().getItems()) note(item);
    for (const item of player.getEquipment().getItems()) note(item);
    kit = kit.filter(([key]) => !have.has(itemId(ItemIds, key)));
  }
  const bank = player.getBank(0);
  for (const [key, amount] of kit) bank.adds(itemId(ItemIds, key), amount);
  return kit;
}

module.exports = { newProfile, generateAccount, grantTravelKit, TRAVEL_KIT_VERSION, accounts };
