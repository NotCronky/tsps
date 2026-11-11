"use strict";

/**
 * Looting by rules (data/loot.json; docs/playerbots.md, Combat). `decide` is pure: an item's facts
 * and the bot's pack against the rules, first match wins. `nextPickup` finds the next ground item
 * the bot can see near a kill that the rules take, and `pickUp` takes it as a client's click does
 * (PickupItemPacketListener: the bot walks to it, the game's own ownership and timers apply).
 */

const path = require("path");

const LOOT = require(path.join(__dirname, "data", "loot.json"));

/**
 * The facts a rule reads about a ground item: { key, name, value (whole stack, gp), kinds: Set,
 * held (the bot carries this item already, so a stack needs no slot) }.
 */
function factsOf(core, player, itemId, amount, keyById) {
  const definition = core.ItemDefinition.forId(itemId);
  const name = String(definition?.getName?.() ?? core.CacheDefinitions.getItem(itemId)?.name ?? "");
  const lower = name.toLowerCase();
  const stackable = definition?.isStackable?.() === true;
  const noted = definition?.isNoted?.() === true;
  const each = Number(definition?.getGrandExchangeValue?.() || definition?.getValue?.() || 0);
  const kinds = new Set();
  if (lower === "coins") kinds.add("coins");
  if (/ rune$/.test(lower)) kinds.add("runes");
  if (/clue scroll/.test(lower)) kinds.add("clue");
  if (stackable) kinds.add("stackable");
  if (noted) kinds.add("noted");
  const ammo = player.getEquipment().getItems()[core.Equipment.AMMUNITION_SLOT];
  if (ammo && ammo.getId?.() === itemId) kinds.add("ammo");
  const held = (stackable || noted) && player.getInventory().getItems().some((item) => item?.getId?.() === itemId);
  return { id: itemId, key: keyById?.get(itemId) ?? null, name, value: each * amount, kinds, held };
}

function matches(match = {}, facts) {
  if (match.items && !match.items.includes(facts.key)) return false;
  if (match.names && !match.names.some((pattern) => new RegExp(pattern, "i").test(facts.name))) return false;
  if (match.kinds && !match.kinds.some((kind) => facts.kinds.has(kind))) return false;
  if (match.minValue !== undefined && facts.value < match.minValue) return false;
  if (match.maxValue !== undefined && facts.value > match.maxValue) return false;
  return true;
}

/**
 * Take it? `facts` from factsOf, `freeSlots` in the pack. `extra` rules (a task's) come first.
 * Returns { take, rule } (rule: the index that decided, or -1 for none).
 */
function decide(facts, freeSlots, extra = [], rules = LOOT.rules) {
  const all = [...extra, ...rules];
  for (let index = 0; index < all.length; index++) {
    const rule = all[index];
    if (!matches(rule.match, facts)) continue;
    if (rule.take && !facts.held && freeSlots < (rule.when?.freeSlots ?? 1)) continue;
    return { take: rule.take === true, rule: index };
  }
  return { take: false, rule: -1 };
}

let keys = null;
/** ItemIds key by id, for rules that name items. */
function keyIndex(core) {
  if (!keys) {
    keys = new Map();
    for (const [key, id] of Object.entries(core.ItemIds ?? {})) if (Number.isInteger(id) && !keys.has(id)) keys.set(id, key);
  }
  return keys;
}

/** The nearest ground item around `at` the bot can see and the rules take, or null. */
function nextPickup(core, player, at, extra = [], skip = new Set()) {
  const radius = LOOT.radius ?? 6;
  const free = player.getInventory().getFreeSlots();
  const here = player.getLocation();
  let best = null;
  for (const ground of core.World.getItems()) {
    const position = ground.getPosition();
    if (position.getZ() !== at.z) continue;
    const distance = Math.max(Math.abs(position.getX() - at.x), Math.abs(position.getY() - at.y));
    if (distance > radius) continue;
    if (!core.ItemOnGroundManager.canSee(player, ground)) continue;
    const item = ground.getItem();
    const key = `${item.getId()}@${position.getX()},${position.getY()}`;
    if (skip.has(key)) continue;
    const facts = factsOf(core, player, item.getId(), item.getAmount(), keyIndex(core));
    if (!decide(facts, free, extra).take) continue;
    const away = Math.max(Math.abs(position.getX() - here.getX()), Math.abs(position.getY() - here.getY()));
    if (!best || away < best.away) best = { ground, key, away, facts };
  }
  return best;
}

/** Take a ground item as the client's Take does. */
function pickUp(core, player, ground) {
  const position = ground.getPosition();
  core.PickupItemPacketListener.pickup(player, ground.getItem().getId(), position.getX(), position.getY());
}

module.exports = { decide, factsOf, nextPickup, pickUp, LOOT };
