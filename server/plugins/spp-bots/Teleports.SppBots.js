"use strict";

/**
 * The teleports a bot can use to cut a trip short (docs/playerbots.md, "Teleports"): spellbook
 * teleports, tablets and scrolls, charged jewellery and minigame teleports. The list comes from
 * the server's own tables (SpellTeleports, teleport-tablets.json, Teleports.Jewellery.js,
 * minigame-teleports.json), so where a bot plans to land is where the server puts it.
 *
 * A bot casts the way a client does: the spell's button through emitInterfaceActionClick, a
 * tablet's Break or a piece's destination through the item option listener, the minigame
 * teleport through the grouping tab's button. The server's own checks (levels, runes, quests,
 * Wilderness, cooldowns) decide; a refusal is remembered so the bot doesn't plan it again.
 */

const {
  JEWELLERY,
  TELEPORT_TABLETS,
  MINIGAME_TELEPORTS,
  MINIGAME_TELEPORT,
  dateMinutes,
  isMembersWorld,
  HOUSE,
} = require("./Imports.SppBots");

const INVENTORY_INTERFACE = 3214;
/** Teleport options on tablets and scrolls. */
const TABLET_OPTIONS = ["break", "teleport", "read"];
/** Ticks from the cast to standing at the destination, a little over the animation. */
const CAST_TICKS = { spell: 5, tablet: 5, jewellery: 5, minigame: 20, house: 20 };
/**
 * What using one costs on top of its ticks, so a bot doesn't spend a charge or a tablet to save
 * a few steps, nor its minigame teleport (20 minutes' cooldown) on a short walk.
 */
const USE_COST = { spell: 10, tablet: 25, jewellery: 25, minigame: 60, house: 20 };
const HOUSE_TABLET = 8013;
const HOUSE_SPELL = "teleport to house";
const BOX_KEYS = { BASIC_JEWELLERY_BOX: "Basic Jewellery Box", FANCY_JEWELLERY_BOX: "Fancy Jewellery Box", ORNATE_JEWELLERY_BOX: "Ornate Jewellery Box" };
/** A server refusal that won't change this session (a quest, a level, no house). */
const LASTING_REFUSAL = /need to (complete|have|be)|not yet unlocked|do not own|don't own|level of \d+|requires|members'|must free|haven't|have not/i;
/** One that passes (a cooldown, busy, moving): the teleport is skipped this long. */
const PASSING_REFUSAL_MS = 5 * 60000;
/** Messages kept per bot, for why a teleport didn't happen. */
const MESSAGES_KEPT = 8;
// Not for getting about: the house is out of scope, and these land somewhere a trip doesn't go on from.
const SKIPPED_SPELLS = new Set(["teleport to house"]);

let catalog = null;
/** Per bot: teleport key -> { until, reason }, for teleports the server refused. */
const refused = new WeakMap();
/** Per bot: recent game messages [{ at, text }] (taken once a bot first casts). */
const messages = new WeakMap();

const tile = ([x, y, z = 0]) => ({ x, y, z });
const lower = (text) => String(text ?? "").trim().toLowerCase();

/** Item ids by lower-case name with one of `options` in the inventory, unnoted. */
function itemsByName(core, names, options) {
  const { CacheDefinitions } = core;
  const wanted = new Set(names);
  const found = new Map();
  const count = CacheDefinitions.getCounts().items;
  for (let id = 0; id < count; id++) {
    const item = CacheDefinitions.getItem(id);
    const name = lower(item?.name);
    if (!wanted.has(name) || found.has(name)) continue;
    const actions = (item.inventoryActions ?? []).map(lower);
    if (options.some((option) => actions.includes(option))) found.set(name, id);
  }
  return found;
}

/** The grouping tab's slot for each minigame name (cache enum 848). */
function groupingSlots(core) {
  const slots = new Map();
  for (const [slot, name] of core.CacheDefinitions.getEnumValues(MINIGAME_TELEPORT.groupingActivityEnum) ?? []) {
    if (typeof name === "string") slots.set(name, slot);
  }
  return slots;
}

function buildCatalog(core) {
  const entries = [];
  const destinations = [
    ...core.SpellTeleports.getTeleportDestinations(),
  ];
  for (const spell of destinations) {
    if (SKIPPED_SPELLS.has(spell.name)) continue;
    const at = spell.destination;
    entries.push({
      key: `spell:${spell.name}`, kind: "spell", name: spell.name, menu: `Cast ${spell.name}`,
      to: { x: at.getX(), y: at.getY(), z: at.getZ() },
      level: spell.level, spellbook: spell.spellbook,
      items: spell.runes.map((rune) => ({ ids: [rune.getId()], amount: rune.getAmount() })),
    });
  }

  // Tablets share their spell's destination; redirected tablets and scrolls have their own.
  const tabletTiles = new Map();
  for (const entry of entries) if (entry.spellbook === core.MagicSpellbook.NORMAL) tabletTiles.set(entry.name, entry.to);
  for (const group of ["redirects", "tablets", "scrolls"]) {
    for (const [name, at] of Object.entries(TELEPORT_TABLETS[group] ?? {})) tabletTiles.set(name, tile(at));
  }
  // And the scrolls content plugins handle themselves (Zulrah's Zul-andra teleport).
  for (const [name, at] of Object.entries(require("./data/teleport-scrolls.json").scrolls ?? {})) tabletTiles.set(name, tile(at));
  const tabletIds = itemsByName(core, [...tabletTiles.keys()], TABLET_OPTIONS);
  for (const [name, to] of tabletTiles) {
    const id = tabletIds.get(name);
    if (id === undefined) continue;
    entries.push({ key: `tablet:${name}`, kind: "tablet", name, menu: `Break ${name}`, to, itemId: id, items: [{ ids: [id], amount: 1 }] });
  }

  for (const piece of JEWELLERY) {
    const ids = [...(piece.charged ?? []).map(([id]) => id), ...(piece.eternal ?? [])].filter(Number.isInteger);
    if (!ids.length) continue;
    for (const destination of piece.destinations ?? []) {
      if (!Array.isArray(destination.tile) || destination.colosseumRank) continue;
      entries.push({
        key: `jewellery:${piece.key}:${destination.label}`, kind: "jewellery", name: `${piece.key} ${destination.label}`,
        menu: `Rub ${piece.noun} (${destination.label})`, label: destination.label, to: tile(destination.tile),
        ids, items: [{ ids, amount: 1 }], quest: destination.quest?.key ?? null, members: true,
      });
    }
  }

  const slots = groupingSlots(core);
  for (const [name, minigame] of Object.entries(MINIGAME_TELEPORTS)) {
    // Ones that ask where to (Rat Pits) or need something the server can't check are left out.
    if (minigame.choices || minigame.notes || minigame.visited) continue;
    const slot = slots.get(name) ?? slots.get(minigame.groupingName);
    if (!Number.isInteger(slot)) continue;
    entries.push({
      key: `minigame:${name}`, kind: "minigame", name, menu: `Minigame teleport ${name}`,
      to: { x: minigame.x, y: minigame.y, z: 0 }, slot, members: minigame.members === true,
      skills: minigame.skills ?? {}, combat: minigame.combat ?? 0, quests: minigame.quests ?? [], items: [],
    });
  }
  return entries;
}

function catalogOf(core) {
  if (!catalog) catalog = buildCatalog(core);
  return catalog;
}

function questComplete(api, player, query) {
  const request = { player, ...query, complete: false };
  api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

/** Minutes until the minigame teleport can be used again (0: now). */
function minigameCooldown(player) {
  const last = Number(player.getAttribute(MINIGAME_TELEPORT.lastMinuteAttribute));
  if (!Number.isFinite(last) || last <= 0) return 0;
  return Math.max(0, MINIGAME_TELEPORT.cooldownMinutes - (dateMinutes() - last));
}

/**
 * Content that refuses a teleport to a place (Morytania before Priest in Peril, ...) answers
 * "teleport:can-start", the check every teleport makes: asked here so a bot doesn't plan one the
 * server will refuse. Per player and destination, for the plan.
 */
function destinationAllowed(api, player, entry) {
  const { Location } = api.core;
  const restriction = { player, destination: new Location(entry.to.x, entry.to.y, entry.to.z), wildernessLevelLimit: 20, spellName: entry.kind === "spell" ? entry.name : undefined, allow: null };
  api.emitCustomEvent("teleport:can-start", restriction);
  return restriction.allow !== false;
}

/** Whether the account can use `entry` at all, items aside. */
function allowed(api, player, entry) {
  const { core } = api;
  if ((refused.get(player)?.get(entry.key)?.until ?? 0) > Date.now()) return false;
  if (entry.members && !isMembersWorld()) return false;
  if (!destinationAllowed(api, player, entry)) return false;
  const skills = player.getSkillManager();
  if (entry.kind === "spell") {
    return entry.spellbook === player.getSpellbook() && skills.getMaxLevel(core.Skill.MAGIC) >= entry.level;
  }
  if (entry.kind === "jewellery") return !entry.quest || questComplete(api, player, { key: entry.quest });
  if (entry.kind === "minigame") {
    if (minigameCooldown(player) > 0) return false;
    if (entry.combat && skills.getCombatLevel() < entry.combat) return false;
    if (Object.entries(entry.skills).some(([skill, level]) => skills.getMaxLevel(core.Skill[skill]) < level)) return false;
    return entry.quests.every((name) => questComplete(api, player, { name }));
  }
  return true;
}

/** The house's furniture of `hotspot` (its buildable key), or null. */
function houseFurniture(save, hotspot) {
  for (const plane of save?.rooms ?? []) for (const row of plane ?? []) for (const room of row ?? []) {
    for (const furniture of Object.values(room?.furnitureByLocation ?? {})) if (furniture?.hotspotKey === hotspot) return furniture;
  }
  return null;
}

/**
 * Teleports by way of the bot's own house: in with a house tablet or the spell, out through the
 * portal nexus (each of its slots) or the jewellery box (each of its slots, by its tier). Built
 * per plan from the bot's house; none without one.
 */
function houseHops(api, player) {
  const { core } = api;
  const owns = { player, owns: false };
  api.emitCustomEvent("construction:owns-house", owns);
  if (!owns.owns) return [];
  const save = HOUSE.houseState(player);
  // A walk inside doesn't go through closed doors: a house with them shut (a real player's in bot
  // mode; bots open theirs, HOUSE.openDoors) isn't a way anywhere. 0 closed, 1 open, 2 none.
  if ((save?.doorMode ?? 0) === 0) return [];
  const outs = [];
  if (houseFurniture(save, "PORTAL_NEXUS")) {
    const all = HOUSE.nexusDestinations();
    HOUSE.nexusSlots(player).forEach((id, slot) => {
      const tile = all.get(id)?.tile;
      if (tile) outs.push({ furniture: "nexus", slot, label: all.get(id).spellName, to: { x: tile.getX(), y: tile.getY(), z: tile.getZ() } });
    });
  }
  const box = houseFurniture(save, "JEWELLERY_BOX");
  const slots = HOUSE.jewelleryBoxes[BOX_KEYS[box?.buildableKey]]?.slots ?? 0;
  if (slots) {
    const request = { player, list: [] };
    api.emitCustomEvent("construction:jewellery-box-destinations", request);
    request.list.slice(0, slots).forEach((destination, slot) => {
      const at = destination.location;
      if (at && !destination.wildernessLevel) outs.push({ furniture: "jewellery box", slot, label: destination.label, to: { x: at.getX(), y: at.getY(), z: at.getZ() } });
    });
  }
  if (!outs.length) return [];
  // In: the tablet, or the spell (the standard book, level 40).
  const ins = [{ by: "tablet", items: [{ ids: [HOUSE_TABLET], amount: 1 }] }];
  const spell = core.SpellTeleports.getTeleportDestinations().find((data) => data.name === HOUSE_SPELL);
  if (spell && player.getSpellbook() === spell.spellbook && player.getSkillManager().getMaxLevel(core.Skill.MAGIC) >= spell.level) {
    ins.push({ by: "spell", items: spell.runes.map((rune) => ({ ids: [rune.getId()], amount: rune.getAmount() })) });
  }
  const hops = [];
  for (const way of ins) {
    for (const out of outs) {
      hops.push({
        key: `house:${way.by}:${out.furniture}:${out.slot}`, kind: "house", name: `house ${out.label}`,
        menu: `House (${way.by}) ${out.furniture}: ${out.label}`, to: out.to, enter: way.by, out, items: way.items,
      });
    }
  }
  return hops;
}

/** How many of `need` (all of its items) `counts` (id -> amount) covers. */
function covered(entry, counts) {
  return entry.items.every(({ ids, amount }) => ids.some((id) => (counts.get(id) ?? 0) >= amount));
}

/**
 * The teleports open to `player`: `carried` it can use where it stands, `banked` it could use
 * after a bank visit (with the withdrawals each needs). `carriedCounts`/`ownedCounts`: id -> amount.
 */
function teleportsFor(api, player, carriedCounts, ownedCounts) {
  const carried = [];
  const banked = [];
  for (const entry of [...catalogOf(api.core), ...houseHops(api, player)]) {
    if (!allowed(api, player, entry)) continue;
    if (covered(entry, carriedCounts)) {
      carried.push(entry);
      continue;
    }
    if (!covered(entry, ownedCounts)) continue;
    // Withdraw what isn't carried: per item, the id the account has most of.
    const fetch = [];
    for (const { ids, amount } of entry.items) {
      if (ids.some((id) => (carriedCounts.get(id) ?? 0) >= amount)) continue;
      const id = [...ids].sort((a, b) => (ownedCounts.get(b) ?? 0) - (ownedCounts.get(a) ?? 0))[0];
      fetch.push({ item: id, amount });
    }
    banked.push({ ...entry, fetch });
  }
  return { carried, banked };
}

/** What a teleport costs in planner steps (its ticks plus the use cost). */
function costOf(entry) {
  return CAST_TICKS[entry.kind] + USE_COST[entry.kind];
}

/** Uses `entry` as a client's click would. False when the bot hasn't got what it needs on it. */
function cast(api, player, entry) {
  const { core } = api;
  const { PluginManager, CacheDefinitions, ItemActionPacketListener } = core;
  listen(player);
  if (entry.kind === "house") {
    // In by the spell, or the tablet's "Inside" (Break would follow the house's setting).
    if (entry.enter === "spell") return cast(api, player, { kind: "spell", name: HOUSE_SPELL });
    const items = player.getInventory().getItems();
    const slot = items.findIndex((item) => item && item.getId() === HOUSE_TABLET);
    if (slot < 0) return false;
    const actions = (CacheDefinitions.getItem(HOUSE_TABLET)?.inventoryActions ?? []).map(lower);
    const index = actions.includes("inside") ? actions.indexOf("inside") : actions.indexOf("break");
    if (index < 0) return false;
    ItemActionPacketListener.handleAction(player, INVENTORY_INTERFACE, HOUSE_TABLET, slot, index + 1, actions[index]);
    return true;
  }
  if (entry.kind === "spell") {
    const spell = CacheDefinitions.getSpellByName(entry.name);
    if (!spell) return false;
    PluginManager.emitInterfaceActionClick({
      player, buttonId: spell.widgetId, action: 1, groupId: spell.widgetId >>> 16, childId: spell.widgetId & 0xffff,
      itemId: spell.itemId, handled: false,
    });
    return true;
  }
  if (entry.kind === "minigame") {
    PluginManager.emitInterfaceActionClick({
      player, buttonId: (MINIGAME_TELEPORT.groupingInterface << 16) | MINIGAME_TELEPORT.groupingTeleportChild, action: 1,
      groupId: MINIGAME_TELEPORT.groupingInterface, childId: MINIGAME_TELEPORT.groupingTeleportChild, opId: 1, slot: entry.slot, handled: false,
    });
    return true;
  }
  const ids = entry.kind === "tablet" ? [entry.itemId] : entry.ids;
  const items = player.getInventory().getItems();
  const slot = items.findIndex((item) => item && ids.includes(item.getId()) && item.getAmount() > 0);
  if (slot < 0) return false;
  const itemId = items[slot].getId();
  const actions = (CacheDefinitions.getItem(itemId)?.inventoryActions ?? []).map(lower);
  if (entry.kind === "tablet") {
    const index = actions.findIndex((action) => TABLET_OPTIONS.includes(action));
    if (index < 0) return false;
    ItemActionPacketListener.handleAction(player, INVENTORY_INTERFACE, itemId, slot, index + 1, actions[index]);
    return true;
  }
  // Jewellery: the destination's own option (as the Rub submenu or a worn option names it).
  const rub = actions.indexOf("rub");
  ItemActionPacketListener.handleAction(player, INVENTORY_INTERFACE, itemId, slot, rub >= 0 ? rub + 1 : 2, entry.label);
  return true;
}

/**
 * Keeps a bot's game messages from now on (a bot has no client to read them), so a refusal can
 * say why. Wraps the player's own sendMessage once.
 */
function listen(player) {
  if (messages.has(player)) return;
  const kept = [];
  messages.set(player, kept);
  const send = player.sendMessage.bind(player);
  player.sendMessage = (text, ...rest) => {
    kept.push({ at: Date.now(), text: String(text ?? "") });
    if (kept.length > MESSAGES_KEPT) kept.shift();
    return send(text, ...rest);
  };
}

/** Messages the bot got since `sinceMs`. */
function messagesSince(player, sinceMs) {
  return (messages.get(player) ?? []).filter((message) => message.at >= sinceMs).map((message) => message.text);
}

/**
 * The server didn't teleport the bot. Why, from its messages since `sinceMs`: a lasting reason
 * (a quest, a level) keeps this bot off it for the session; anything else (a cooldown, busy,
 * moving, or no message at all) for a few minutes. Returns { reason, lasting }.
 */
function refuse(player, entry, sinceMs = 0) {
  const said = messagesSince(player, sinceMs);
  const reason = said.find((text) => LASTING_REFUSAL.test(text)) ?? said[said.length - 1] ?? "no message";
  const lasting = LASTING_REFUSAL.test(reason);
  if (!refused.has(player)) refused.set(player, new Map());
  refused.get(player).set(entry.key, { until: lasting ? Infinity : Date.now() + PASSING_REFUSAL_MS, reason });
  return { reason, lasting };
}

module.exports = { teleportsFor, cast, refuse, listen, messagesSince, costOf, catalogOf, minigameCooldown, HOUSE_TABLET };
