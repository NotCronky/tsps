"use strict";

/**
 * A bot's supplies in a fight, used as a player uses them (docs/playerbots.md, Combat): every
 * action is the item's own inventory option or the prayer book's button, so the game's timers,
 * level checks and effects apply.
 *
 * - Eating: the main food, then a cooked karambwan on the same tick when it's low (a combo eat:
 *   karambwan has its own timer); Saradomin brews heal too, and a super restore follows brews.
 * - Prayer: protection from the attacker's style, the best offensive prayer for the bot's own style
 *   it has the level (and unlock) for; a prayer potion or super restore when points run low; all
 *   off when the fight is over.
 * - Run energy: a stamina, super energy or energy potion when it's low.
 *
 * `supplyTick` runs every tick of a fight; the thresholds are drawn per fight, so bots differ.
 */

const INVENTORY_INTERFACE = 3214;
const PRAYER_INTERFACE = 541;

const lower = (value) => String(value ?? "").toLowerCase();

// Item kinds by name (the cache's), with the option that uses them.
const KINDS = [
  { kind: "karambwan", option: "eat", test: (name) => name === "cooked karambwan" },
  { kind: "brew", option: "drink", test: (name) => /^saradomin brew\(\d\)$/.test(name) },
  { kind: "superRestore", option: "drink", test: (name) => /^super restore\(\d\)$/.test(name) },
  { kind: "prayerPotion", option: "drink", test: (name) => /^prayer potion\(\d\)$/.test(name) },
  { kind: "stamina", option: "drink", test: (name) => /^stamina potion\(\d\)$/.test(name) },
  { kind: "energy", option: "drink", test: (name) => /^(super energy|energy potion)\(\d\)$/.test(name) },
  // Boosts by the style they're for, divine ones too; the forgotten and ancient brews are magic's
  // (Cronky's forgotten brews were never drunk: only the plain potions were known).
  { kind: "boost:melee", option: "drink", test: (name) => /^(divine )?super combat potion\(\d\)$/.test(name) },
  { kind: "boost:ranged", option: "drink", test: (name) => /^(divine )?(ranging|bastion) potion\(\d\)$/.test(name) },
  { kind: "boost:magic", option: "drink", test: (name) => /^(divine )?(magic|battlemage) potion\(\d\)$|^(forgotten|ancient) brew\(\d\)$/.test(name) },
  { kind: "antivenom", option: "drink", test: (name) => /^(extended anti-venom\+|anti-venom\+?|antidote\+\+)\(\d\)$/.test(name) },
  { kind: "antipoison", option: "drink", test: (name) => /^(superantipoison|antipoison|antidote\+)\(\d\)$/.test(name) },
];

// Offensive prayers, best first: [prayer id, Prayer level]. Ids as PrayerHandler's.
const OFFENSIVE = {
  melee: [[[26], 70], [[25], 60], [[14, 15], 34], [[6, 7], 16], [[1, 2], 7]],
  ranged: [[[27], 74], [[19], 44], [[11], 26], [[3], 8]],
  magic: [[[28], 77], [[20], 45], [[12], 27], [[4], 9]],
};
const PROTECT = { melee: [18, 43], ranged: [17, 40], magic: [16, 37] };
const STYLE_OF_TYPE = ["melee", "ranged", "magic"];

const between = ([low, high], random = Math.random) => low + random() * (high - low);

/** The bot's inventory by kind: { kind: [{ slot, itemId, option }] }, plus `food` (any other Eat). */
function supplies(core, player) {
  const found = {};
  const items = player.getInventory().getItems();
  for (let slot = 0; slot < items.length; slot++) {
    const item = items[slot];
    if (!item || item.getAmount() <= 0) continue;
    const definition = core.CacheDefinitions.getItem(item.getId());
    const name = lower(definition?.name);
    const actions = (definition?.inventoryActions ?? []).map(lower);
    const match = KINDS.find((entry) => entry.test(name));
    const kind = match?.kind ?? (actions.includes("eat") ? "food" : null);
    if (!kind) continue;
    const option = match?.option ?? "eat";
    const index = actions.indexOf(option);
    if (index < 0) continue;
    (found[kind] ??= []).push({ slot, itemId: item.getId(), index, option });
  }
  return found;
}

function use(core, player, entry) {
  if (!entry) return false;
  core.ItemActionPacketListener.handleAction(player, INVENTORY_INTERFACE, entry.itemId, entry.slot, entry.index + 1, entry.option);
  return true;
}

function share(player, skill) {
  const skills = player.getSkillManager();
  return skills.getCurrentLevel(skill) / Math.max(1, skills.getMaxLevel(skill));
}

/** The style an attacker (or the bot) fights with: "melee", "ranged" or "magic". */
function styleOf(core, mob) {
  try {
    const type = core.CombatFactory.getMethod(mob)?.type?.();
    return STYLE_OF_TYPE[Number(type)] ?? "melee";
  } catch {
    return "melee";
  }
}

/**
 * Per-fight thresholds, so bots don't all eat at the same hitpoints. `unavailable`: prayers the
 * game refused (a quest the account lacks), kept by the caller for the session so it doesn't ask
 * again every fight (a player in bot mode would see the refusal each time).
 */
function newFight(random = Math.random, unavailable = new Set()) {
  return {
    eatAt: between([0.45, 0.65], random),
    comboAt: between([0.3, 0.45], random),
    prayerAt: between([0.15, 0.35], random),
    runAt: between([0.1, 0.3], random),
    brews: 0,
    unavailable,
  };
}

// The prayer book's button for each prayer id (PrayerHandler's own map, reversed).
let childByPrayer = null;
function prayerChild(core, prayerId) {
  // Built from (and kept for) the handler's own map.
  const source = core.PrayerHandler.PRAYER_BY_CHILD;
  if (!childByPrayer || childByPrayer.source !== source) {
    childByPrayer = new Map();
    childByPrayer.source = source;
    for (const [child, prayer] of source ?? []) childByPrayer.set(prayer, child);
  }
  return childByPrayer.get(prayerId) ?? null;
}

function prayerOn(player, prayerId) {
  return player.getPrayerActive?.()?.[prayerId] === true;
}

// A boost is drunk again once the style's level is back within this of its base (worn off; a
// divine potion holds it up, so isn't drunk early), and at most this often.
const BOOST_AGAIN_WITHIN = 2;
const BOOST_GAP_MS = 6000;
const BOOST_SKILL = { melee: "STRENGTH", ranged: "RANGED", magic: "MAGIC" };

/**
 * A boost potion for `style` when its boost has worn off (`state` keeps when it last drank).
 * True when it drank. It used to drink once a fight, at the start.
 */
function boostTick(core, player, style, have, state, nowMs = Date.now()) {
  const potion = have[`boost:${style}`]?.[0];
  const skill = core.Skill?.[BOOST_SKILL[style]];
  if (!potion || skill === undefined || nowMs < (state.boostAt?.[style] ?? 0)) return false;
  const skills = player.getSkillManager();
  if (skills.getCurrentLevel(skill) > skills.getMaxLevel(skill) + BOOST_AGAIN_WITHIN) return false;
  (state.boostAt ??= {})[style] = nowMs + BOOST_GAP_MS;
  return use(core, player, potion);
}

/** Click a prayer on or off as the book's button does; false when the game didn't take it. */
function setPrayer(core, player, prayerId, on) {
  if (prayerOn(player, prayerId) === on) return true;
  const child = prayerChild(core, prayerId);
  if (child == null) return false;
  core.PrayerHandler.togglePrayer(player, child);
  return prayerOn(player, prayerId) === on;
}

/**
 * Prayers this bot should have up against `attacker` while fighting with `ownStyle`. `offensive`
 * false: protection only (nothing in the pack restores prayer, so Piety would leave no points
 * for protection a few hits in).
 */
function wantedPrayers(player, fight, attackerStyle, ownStyle, prayerLevel, offensive = true) {
  const wanted = [];
  const [protect, protectLevel] = PROTECT[attackerStyle] ?? PROTECT.melee;
  if (prayerLevel >= protectLevel && !fight.unavailable.has(protect)) wanted.push(protect);
  if (!offensive) return wanted;
  for (const [ids, level] of OFFENSIVE[ownStyle] ?? OFFENSIVE.melee) {
    if (prayerLevel < level || ids.some((id) => fight.unavailable.has(id))) continue;
    wanted.push(...ids);
    break;
  }
  return wanted;
}

/**
 * One tick of a fight. `fight` from newFight(); `attacker` the mob fighting the bot. Returns what
 * it did ("ate", "combo", "brew", "restore", "prayer", "energy", or null).
 */
function supplyTick(core, player, fight, attacker) {
  const have = supplies(core, player);
  const hitpoints = share(player, core.Skill.HITPOINTS);
  const prayerSkill = core.Skill.PRAYER;
  const prayerLevel = player.getSkillManager().getMaxLevel(prayerSkill);
  const prayerShare = share(player, prayerSkill);
  let did = null;

  // Hitpoints first: a combo eat when it's dangerous, else food, else a brew.
  if (hitpoints < fight.eatAt) {
    const food = have.food?.[0];
    if (hitpoints < fight.comboAt && food && have.karambwan?.[0]) {
      use(core, player, food);
      use(core, player, have.karambwan[0]);
      did = "combo";
    } else if (food) {
      use(core, player, food);
      did = "ate";
    } else if (have.brew?.[0]) {
      use(core, player, have.brew[0]);
      fight.brews += 1;
      did = "brew";
    } else if (have.karambwan?.[0]) {
      use(core, player, have.karambwan[0]);
      did = "ate";
    }
  }
  // Venom (Zulrah) or poison: the cure for it, as soon as it's on (venom only grows).
  if (!did && player.isVenomed?.() && use(core, player, have.antivenom?.[0])) did = "antivenom";
  if (!did && player.isPoisoned?.() && !player.isVenomed?.() && use(core, player, have.antipoison?.[0] ?? have.antivenom?.[0])) did = "antipoison";
  // After brews (they lower attack, strength, defence, ranged and magic): a super restore.
  if (!did && fight.brews >= 2 && have.superRestore?.[0]) {
    use(core, player, have.superRestore[0]);
    fight.brews = 0;
    did = "restore";
  }
  // Prayer points.
  if (!did && prayerLevel > 0 && prayerShare < fight.prayerAt) {
    if (use(core, player, have.prayerPotion?.[0] ?? have.superRestore?.[0])) did = "prayer";
  }
  // Run energy (a fight it may have to run from).
  if (!did && player.getRunEnergy() / 100 < fight.runAt) {
    if (use(core, player, have.stamina?.[0] ?? have.energy?.[0])) did = "energy";
  }
  // Prayers up while there are points.
  if (player.getSkillManager().getCurrentLevel(prayerSkill) > 0) {
    // A monster whose attacks the game scripts (Zulrah) names its style per form in the data.
    const attackerStyle = require("./Hazards.SppBots").protectFor(attacker, player) ?? styleOf(core, attacker);
    const ownStyle = styleOf(core, player);
    const restores = Boolean(have.prayerPotion?.length || have.superRestore?.length);
    const wanted = wantedPrayers(player, fight, attackerStyle, ownStyle, prayerLevel, restores);
    for (const prayerId of wanted) {
      if (!setPrayer(core, player, prayerId, true)) fight.unavailable.add(prayerId);
    }
    // A protection prayer for another style goes off as the new one comes on (the Hunllef's
    // switches): the game's own overhead swap, but say so for prayers it keeps.
    for (const [other] of Object.values(PROTECT)) {
      if (!wanted.includes(other) && prayerOn(player, other)) setPrayer(core, player, other, false);
    }
    // Its style's boost potion, again once the last dose has worn off.
    if (!did && boostTick(core, player, ownStyle, have, fight)) did = "boost";
  }
  return did;
}

/** The fight is over: every prayer off, as a player saving points. */
function prayersOff(core, player) {
  const active = player.getPrayerActive?.() ?? [];
  for (let prayerId = 0; prayerId < active.length; prayerId++) {
    if (active[prayerId]) setPrayer(core, player, prayerId, false);
  }
}

/** Whether the bot still has anything that heals (food, karambwan or brews). */
function canHeal(core, player) {
  const have = supplies(core, player);
  return Boolean(have.food?.length || have.karambwan?.length || have.brew?.length);
}

module.exports = { supplies, use, boostTick, supplyTick, newFight, prayersOff, canHeal, styleOf, wantedPrayers, setPrayer, PROTECT, OFFENSIVE };
