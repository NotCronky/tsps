"use strict";

/**
 * A combat task (docs/playerbots.md, Combat): go to a place with a gear set and kill a number of a
 * monster (data/combat-tasks.json). As a brain activity: bank for the set (the style's best owned
 * pieces, its ammo or spell runes, its special weapon, switch sets), wear it, restock supplies,
 * travel, then hunt: attack the nearest free one in the area, let the fight run (Defence,
 * Supplies and Tactics, from Population before the brain), loot by the rules (Loot.SppBots.js),
 * and bank again when out of healing, ammo, runes or room. Every step is a player's click: bank
 * visits, Wield, the attack option, Take.
 */

const path = require("path");
const Loot = require("./Loot.SppBots");
const Tactics = require("./Tactics.SppBots");

const TASKS = require(path.join(__dirname, "data", "combat-tasks.json")).tasks;
const gear = require(path.join(__dirname, "data", "gear.json"));

const SLOTS = ["WEAPON_SLOT", "BODY_SLOT", "LEG_SLOT", "HEAD_SLOT", "SHIELD_SLOT", "FEET_SLOT", "HANDS_SLOT", "AMULET_SLOT", "CAPE_SLOT", "RING_SLOT"];
const STYLES = ["melee", "ranged", "magic"];
const INVENTORY_INTERFACE = 3214;
// Slots kept free for loot when filling up on food.
const LOOT_ROOM = 3;
const LOOT_MS = 8000;
const PICKUP_WAIT_MS = 2400;
// No monster to attack this long: the area's empty or out of reach; the task fails.
const NO_TARGET_MS = 3 * 60 * 1000;
// A spell worth taking needs runes for this many casts.
const MIN_CASTS = 50;
// Bones a Prayer training task takes and buries (the default rules leave bones).
const BONES = /^(bones|big bones|babydragon bones|dragon bones|wolf bones|burnt bones|bat bones)$/;
const BONES_RULE = { take: true, match: { names: ["^(bones|big bones|babydragon bones|dragon bones|wolf bones|bat bones)$"] }, when: { freeSlots: 1 } };
const BURY_MS = 1200;
// An enter step's click is given this long to land.
const STEP_MS = 15000;
// Out of food (a restock brought none): fight on while above this share of hitpoints, then stop.
const NO_FOOD_STOP = 0.3;
// Resting without food: until this share of hitpoints, at most this long.
const REST_UNTIL = 0.8;
const REST_MAX_MS = 10 * 60 * 1000;

const lower = (value) => String(value ?? "").toLowerCase();
// Names compared without case, spaces or punctuation: the spawn file's "Al-Kharid warrior" is the
// game's "Al Kharid warrior".
const sameName = (a, b) => lower(a).replace(/[^a-z0-9]/g, "") === lower(b).replace(/[^a-z0-9]/g, "");

function itemIdOf(core, key) {
  const id = core.ItemIds?.[key];
  return Number.isInteger(id) ? id : null;
}

/** Everything the bot owns, by item id: bank (every tab), pack and worn. */
function owned(core, player) {
  const counts = new Map();
  const add = (item) => {
    if (!item || !(item.getId?.() > 0)) return;
    counts.set(item.getId(), (counts.get(item.getId()) ?? 0) + item.getAmount());
  };
  for (let tab = 0; tab < (core.Bank.TOTAL_BANK_TABS ?? 1); tab++) for (const item of player.getBank(tab)?.getItems?.() ?? []) add(item);
  for (const item of player.getInventory().getItems()) add(item);
  for (const item of player.getEquipment().getItems()) add(item);
  return counts;
}

function levelOf(core, player, skill) {
  const id = core.Skill?.[skill.toUpperCase()];
  return id === undefined ? 1 : player.getSkillManager().getMaxLevel(id);
}

function meets(core, player, levels = {}) {
  return Object.entries(levels).every(([skill, level]) => levelOf(core, player, skill) >= level);
}

/**
 * The bot's best set of `style` from what it owns: { style, worn: { slot: id }, ammo: { id,
 * amount }, runes: [{ id, amount }], spell, special, weapon } or null without a weapon.
 */
function setFor(core, player, style, have = owned(core, player)) {
  const lists = style === "melee" ? gear.melee : gear[style];
  if (!lists) return null;
  const pick = (list, fits = () => true) => (list ?? []).find((entry) => {
    const id = itemIdOf(core, entry.item);
    return id && (have.get(id) ?? 0) > 0 && meets(core, player, entry.levels) && fits(entry);
  });
  const worn = {};
  let weapon = null;
  for (const slot of SLOTS) {
    const entry = pick(lists[slot]);
    if (!entry) continue;
    worn[slot] = itemIdOf(core, entry.item);
    if (slot === "WEAPON_SLOT") weapon = entry;
  }
  if (!weapon) return null;
  const set = { style, worn, ammo: null, runes: [], spell: null, special: null, weapon: weapon.item };
  if (style === "ranged") {
    const ammo = weapon.ammo
      ? pick(gear.bolts?.[weapon.ammo])
      : pick(gear.arrows, (arrow) => (arrow.tier ?? 0) <= (weapon.arrowTier ?? 0));
    if (!ammo) return null;
    const id = itemIdOf(core, ammo.item);
    set.ammo = { id, amount: have.get(id) };
  }
  if (style === "magic") {
    const spell = (gear.spells?.[weapon.element] ?? []).find((entry) => meets(core, player, entry.levels)
      && Object.entries(entry.runes).every(([rune, perCast]) => (have.get(itemIdOf(core, rune)) ?? 0) >= perCast * MIN_CASTS));
    if (!spell) return null;
    set.spell = spell.spell;
    set.runes = Object.keys(spell.runes).map((rune) => ({ id: itemIdOf(core, rune), amount: have.get(itemIdOf(core, rune)) }));
  }
  const special = pick(gear.specials?.[style], (entry) => entry.item !== weapon.item);
  if (special) set.special = itemIdOf(core, special.item);
  return set;
}

/** Defence bonuses of a monster by name, from one alive in the world, or null. */
function monsterDefence(core, name) {
  let found = null;
  core.World.getNpcs().forEach((npc) => {
    if (found || !npc) return;
    if (sameName(npc.getCurrentDefinition?.()?.getName?.(), name)) found = npc;
  });
  return found ? Tactics.npcDefence(found) : null;
}

/**
 * "auto": of the styles the bot has a set for, the one likeliest to do most damage to the monster:
 * its level against the monster's defence bonus for the style (melee its weakest of stab, slash
 * and crush). Otherwise the task's style.
 */
function chooseStyle(core, player, task) {
  if (task.style && task.style !== "auto") return task.style;
  const defence = monsterDefence(core, task.monster);
  let best = null;
  for (const style of STYLES) {
    if (!setFor(core, player, style)) continue;
    const level = style === "melee" ? Math.max(levelOf(core, player, "attack"), levelOf(core, player, "strength")) : levelOf(core, player, style);
    const bonuses = defence?.bonuses ?? [0, 0, 0, 0, 0];
    const against = style === "melee" ? Math.min(bonuses[0], bonuses[1], bonuses[2]) : style === "magic" ? bonuses[3] : bonuses[4];
    const score = level * (64 / Math.max(16, against + 64));
    if (!best || score > best.score) best = { style, score };
  }
  return best?.style ?? "melee";
}

/** Supplies to take for a task: [{ item: id, amount }], by what the bot owns and its levels. */
function suppliesFor(core, player, task, have, room) {
  const wanted = [];
  const take = (key, amount) => {
    const id = itemIdOf(core, key);
    const count = Math.min(amount, have.get(id) ?? 0, room - wanted.reduce((sum, entry) => sum + entry.amount, 0));
    if (id && count > 0) wanted.push({ item: id, amount: count });
  };
  const prayer = levelOf(core, player, "prayer");
  // The task's own first (Zulrah's anti-venom): [[ItemIds key, amount], ...].
  for (const [key, amount] of task.supplies ?? []) take(key, amount);
  take("STAMINA_POTION_4_", 1);
  if (prayer >= 37) take("PRAYER_POTION_4_", 3);
  take("SARADOMIN_BREW_4_", 2);
  take("SUPER_RESTORE_4_", 1);
  take("COOKED_KARAMBWAN", 4);
  // Then its best food for the rest, as many as the task asks for.
  const foods = (gear.food ?? []).map((entry) => itemIdOf(core, entry.item)).filter((id) => id && (have.get(id) ?? 0) > 0);
  const left = room - wanted.reduce((sum, entry) => sum + entry.amount, 0);
  for (const id of foods) {
    const amount = Math.min(task.food ?? 10, left, have.get(id));
    if (amount > 0) {
      wanted.push({ item: id, amount });
      break;
    }
  }
  return wanted;
}

function healing(core, player) {
  return require("./Supplies.SppBots").canHeal(core, player);
}

// What a full pack drops for room: empty vials (a drunk potion's).
const JUNK = new Set([229]);

/** Drops one junk item (JUNK) from the pack on the bot's tile, as a player's Drop; false with none. */
function dropJunk(api, player) {
  const inventory = player.getInventory();
  const slot = inventory.getItems().findIndex((item) => JUNK.has(item?.getId?.()));
  if (slot < 0) return false;
  const item = inventory.getItems()[slot];
  const [id, amount] = [item.getId(), item.getAmount()];
  inventory.deleteAtSlot(slot, amount);
  inventory.refreshItems();
  api.getItemOnGroundManager().registers(player, new api.core.Item(id, amount));
  return true;
}

/** Out of what the task needs: healing when hurt, ammo, runes, or room for loot. */
function needsRestock(core, player, set) {
  const skills = player.getSkillManager();
  const hp = skills.getCurrentLevel(core.Skill.HITPOINTS) / Math.max(1, skills.getMaxLevel(core.Skill.HITPOINTS));
  if (hp < 0.6 && !healing(core, player)) return "healing";
  if (set?.ammo && !(player.getEquipment().getItems()[core.Equipment.AMMUNITION_SLOT]?.getAmount?.() > 0)) return "ammo";
  if (set?.runes?.length && set.runes.some(({ id }) => !player.getInventory().getItems().some((item) => item?.getId?.() === id))) return "runes";
  if (player.getInventory().getFreeSlots() === 0) return "room";
  return null;
}

/** The nearest monster of the task in its area that's free to attack, or null. */
function findTarget(core, player, task) {
  const here = player.getLocation();
  const area = task.area;
  let best = null;
  core.World.getNpcs().forEach((npc) => {
    if (!npc || !(npc.getHitpoints?.() > 0)) return;
    if (!sameName(npc.getCurrentDefinition?.()?.getName?.(), task.monster)) return;
    // Its own instance's, not another player's at the same coordinates (Zulrah's shrine).
    if ((npc.getPrivateArea?.() ?? null) !== (player.getPrivateArea?.() ?? null)) return;
    const at = npc.getLocation();
    if (at.getZ() !== area.z || Math.max(Math.abs(at.getX() - area.x), Math.abs(at.getY() - area.y)) > area.radius) return;
    // Someone else's fight isn't the bot's to steal.
    const attacker = npc.getCombat?.()?.getAttacker?.() ?? npc.getCombat?.()?.getTarget?.();
    if (attacker && attacker !== player) return;
    const distance = Math.max(Math.abs(at.getX() - here.getX()), Math.abs(at.getY() - here.getY()));
    if (!best || distance < best.distance) best = { npc, distance };
  });
  return best?.npc ?? null;
}

// A player's kit runs short (bot mode): fewer foods than this, or no prayer restore, when it had them.
const KIT_FOOD_LOW = 3;
const baseName = (core, id) => lower(core.CacheDefinitions?.getItem?.(id)?.name).replace(/\s*\(\d+\)$/, "");
const isGear = (core, id) => (core.ItemDefinition?.forId?.(id)?.getEquipmentType?.()?.getSlot?.() ?? -1) >= 0;

/**
 * What a player in bot mode brought (the pack at the task's start): its supplies to restock to,
 * [{ item: id, amount }] (food, potions, teleport scrolls: what isn't gear), and every item's name
 * without its dose or charge ("ring of dueling", "prayer potion"): what's theirs, kept at the bank.
 */
function kitOf(core, player) {
  const take = new Map();
  const names = new Set();
  for (const item of player.getInventory().getItems()) {
    const id = item?.getId?.();
    if (!(id > 0)) continue;
    names.add(baseName(core, id));
    if (!isGear(core, id)) take.set(id, (take.get(id) ?? 0) + item.getAmount());
  }
  const have = require("./Supplies.SppBots").supplies(core, player);
  const count = (...kinds) => kinds.reduce((sum, kind) => sum + (have[kind]?.length ?? 0), 0);
  return {
    take: [...take].map(([item, amount]) => ({ item, amount })), names,
    food: count("food", "karambwan"), prayer: count("prayerPotion", "superRestore"), boost: count(...BOOST_KINDS),
  };
}
const BOOST_KINDS = ["boost:melee", "boost:ranged", "boost:magic"];

/** Why the kit's short ("food", "prayer"), or null: out of what it came with. */
function kitShort(core, player, kit) {
  if (!kit) return null;
  const have = require("./Supplies.SppBots").supplies(core, player);
  const food = (have.food?.length ?? 0) + (have.karambwan?.length ?? 0);
  const prayer = (have.prayerPotion?.length ?? 0) + (have.superRestore?.length ?? 0);
  const boost = BOOST_KINDS.reduce((sum, kind) => sum + (have[kind]?.length ?? 0), 0);
  if (kit.food > 0 && food < Math.min(KIT_FOOD_LOW, kit.food)) return "food";
  if (kit.prayer > 0 && prayer === 0) return "prayer";
  // Its boosting potions (forgotten brews, bastions) gone too: restocked with the rest.
  if (kit.boost > 0 && boost === 0) return "boost potions";
  return null;
}

/** Whether an NPC holds items of the bot's from a death ("item-retrieval:items", Zulrah's priestess). */
function heldFor(api, player) {
  const request = { player, items: [] };
  api.emitCustomEvent?.("item-retrieval:items", request);
  return request.items.length > 0;
}

/** The nearest NPC within 12 tiles whose name matches, or null. */
function npcNear(core, player, pattern) {
  const here = player.getLocation();
  let best = null;
  core.World.getNpcs().forEach((npc) => {
    if (!npc || !pattern.test(String(npc.getCurrentDefinition?.(player)?.getName?.() ?? ""))) return;
    const at = npc.getLocation();
    const distance = Math.max(Math.abs(at.getX() - here.getX()), Math.abs(at.getY() - here.getY()));
    if (at.getZ() === here.getZ() && distance <= 12 && (!best || distance < best.distance)) best = { npc, distance };
  });
  return best?.npc ?? null;
}

/** An NPC's option by name, as a click on it does; false when it hasn't one. */
function npcOption(core, player, npc, option) {
  const actions = (npc.getCurrentDefinition?.(player)?.getActions?.() ?? []).map(lower);
  const index = actions.indexOf(lower(option));
  if (index < 0) return false;
  new core.NPCOptionPacketListener().executeOption(player, npc.getIndex(), index + 1);
  return true;
}

/** Attack as the NPC's own Attack option does. */
function attack(core, player, npc) {
  const actions = (npc.getCurrentDefinition?.(player)?.getActions?.() ?? []).map(lower);
  const index = actions.indexOf("attack");
  if (index < 0) return false;
  new core.NPCOptionPacketListener().executeOption(player, npc.getIndex(), index + 1);
  return true;
}

let weaponStats = null;
/** A weapon's style by the Wiki's combat style (data/definitions/weapon-stats.json), or null. */
function weaponStyle(id) {
  if (!weaponStats) {
    try {
      weaponStats = require(path.join(process.cwd(), "data", "definitions", "weapon-stats.json"));
    } catch {
      weaponStats = {};
    }
  }
  const entry = weaponStats[String(id)];
  if (!entry) return null;
  const kind = lower(entry.combat_style);
  if (/bow|crossbow|thrown|chinchompa|blaster|salamander/.test(kind)) return { style: "ranged", ammo: /bow/.test(kind) && !/salamander/.test(kind), twoHanded: entry.slot === "2h" };
  if (/staff|wand/.test(kind)) return { style: "magic", powered: /powered/.test(kind), twoHanded: entry.slot === "2h" };
  return { style: "melee", twoHanded: entry.slot === "2h" };
}

const SHIELD = /defender|shield|kiteshield|ward|book of|avernic|buckler|toktz-ket/i;

/**
 * The sets on the character: what's worn (its weapon's style; a bow or crossbow with its ammo
 * worn, a staff only while autocasting) and, for each other style the task can use, a weapon of
 * it in the pack (a one-handed melee one with a shield from the pack). `ok` when that covers the
 * task's styles (its own and its switches; "auto": any), the task's items are carried, and the
 * task's food is there, or the character is a player in bot mode (their choice).
 */
function onHandSets(core, player, task) {
  const worn = player.getEquipment();
  const pack = player.getInventory();
  const items = pack.getItems();
  const weaponId = worn.getItems()[core.Equipment.WEAPON_SLOT]?.getId?.() ?? -1;
  const info = weaponId > 0 ? weaponStyle(weaponId) : null;
  const no = { ok: false };
  if (!info) return no;
  const autocast = Boolean(player.getCombat?.().getAutocastSpell?.());
  if (info.style === "magic" && !info.powered && !autocast) return no;
  const ammoItem = worn.getItems()[core.Equipment.AMMUNITION_SLOT];
  if (info.style === "ranged" && info.ammo && !(ammoItem?.getAmount?.() > 0)) return no;
  const wornSlots = {};
  for (const slot of SLOTS) {
    const id = worn.getItems()[core.Equipment[slot]]?.getId?.();
    if (id > 0) wornSlots[slot] = id;
  }
  const name = (id) => String(core.CacheDefinitions?.getItem?.(id)?.name ?? id);
  const main = {
    style: info.style, worn: wornSlots, ammo: info.style === "ranged" && info.ammo ? { id: ammoItem.getId(), amount: ammoItem.getAmount() } : null,
    runes: [], spell: null, special: null, weapon: name(weaponId), onHand: true,
  };
  const wanted = [task.style && task.style !== "auto" ? task.style : null, ...(task.switch ?? [])].filter(Boolean);
  const switches = [];
  for (const style of new Set(wanted)) {
    if (style === main.style) continue;
    const slot = items.findIndex((item) => item?.getId?.() > 0 && weaponStyle(item.getId())?.style === style
      && !(style === "magic" && !weaponStyle(item.getId()).powered));
    if (slot < 0) continue;
    const id = items[slot].getId();
    const w = weaponStyle(id);
    const set = { style, worn: { WEAPON_SLOT: id }, ammo: null, runes: [], spell: null, special: null, weapon: name(id), onHand: true };
    if (style === "melee" && !w.twoHanded) {
      const shield = items.find((item) => item?.getId?.() > 0 && SHIELD.test(name(item.getId())));
      if (shield) set.worn.SHIELD_SLOT = shield.getId();
    }
    if (style === "ranged" && w.ammo) {
      // Its ammo: in the pack, or already worn in the ammo slot (a magic main with the bow's arrows
      // on found no ranged switch, and sppdev fought Zulrah with the bow alone).
      const wornAmmo = worn.getItems()[core.Equipment.AMMUNITION_SLOT];
      const ammo = items.find((item) => item?.getId?.() > 0 && /arrow|bolt/i.test(name(item.getId())))
        ?? (wornAmmo?.getAmount?.() > 0 && /arrow|bolt/i.test(name(wornAmmo.getId())) ? wornAmmo : null);
      if (!ammo) continue;
      set.ammo = { id: ammo.getId(), amount: ammo.getAmount() };
    }
    // Its armour too: the style's best carried or worn pieces (a switch is the whole set, as a
    // player's; the weapon's shield above kept).
    const armour = require("./Tactics.SppBots").armourFor(core, player, style, w.twoHanded);
    if (set.worn.SHIELD_SLOT) delete armour.SHIELD_SLOT;
    Object.assign(set.worn, armour);
    switches.push(set);
  }
  const styles = new Set([main.style, ...switches.map((set) => set.style)]);
  if (!wanted.every((style) => styles.has(style))) return no;
  const needed = (task.items ?? []).map((key) => itemIdOf(core, key));
  if (!needed.every((id) => id && (worn.contains(id) || pack.contains(id)))) return no;
  return { ok: true, main, switches };
}

/**
 * What the task needs that the bot hasn't got, or null: `requires.levels` ({ skill: level }),
 * `requires.combat`, `requires.quests` (quest keys, asked as the quest plugins are), and
 * `requires.unlocks` (Imports' UNLOCKS: Zulrah's boat, ...).
 */
function unmetRequirement(api, player, task) {
  const core = api.core;
  const needs = task.requires ?? {};
  for (const [skill, level] of Object.entries(needs.levels ?? {})) {
    if (levelOf(core, player, skill) < level) return `${skill} ${level}`;
  }
  if (needs.combat && player.getSkillManager().getCombatLevel() < needs.combat) return `combat ${needs.combat}`;
  for (const key of needs.quests ?? []) {
    const request = { player, key, complete: false };
    api.emitCustomEvent?.("quest:is-complete", request);
    if (request.complete !== true) return `quest ${key}`;
  }
  const { UNLOCKS } = require("./Imports.SppBots");
  for (const key of needs.unlocks ?? []) {
    if (!UNLOCKS?.[key]?.(player)) return `unlock ${key}`;
  }
  return null;
}

/** An object by id or name pattern near the bot (its instance's too), or null. */
function objectNear(api, player, spec, radius = 12) {
  const { createMap } = require("./Travel.SppBots");
  const map = createMap(api.core);
  const pattern = new RegExp(spec.object, "i");
  if (player.getPrivateArea?.()) return map.instanceObject(player, pattern, null, radius);
  const here = player.getLocation();
  let best = null;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (const object of map.objectsAt(here.getX() + dx, here.getY() + dy, here.getZ())) {
        const name = String(api.core.ObjectDefinition.forPlayer(object.getId(), player)?.getName?.() ?? "");
        if (!pattern.test(name)) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (!best || distance < best.distance) best = { object, distance };
      }
    }
  }
  return best?.object ?? null;
}

/** Click an object's option as the client does (the option by its name). */
function clickObject(api, player, object, option) {
  const at = object.getLocation();
  new api.core.ObjectActionPacketListener().executeAction(player, object.getId(), at.getX(), at.getY(), 0, option);
}

/** Continue or answer whatever dialogue is up; true if there was one. */
function answerAnyDialogue(player, core = null) {
  if (core && require("./Dialogue.SppBots").answerPrompt(core, player)) return true;
  const dialogue = player.getDialogueManager?.();
  if (!dialogue?.getCurrent?.()) return false;
  require("./Dialogue.SppBots").answerDialogue(dialogue);
  return true;
}

/**
 * The task as a one-off brain activity. `entry` (Population's) learns which fights are the task's
 * (Defence: always wanted) and is told when the bot has to run (bank again rather than give up).
 */
function createCombatTask({ api, entry, taskId, task = TASKS[taskId] ?? require("./TaskGen.SppBots").taskById(api.core, taskId), log = () => {}, onDone = () => {} }) {
  const core = api.core;
  const { createBankVisit, createTravelAction } = require("./Travel.SppBots");
  const state = { phase: "prepare", kills: 0, skip: new Set(), restocks: 0, reclaims: 0 };
  let finished = false;
  const finish = (result, why) => {
    if (finished) return;
    finished = true;
    state.why = why;
    state.result = result;
    if (entry.combatTask === hooks) entry.combatTask = null;
    log("spp_bots_task", { name: entry.bot.name, task: taskId, result, why, kills: state.kills, restocks: state.restocks });
    onDone(result, state);
  };
  const hooks = {
    task,
    /** A fight with the task's monster is always wanted. */
    wants: (npc) => sameName(npc?.getCurrentDefinition?.()?.getName?.(), task.monster),
    /** The bot ran (nothing left that heals): bank and come back. */
    fled: () => {
      // Out of food already: banking won't bring any, so that's the end of it.
      // With no food: rest until hitpoints are back (as a player without food does), then on.
      if (state.noFood) {
        state.phase = "rest";
        return;
      }
      state.phase = "prepare";
      state.restocks += 1;
    },
    // A fight a task plays itself (`task.play`: Zulrah, ZulrahPlay.SppBots.js): every tick of it.
    play: (player) => playTick(player),
  };
  entry.combatTask = hooks;

  /** A bank trip for a player's kit: what's not theirs (loot) deposited, the kit withdrawn to its start. */
  function startKitRestock(player, why) {
    const loot = player.getInventory().getItems().map((item) => item?.getId?.())
      .filter((id) => id > 0 && !state.kit.names.has(baseName(core, id)));
    state.visit = createBankVisit({ api, depositIds: [...new Set(loot)], withdraw: state.kit.take, teleports: true, log });
    state.restocks += 1;
    state.phase = "kitRestock";
    log("spp_bots_task", { name: entry.bot.name, task: taskId, step: "restock", why, kit: true });
  }

  /**
   * Zulrah's fight (task.play "zulrah"), while it waits to rise or is on: its controller plays the
   * tick (Defence and the task wait). Won: the kill counted once, its loot under the bot looked
   * through, then out by the scroll (and back in on the boat while kills are left).
   */
  function playTick(player) {
    if (finished || task.play !== "zulrah") return false;
    const fight = require("../bosses/zulrah/Fight.Zulrah").fightOf(player);
    if (!fight) return false;
    // Not before it's there: the boat's click starts the fight, but the row out waits for its
    // dialogue (the enter step answers it; taking its ticks here stood the bot at the pier).
    if ((player.getPrivateArea?.() ?? null) !== fight.area) return false;
    if (fight.stage === "waiting" || fight.stage === "fight") {
      // Not before the task has its sets (its prepare step, the first update).
      if (!state.set) return false;
      state.zulrah ??= require("./ZulrahPlay.SppBots").createController({
        api, player, sets: () => hooks.sets,
        log: (data) => log("spp_bots_zulrah", { name: entry.bot.name, ...data }),
        onEscape: () => hooks.fled(),
      });
      state.zulrah.tick(fight);
      return true;
    }
    if (fight.stage === "won" && state.wonFight !== fight) {
      state.wonFight = fight;
      state.zulrah?.stop();
      state.zulrah = null;
      // Its main set back on, as it came: the trident left in hand made the next trip's check see
      // other sets and send the bot off to bank for gear it had.
      if (state.set) require("./Tactics.SppBots").wearSet(core, player, state.set);
      state.kills += 1;
      state.target = null;
      const at = player.getLocation();
      state.lootAt = { x: at.getX(), y: at.getY(), z: at.getZ() };
      state.lootUntil = Date.now() + LOOT_MS;
      state.needsLeave = true;
      state.phase = "loot";
      log("spp_bots_task", { name: entry.bot.name, task: taskId, step: "kill", kills: state.kills });
    }
    return false;
  }

  function update(ctx) {
    const player = ctx.player;
    const nowMs = Date.now();
    if (finished) return state.result ?? "failed";
    if (!task) return finish("failed", "no such task"), "failed";
    switch (state.phase) {
      case "prepare": {
        // A player's long task: what they brought is the kit, and a trip out of it (no food, no
        // prayer potions) restocks to it first (sppdev ate its sharks and sailed to Zulrah with none).
        if (entry.choice && !state.visit) {
          state.kit ??= kitOf(core, player);
          const short = kitShort(core, player, state.kit);
          if (short) return startKitRestock(player, short), "running";
        }
        if (!state.visit) {
          const unmet = unmetRequirement(api, player, task);
          if (unmet) return finish("failed", `needs ${unmet}`), "failed";
          // Geared up already: no bank trip first, as a player who's ready just goes; in the area,
          // straight to hunting. What's worn is the set (any weapon: the blowpipe and tentacle aren't
          // in gear.json), weapons of other styles in the pack are the switches. (Cronky, in the
          // gorilla cavern with a blowpipe on and a tentacle in the pack, went to bank instead, found
          // none in walking distance and the task failed; sppdev before that.)
          const ready = onHandSets(core, player, task);
          // A bot brings the task's food; a player in bot mode decides for themselves.
          if (ready.ok && (healing(core, player) || !(task.food > 0) || entry.choice)) {
            state.style = ready.main.style;
            state.set = ready.main;
            state.switches = ready.switches;
            hooks.sets = Object.fromEntries([state.set, ...state.switches].map((set) => [set.style, set]));
            state.noFood = !healing(core, player);
            const here = player.getLocation();
            const inArea = here.getZ() === task.area.z && Math.max(Math.abs(here.getX() - task.area.x), Math.abs(here.getY() - task.area.y)) <= task.area.radius
              && Boolean(player.getPrivateArea?.()) === Boolean(task.instanced);
            log("spp_bots_task", { name: entry.bot.name, task: taskId, step: inArea ? "already there" : "geared up", style: state.style, weapon: state.set.weapon, switches: state.switches.map((set) => set.style), food: !state.noFood });
            if (state.noFood && task.food > 0) player.sendMessage?.("Bot mode: no food with you; it fights on while it can and rests when low.");
            state.phase = inArea ? "hunt" : "travel";
            state.huntSince = nowMs;
            return "running";
          }
          const have = owned(core, player);
          state.style = state.style ?? chooseStyle(core, player, task);
          state.set = setFor(core, player, state.style, have);
          if (!state.set) return finish("failed", `no ${state.style} set`), "failed";
          // Items the trip needs (a key to get in): without them there's no point setting off.
          const needed = (task.items ?? []).map((key) => [key, itemIdOf(core, key)]);
          const missing = needed.filter(([, id]) => !id || !(have.get(id) > 0)).map(([key]) => key);
          if (missing.length) return finish("failed", `needs ${missing.join(", ")}`), "failed";
          state.switches = (task.switch ?? []).filter((style) => style !== state.style).map((style) => setFor(core, player, style, have)).filter(Boolean);
          // A monster that prays against the style hurting it (data/monsters.json "protection")
          // can't be fought with one set: without its switch the task isn't started. (sppdev went
          // into the gorillas with a scimitar only; once they prayed melee nothing hit, and it died.)
          if ((task.switch ?? []).length && !state.switches.length && Tactics.praysAgainst?.(task.monster)) {
            return finish("failed", `no ${task.switch.join("/")} set to switch to`), "failed";
          }
          // For Tactics' mid-fight switches: every set the bot has with it, by style.
          hooks.sets = Object.fromEntries([state.set, ...state.switches].map((set) => [set.style, set]));
          const takeOut = new Map();
          const add = (id, amount = 1) => id && takeOut.set(id, Math.max(takeOut.get(id) ?? 0, amount));
          for (const id of Object.values(state.set.worn)) add(id);
          if (state.set.ammo) add(state.set.ammo.id, state.set.ammo.amount);
          for (const rune of state.set.runes) add(rune.id, rune.amount);
          add(state.set.special);
          for (const [, id] of needed) add(id);
          // A switch set: its weapon and ammo or runes ride in the pack.
          for (const set of state.switches) {
            add(set.worn.WEAPON_SLOT);
            if (set.ammo) add(set.ammo.id, set.ammo.amount);
            for (const rune of set.runes) add(rune.id, rune.amount);
          }
          state.visit = createBankVisit({ api, depositAll: true, withdraw: [...takeOut].map(([item, amount]) => ({ item, amount })), log });
          log("spp_bots_task", { name: entry.bot.name, task: taskId, step: "bank", style: state.style, weapon: state.set.weapon, spell: state.set.spell, switches: state.switches.map((set) => set.style) });
        }
        const result = state.visit.update(ctx);
        if (result === "running") return "running";
        state.visit.stop(ctx);
        state.visit = null;
        if (result === "failed") return finish("failed", "bank"), "failed";
        state.phase = "equip";
        return "running";
      }
      case "equip": {
        // Wear the set (Wield/Wear from the pack); what comes off goes back in the bank next.
        const inventory = player.getInventory().getItems();
        const wear = [...Object.values(state.set.worn), state.set.ammo?.id].filter(Boolean);
        for (const id of wear) {
          const slot = inventory.findIndex((item) => item?.getId?.() === id);
          if (slot >= 0) core.EquipPacketListener.equip(player, id, slot, INVENTORY_INTERFACE);
        }
        if (state.set.spell) {
          const spell = core.CombatSpells?.[state.set.spell.toUpperCase().replace(/ /g, "_")];
          if (spell) core.Autocasting.setAutocast(player, spell);
        }
        const keep = new Set([state.set.special, ...state.set.runes.map((rune) => rune.id),
          ...(task.items ?? []).map((key) => itemIdOf(core, key)),
          ...state.switches.flatMap((set) => [set.worn.WEAPON_SLOT, set.ammo?.id, ...set.runes.map((rune) => rune.id)])].filter(Boolean));
        const off = player.getInventory().getItems().filter((item) => item && !keep.has(item.getId())).map((item) => item.getId());
        const room = player.getInventory().getFreeSlots() + off.length - LOOT_ROOM;
        const supplies = suppliesFor(core, player, task, owned(core, player), Math.max(0, room));
        state.visit = createBankVisit({ api, depositIds: off, withdraw: supplies, log });
        state.phase = "restock";
        return "running";
      }
      case "kitRestock": {
        // To a bank (the planner takes the teleports carried: the dueling ring's Castle Wars), the
        // loot in, the kit topped up, then back (a Zul-andra scroll from the pack).
        const result = state.visit.update(ctx);
        if (result === "running") return "running";
        state.visit.stop(ctx);
        state.visit = null;
        if (result === "failed") return finish("failed", "bank"), "failed";
        const still = kitShort(core, player, state.kit);
        if (still && still !== "boost potions") return finish("failed", `no ${still} left in the bank`), "failed";
        // None left to take: fought on without (not a bank trip every trip for them).
        if (still === "boost potions") state.kit.boost = 0;
        log("spp_bots_task", { name: entry.bot.name, task: taskId, step: "restocked" });
        state.phase = "prepare";
        return "running";
      }
      case "restock": {
        const result = state.visit.update(ctx);
        if (result === "running") return "running";
        state.visit.stop(ctx);
        state.visit = null;
        // Nothing that heals after a bank visit: the bot owns none, so banking again won't help.
        state.noFood = !healing(core, player);
        state.phase = "travel";
        return "running";
      }
      case "travel": {
        // A boss behind a way in (Zulrah's boat) is travelled to its way in, then entered.
        // A place far off in map coordinates (the MM2 crash site, Prifddinas) is searched for
        // from beside its way in: `via` first (the straight-line guess sends a search from the
        // mainland north to its cap: "too far" from the Pest Control island to the gorillas).
        const at = !state.viaDone && task.via ? task.via : task.travelTo;
        const goal = at ? { x: at[0], y: at[1], z: at[2] ?? 0 } : { x: task.area.x, y: task.area.y, z: task.area.z };
        state.travel ??= createTravelAction({ api, goal, log });
        const result = state.travel.update(ctx);
        if (result === "running") return "running";
        state.travel.stop(ctx);
        state.travel = null;
        if (result === "failed") return finish("failed", "travel"), "failed";
        if (task.via && !state.viaDone) {
          state.viaDone = true;
          return "running";
        }
        state.phase = task.enter ? "enter" : "hunt";
        state.huntSince = nowMs;
        state.enterSince = nowMs;
        state.enterTries = 0;
        return "running";
      }
      case "enter": {
        // An object's option (the boat's Quick-Board), its dialogue answered, until the bot is in
        // the instance; three tries of 15 s.
        const inside = Boolean(player.getPrivateArea?.());
        if (inside && !answerAnyDialogue(player, core)) {
          log("spp_bots_task", { name: entry.bot.name, task: taskId, step: "entered" });
          state.phase = "hunt";
          state.huntSince = nowMs;
          return "running";
        }
        if (inside || answerAnyDialogue(player, core)) return "running";
        // Items an NPC holds from a death there (`task.reclaim`: Zulrah's priestess) first: the
        // boat refuses anyone she still holds them for ("I've got some stuff you left at the shrine
        // earlier"); her Collect pays (free under 50 kills) and hands them back.
        // With a client her Collect opens the retrieval interface: its button pays, then takes all
        // (`task.reclaim.button`, the cache component), a click every 1.2 s after the Collect.
        if (task.reclaim && heldFor(api, player) && state.reclaimAt && nowMs < state.reclaimAt && task.reclaim.button
          && nowMs - (state.buttonAt ?? 0) >= 1200 && nowMs - (state.collectAt ?? 0) >= 1200) {
          state.buttonAt = nowMs;
          const buttonId = core.CacheDefinitions.getComponentId?.(task.reclaim.button);
          if (Number.isInteger(buttonId)) core.PluginManager.emitInterfaceActionClick({ player, buttonId, groupId: buttonId >>> 16, slot: -1, action: 1, handled: false });
          return "running";
        }
        // Her Collect fills the pack and keeps the rest: with no room left, a bank trip (the kit's,
        // what's not the kit deposited) and back for the rest.
        if (task.reclaim && heldFor(api, player) && state.kit && player.getInventory().getFreeSlots() === 0 && state.reclaims > 0) {
          state.reclaims = 0;
          state.reclaimAt = 0;
          state.enterClicked = false;
          return startKitRestock(player, "room for the priestess's items"), "running";
        }
        if (task.reclaim && heldFor(api, player) && nowMs >= (state.reclaimAt ?? 0)) {
          const npc = npcNear(core, player, new RegExp(task.reclaim.npc, "i"));
          if (npc && npcOption(core, player, npc, task.reclaim.option)) {
            log("spp_bots_task", { name: entry.bot.name, task: taskId, step: "reclaim", npc: task.reclaim.npc });
            state.collectAt = nowMs;
            state.reclaimAt = nowMs + STEP_MS / 3;
            if (++state.reclaims > 3) {
              // Collect takes everything or nothing: a pack without room for it all gets nothing.
              const request = { player, items: [] };
              api.emitCustomEvent?.("item-retrieval:items", request);
              const room = player.getInventory().getFreeSlots() < request.items.length;
              return finish("failed", room ? `no room to collect ${request.items.length} held items` : "couldn't reclaim (the fee?)"), "failed";
            }
            return "running";
          }
        }
        if (task.reclaim && heldFor(api, player)) return nowMs - (state.reclaimAt ?? 0) > STEP_MS ? (finish("failed", "couldn't reclaim"), "failed") : "running";
        if (!state.enterClicked) {
          const object = objectNear(api, player, task.enter);
          if (!object) return finish("failed", `no ${task.enter.object}`), "failed";
          clickObject(api, player, object, task.enter.option);
          state.enterClicked = true;
          state.enterSince = nowMs;
          return "running";
        }
        if (nowMs - state.enterSince > STEP_MS) {
          state.enterClicked = false;
          if (++state.enterTries >= 3) return finish("failed", "couldn't get in"), "failed";
        }
        return "running";
      }
      case "leave": {
        // Out of the instance the way it offers (Zulrah's teleport scroll), its "Leave?" answered.
        if (!player.getPrivateArea?.()) {
          if (state.kills >= (task.kills ?? 1)) return finish("success", "kills"), "success";
          // Kills left: back to the start (topped up from the bank if short), then in again.
          state.needsLeave = false;
          state.leaveSince = null;
          state.phase = "prepare";
          return "running";
        }
        if (answerAnyDialogue(player, core) || player.busy?.()) return "running";
        if (nowMs < (state.leaveAt ?? 0)) return "running";
        // Zulrah's scroll is a runtime object (ObjectManager's), which the instance search doesn't
        // see: the fight's own (the first kill's "couldn't leave").
        const object = (task.play === "zulrah" ? require("../bosses/zulrah/Fight.Zulrah").fightOf(player)?.teleport : null)
          ?? objectNear(api, player, task.leave, 6);
        if (object) {
          const first = (core.ObjectDefinition.forPlayer(object.getId(), player)?.getInteractions?.() ?? []).find(Boolean);
          clickObject(api, player, object, String(task.leave.option ?? first ?? "").toLowerCase());
        }
        state.leaveAt = nowMs + 3000;
        if (nowMs - (state.leaveSince ??= nowMs) > 60000) return finish("failed", "couldn't leave"), "failed";
        return "running";
      }
      case "hunt": {
        // The last target: dead means a kill, and its drop to look through.
        const target = state.target;
        if (target && (!(target.getHitpoints?.() > 0) || target.isRegistered?.() === false)) {
          state.kills += 1;
          state.lootAt = state.targetAt;
          state.lootUntil = nowMs + LOOT_MS;
          state.target = null;
          state.phase = "loot";
          log("spp_bots_task", { name: entry.bot.name, task: taskId, step: "kill", kills: state.kills });
          return "running";
        }
        // A training task ends at its level; a plain one at its kill count.
        if (task.until) {
          const id = core.Skill?.[String(task.until.skill).toUpperCase()];
          if (id !== undefined && player.getSkillManager().getMaxLevel(id) >= task.until.level) return finish("success", "level"), "success";
        } else if (state.kills >= (task.kills ?? 1)) {
          if (task.leave && player.getPrivateArea?.()) return (state.phase = "leave"), "running";
          return finish("success", "kills"), "success";
        }
        // A fight that's one kill a trip (Zulrah's): out, and back in for the next.
        if (state.needsLeave && task.leave && player.getPrivateArea?.()) return (state.phase = "leave"), "running";
        let short = needsRestock(core, player, state.set);
        // A player's kit run out mid-task (outside an instance: a fight there finishes first).
        if (entry.choice && !player.getPrivateArea?.() && !player.getCombat().getAttacker?.()) {
          const out = kitShort(core, player, state.kit);
          if (out) return startKitRestock(player, out), "running";
        }
        if (short === "healing" && state.noFood) {
          const skills = player.getSkillManager();
          const hp = skills.getCurrentLevel(core.Skill.HITPOINTS) / Math.max(1, skills.getMaxLevel(core.Skill.HITPOINTS));
          if (hp < NO_FOOD_STOP) {
            state.phase = "rest";
            state.restSince = nowMs;
            return "running";
          }
          short = null;
        }
        // A full pack: empty vials (drunk potions) go on the floor first, as a player drops them.
        // Then a player in bot mode fights on without room for loot (their pack, their call):
        // sending them to "restock" from where they stand turned "already there" and "restock"
        // into a loop every tick (sppdev in the gorilla cavern, 28 items).
        if (short === "room" && dropJunk(api, player)) return "running";
        if (short === "room" && entry.choice) short = null;
        if (short) {
          log("spp_bots_task", { name: entry.bot.name, task: taskId, step: "restock", why: short });
          state.restocks += 1;
          state.phase = "prepare";
          return "running";
        }
        if (target && player.getCombat().getTarget?.() === target) {
          const at = target.getLocation();
          state.targetAt = { x: at.getX(), y: at.getY(), z: at.getZ() };
          return "running";
        }
        const next = findTarget(core, player, task);
        if (!next) {
          if (nowMs - state.huntSince > NO_TARGET_MS) return finish("failed", "no monster"), "failed";
          // Back to the middle of the area to look around.
          const here = player.getLocation();
          if (Math.max(Math.abs(here.getX() - task.area.x), Math.abs(here.getY() - task.area.y)) > task.area.radius && !player.getMovementQueue().size?.()) {
            player.getMovementQueue().requestWalk(new core.Location(task.area.x, task.area.y, task.area.z), null);
          }
          return "running";
        }
        if (attack(core, player, next)) {
          state.target = next;
          const at = next.getLocation();
          state.targetAt = { x: at.getX(), y: at.getY(), z: at.getZ() };
          state.huntSince = nowMs;
        }
        return "running";
      }
      case "loot": {
        if (state.pickup && nowMs < state.pickup.until) return "running";
        if (state.pickup) state.skip.add(state.pickup.key); // tried once: still there means it didn't work
        state.pickup = null;
        const rules = task.bury ? [BONES_RULE, ...(task.loot ?? [])] : task.loot ?? [];
        const next = nowMs < state.lootUntil ? Loot.nextPickup(core, player, state.lootAt, rules, state.skip) : null;
        if (!next) {
          // Its own arrows or bolts picked up go back in the quiver, as a player's do.
          const ammo = player.getEquipment().getItems()[core.Equipment.AMMUNITION_SLOT];
          const items = player.getInventory().getItems();
          const slot = ammo?.getId?.() > 0 ? items.findIndex((item) => item?.getId?.() === ammo.getId()) : -1;
          if (slot >= 0) core.EquipPacketListener.equip(player, ammo.getId(), slot, INVENTORY_INTERFACE);
          state.phase = task.bury ? "bury" : "hunt";
          state.huntSince = nowMs;
          return "running";
        }
        Loot.pickUp(core, player, next.ground);
        state.pickup = { key: next.key, until: nowMs + PICKUP_WAIT_MS };
        return "running";
      }
      case "rest": {
        // Stand still (out of the way) until hitpoints are most of the way back, or give up.
        state.restSince ??= nowMs;
        const skills = player.getSkillManager();
        const hp = skills.getCurrentLevel(core.Skill.HITPOINTS) / Math.max(1, skills.getMaxLevel(core.Skill.HITPOINTS));
        if (hp >= REST_UNTIL) {
          state.restSince = null;
          state.phase = "hunt";
          state.huntSince = nowMs;
          return "running";
        }
        if (nowMs - state.restSince > REST_MAX_MS) return finish("failed", "out of food"), "failed";
        return "running";
      }
      case "bury": {
        // A bone at a time, as the Bury option allows (its own delay), until none are left.
        if (nowMs < (state.buryAt ?? 0)) return "running";
        const items = player.getInventory().getItems();
        const slot = items.findIndex((item) => item && BONES.test(lower(core.CacheDefinitions.getItem(item.getId())?.name)));
        if (slot < 0) {
          state.phase = "hunt";
          state.huntSince = nowMs;
          return "running";
        }
        const id = items[slot].getId();
        const actions = (core.CacheDefinitions.getItem(id)?.inventoryActions ?? []).map(lower);
        const index = actions.indexOf("bury");
        if (index < 0) {
          state.phase = "hunt";
          return "running";
        }
        core.ItemActionPacketListener.handleAction(player, INVENTORY_INTERFACE, id, slot, index + 1, actions[index]);
        state.buryAt = nowMs + BURY_MS;
        return "running";
      }
      default:
        return "running";
    }
  }

  const action = {
    id: "combatTask",
    update,
    madeProgress: () => true,
    describe: () => ({ task: taskId, phase: state.phase, style: state.style, kills: state.kills, restocks: state.restocks, target: state.target?.getIndex?.() ?? null }),
    stop(ctx) {
      state.visit?.stop?.(ctx);
      state.travel?.stop?.(ctx);
      finish("failed", "stopped");
    },
  };
  return {
    id: `task:${taskId}`, skill: null, resolver: false, resolves: null, mode: "combat", capacity: 1, repeat: false,
    ephemeral: false, manual: false, failureCooldownMs: 0, requires: [], setup: [], actions: [action],
    describe: () => action.describe(), produces: [], site: null,
  };
}

module.exports = { kitOf, kitShort, createCombatTask, setFor, chooseStyle, owned, unmetRequirement, onHandSets, weaponStyle, TASKS };
