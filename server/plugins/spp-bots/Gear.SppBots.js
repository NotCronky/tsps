"use strict";

/**
 * What a simulated account owns (data/gear.json): the best of each slot it qualifies for, tools
 * for its gathering levels, food it could have caught and cooked, and the gp left over. A main
 * buys what it can afford; an ironman only has what it could make or get as a drop, or buy in a
 * shop. Pure: Accounts.SppBots.js turns the plan into items.
 */

const { SKILL_INDEX } = require("./Simulator.SppBots");

/** Slots in the order a player saves up for them (a style's list may skip some: no shield with a bow). */
const BUY_ORDER = ["WEAPON_SLOT", "BODY_SLOT", "LEG_SLOT", "HEAD_SLOT", "SHIELD_SLOT", "FEET_SLOT", "HANDS_SLOT", "AMULET_SLOT", "CAPE_SLOT"];
const STYLES = ["melee", "ranged", "magic"];
/** A style the account trained this far gets a set of its own (in the bank, unless it's the main one). */
const STYLE_LEVEL = 20;
/** A main keeps this share of its gp back rather than spending everything on gear. */
const KEEP_SHARE = 0.3;

function levelOf(levels, skill) {
  return levels[SKILL_INDEX.get(skill)] ?? 1;
}

function meetsLevels(levels, required = {}) {
  return Object.entries(required).every(([skill, level]) => levelOf(levels, skill) >= level);
}

/** Wield requirements, members, quests and rewards that can't be bought: true for anyone who'd own it. */
function canHave(entry, account) {
  if (entry.members && !account.members) return false;
  if (!meetsLevels(account.levels, entry.levels)) return false;
  if (entry.quest && !account.questNames.has(entry.quest)) return false;
  const obtain = entry.obtain;
  if (obtain) {
    if (!meetsLevels(account.levels, obtain.levels)) return false;
    if ((obtain.combat ?? 0) > account.combatLevel) return false;
    const attackPlusStrength = levelOf(account.levels, "attack") + levelOf(account.levels, "strength");
    if ((obtain.attackPlusStrength ?? 0) > attackPlusStrength) return false;
  }
  if (account.ironman && entry.iron) {
    if (!meetsLevels(account.levels, entry.iron.levels)) return false;
    if ((entry.iron.combat ?? 0) > account.combatLevel) return false;
  }
  return true;
}

/** The first entry of `list` the account can have and afford; spends its cost. */
function choose(list, account, budget) {
  for (const entry of list ?? []) {
    if (!canHave(entry, account)) continue;
    const cost = account.ironman && entry.iron ? 0 : entry.cost ?? 0;
    if (cost > budget.gp) continue;
    budget.gp -= cost;
    return entry;
  }
  return null;
}

/** The style an account fights with most: its highest of attack/strength, ranged and magic. */
function mainStyle(account) {
  const melee = Math.max(levelOf(account.levels, "attack"), levelOf(account.levels, "strength"));
  const ranged = levelOf(account.levels, "ranged");
  const magic = levelOf(account.levels, "magic");
  if (ranged > melee && ranged >= magic) return "ranged";
  if (magic > melee && magic > ranged) return "magic";
  return "melee";
}

function styleLevel(account, style) {
  if (style === "melee") return Math.max(levelOf(account.levels, "attack"), levelOf(account.levels, "strength"));
  return levelOf(account.levels, style);
}

function amountOf([min, max], random) {
  return Math.floor(min + random() * (max - min));
}

// The fewest of a stack worth having (arrows, runes, potions) when money is short.
const MIN_STACK = 50;

/** As many as `wanted` that `budget` pays for at `each`, or 0 below MIN_STACK (or `wanted`). */
function affordable(wanted, each, budget) {
  if (!each) return wanted;
  const amount = Math.min(wanted, Math.floor(budget.gp / each));
  return amount >= Math.min(wanted, MIN_STACK) ? amount : 0;
}

/** A stack (arrows, runes, potions) the account can have, as many as it can pay for; or null. */
function chooseStack(list, account, budget, random, fits = () => true) {
  for (const entry of list ?? []) {
    if (!fits(entry) || !canHave(entry, account)) continue;
    const each = account.ironman && entry.iron ? 0 : entry.cost ?? 0;
    const amount = affordable(amountOf(entry.amount ?? [1, 1], random), each, budget);
    if (amount <= 0) continue;
    budget.gp -= amount * each;
    return [entry.item, amount];
  }
  return null;
}

/**
 * One style's set: { items: { slot: key }, ammo: [key, amount] | null, runes: [[key, amount]] }.
 * Ranged takes arrows for its bow's tier or bolts for its crossbow; magic takes runes for the best
 * spell of its staff's element.
 */
function planStyle(gear, style, account, budget, random) {
  const slots = gear[style] ?? {};
  const items = {};
  let weapon = null;
  for (const slot of BUY_ORDER) {
    const entry = choose(slots[slot], account, budget);
    if (!entry) continue;
    items[slot] = entry.item;
    if (slot === "WEAPON_SLOT") weapon = entry;
  }
  let ammo = null;
  const runes = [];
  if (style === "ranged" && weapon) {
    ammo = weapon.ammo
      ? chooseStack(gear.bolts?.[weapon.ammo], account, budget, random)
      : chooseStack(gear.arrows, account, budget, random, (arrow) => (arrow.tier ?? 0) <= (weapon.arrowTier ?? 0));
  }
  if (style === "magic" && weapon?.element) {
    const spell = (gear.spells?.[weapon.element] ?? []).find((entry) => canHave(entry, account));
    if (spell) {
      // As many casts as it can pay for (all of the spell's runes, or none).
      const perCastCost = Object.entries(spell.runes).reduce((sum, [rune, perCast]) => sum + perCast * (gear.spells.runeCosts?.[rune] ?? 0), 0);
      const casts = affordable(amountOf(gear.spells.casts ?? [300, 1500], random), perCastCost, budget);
      budget.gp -= casts * perCastCost;
      if (casts > 0) for (const [rune, perCast] of Object.entries(spell.runes)) runes.push([rune, casts * perCast]);
    }
  }
  return { items, ammo, runes };
}

/**
 * `account`: { levels (by Simulator.SKILLS index), combatLevel, quests (names), gp, ironman,
 * archetype, stage, members }. `random` comes from the account's seed.
 */
function planGear(gear, account, random = Math.random) {
  const context = { ...account, questNames: new Set(account.questNames ?? []) };
  const total = Math.max(0, Math.floor(account.gp ?? 0));
  const budget = { gp: Math.floor(total * (1 - KEEP_SHARE)) };
  const equipment = {};
  const bank = [];

  // A new account (a few hours old) still has its starter kit and hasn't bought anything yet.
  if (account.stage === "new") {
    return { equipment, bank, coins: total, starterKit: true };
  }

  // A fighter wears its main style's set; the others it trained wait in the bank (bought last).
  const main = account.archetype === "skiller" ? null : mainStyle(context);
  const keep = (set) => {
    for (const item of Object.values(set.items)) bank.push([item, 1]);
    if (set.ammo) bank.push(set.ammo);
    bank.push(...set.runes);
  };
  if (main) {
    const set = planStyle(gear, main, context, budget, random);
    Object.assign(equipment, set.items);
    if (set.ammo) equipment.AMMUNITION_SLOT = set.ammo;
    bank.push(...set.runes);
  }

  // Tools go in the bank: an activity withdraws the one it needs, as a player does.
  for (const kind of ["axe", "pickaxe"]) {
    const entry = choose(gear.tools[kind], context, budget);
    if (entry) bank.push([entry.item, 1]);
  }
  for (const entry of gear.tools.fishing) {
    if (!canHave(entry, context) || (entry.cost ?? 0) > budget.gp) continue;
    budget.gp -= entry.cost ?? 0;
    bank.push([entry.item, 1]);
    for (const [item, amount] of Object.entries(entry.with ?? {})) bank.push([item, amount]);
  }

  const food = gear.food.find((entry) => canHave(entry, context));
  if (food && account.stage !== "new") {
    const [min, max] = food.amount;
    const amount = Math.floor(min + random() * (max - min));
    // A main may have bought it; an ironman caught and cooked it.
    if (account.ironman || amount * (food.cost ?? 0) <= budget.gp) {
      if (!account.ironman) budget.gp -= amount * (food.cost ?? 0);
      bank.push([food.item, amount]);
    }
  }

  // A special attack weapon for the main style (Tactics.SppBots.js switches to it in a fight).
  if (main) {
    const special = choose((gear.specials?.[main] ?? []).filter((entry) => entry.item !== equipment.WEAPON_SLOT), context, budget);
    if (special) bank.push([special.item, 1]);
  }

  // The combat kit (Supplies.SppBots.js): karambwans and potions for the levels that use them.
  if (main) {
    for (const entry of gear.supplies ?? []) {
      if (random() > (entry.chance ?? 1)) continue;
      const stack = chooseStack([entry], context, budget, random);
      if (stack) bank.push(stack);
    }
    for (const style of STYLES) {
      if (style === main || styleLevel(context, style) < STYLE_LEVEL) continue;
      keep(planStyle(gear, style, context, budget, random));
    }
  }

  // A travel kit: runes, tablets and jewellery the bot teleports with (Teleports.SppBots.js).
  for (const entry of gear.travel ?? []) {
    if (!entry.item || !canHave(entry, context) || random() > (entry.chance ?? 1)) continue;
    const [min, max] = entry.amount;
    const amount = Math.floor(min + random() * (max - min));
    const cost = account.ironman ? 0 : amount * (entry.cost ?? 0);
    if (cost > budget.gp) continue;
    budget.gp -= cost;
    bank.push([entry.item, amount]);
  }

  const spent = Math.floor(total * (1 - KEEP_SHARE)) - budget.gp;
  return { equipment, bank, coins: Math.max(0, total - spent), starterKit: false };
}

module.exports = { planGear, canHave, mainStyle };
