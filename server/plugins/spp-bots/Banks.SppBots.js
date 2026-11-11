"use strict";

/**
 * Every kind of bank a bot can use (docs/playerbots.md, "Banks"): booths, bank chests and
 * bankers. Upstream's bank action only knows booths; spp-bots' bank visit uses any of them, the
 * way a player does: travel to the nearest, click Bank (or Use on a chest), and once the bank is
 * open withdraw or deposit.
 *
 * - Objects: any loc named like a bank booth or chest with a Bank or Use option (not deposit
 *   boxes). Their positions come from the object index Brain.SppBots.js keeps (they're tracked
 *   there, so the index scans for them).
 * - Bankers: NPC spawns whose definition has a Bank option, used across their counter.
 */

const fs = require("fs");
const path = require("path");
const { BLOCKED } = require("./Imports.SppBots");
const { SAVE_DIRECTORY } = require("./Roster.SppBots");

const NPC_SPAWNS_FILE = path.join(process.cwd(), "data", "definitions", "npc-spawns.json");
const BANK_NAME = /\bbank\b/i;
const NOT_A_BANK = /deposit|note|guard|tutor/i;
const BANK_OPTIONS = ["bank", "use"];
/** How long a click may take to open the bank (walking up included), in ms. */
const OPEN_MS = 15000;
const tileKey = (x, y, z) => z * 268435456 + x * 16384 + y;

let objectIds = null;
let banks = null;

/** Loc ids that are banks: booths and chests with a Bank/Use option. */
function bankObjectIds(core) {
  if (objectIds) return objectIds;
  // Not BANK_BOOTH_IDS as it stands: it names every booth, closed and decorative ones too (no options).
  objectIds = new Set();
  const { ObjectDefinition, CacheDefinitions } = core;
  const count = CacheDefinitions.getCounts().objects;
  for (let id = 0; id < count; id++) {
    let definition;
    try {
      definition = ObjectDefinition.forId(id);
    } catch {
      continue;
    }
    const name = String(definition?.getName?.() ?? "");
    if (!BANK_NAME.test(name) || NOT_A_BANK.test(name)) continue;
    const options = (definition.getInteractions?.() ?? []).map((option) => String(option ?? "").toLowerCase());
    if (options.some((option) => BANK_OPTIONS.includes(option))) objectIds.add(id);
  }
  return objectIds;
}

function bankerOption(core, npcId) {
  const actions = core.NpcDefinition.forId(npcId)?.getActions?.() ?? [];
  return actions.findIndex((action) => String(action ?? "").toLowerCase() === "bank");
}

/**
 * Every bank as { kind: "object" | "npc", id, x, y, z, stands: [{ x, y, z }] }: where it is and the
 * tiles a player uses it from.
 */
function allBanks(core, getFlag) {
  if (banks) return banks;
  banks = [];
  const open = (x, y, z) => !(getFlag(x, y, z) & BLOCKED);
  const ids = bankObjectIds(core);
  try {
    const index = JSON.parse(fs.readFileSync(path.join(SAVE_DIRECTORY, "object-index.json"), "utf8"));
    for (const [region, byId] of Object.entries(index.r ?? {})) {
      const baseX = (Number(region) >> 8) << 6;
      const baseY = (Number(region) & 0xff) << 6;
      for (const [id, tiles] of Object.entries(byId)) {
        if (!ids.has(Number(id))) continue;
        for (const [lx, ly, z] of tiles) {
          const x = baseX + lx;
          const y = baseY + ly;
          const stands = [[0, 1], [1, 0], [0, -1], [-1, 0]].map(([dx, dy]) => ({ x: x + dx, y: y + dy, z })).filter((t) => open(t.x, t.y, t.z));
          if (stands.length) banks.push({ kind: "object", id: Number(id), x, y, z, stands });
        }
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("[spp-bots] bank index", error);
  }
  const boothTiles = new Set(banks.map((bank) => tileKey(bank.x, bank.y, bank.z)));
  try {
    for (const spawn of JSON.parse(fs.readFileSync(NPC_SPAWNS_FILE, "utf8"))) {
      if (bankerOption(core, spawn.id) < 0) continue;
      const z = spawn.level ?? 0;
      // Across the counter: a banker is used from the far side of the booth in front of them.
      // The floor behind them is often walkable too, but Bank doesn't work from there. A banker
      // with no counter around them (a camp's) is used from beside them.
      // Best across a bank booth (the floor behind a banker can be open on both sides of a wall).
      const overBooth = [];
      const across = [];
      const beside = [];
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const next = { x: spawn.x + dx, y: spawn.y + dy, z };
        const far = { x: spawn.x + dx * 2, y: spawn.y + dy * 2, z };
        if (open(next.x, next.y, z)) beside.push(next);
        else if (open(far.x, far.y, z)) (boothTiles.has(tileKey(next.x, next.y, z)) ? overBooth : across).push(far);
      }
      const stands = overBooth.length ? overBooth : across.length ? across : beside;
      if (stands.length) banks.push({ kind: "npc", id: spawn.id, name: spawn.name, x: spawn.x, y: spawn.y, z, stands });
    }
  } catch (error) {
    console.error("[spp-bots] bankers", error);
  }
  return banks;
}

/** Tile keys a player banks from (for the planner's bank-visit teleports). */
function bankStandKeys(core, getFlag) {
  const keys = new Set();
  for (const bank of allBanks(core, getFlag)) for (const t of bank.stands) keys.add(tileKey(t.x, t.y, t.z));
  return keys;
}

let banksByStand = null;
// Stands a bank turned out not to work from (the end of a row of booths), for every bot.
const badStands = new Set();

/** The bank can't be used from (x, y, z): no bot is sent to stand there again. */
function markBadStand(x, y, z) {
  badStands.add(tileKey(x, y, z));
}

/**
 * Can `player` use the bank object from where it stands? The server's own reach check for a
 * click (MovementQueue.reachesObject): the loc's shape, rotation and access sides.
 */
function reachesBankObject(core, player, object) {
  const type = object.getType();
  const at = object.getLocation();
  const def = core.ObjectDefinition.forPlayer(object.getId(), player) ?? core.ObjectDefinition.forId(object.getId());
  if (!def) return true;
  if (type === 10 || type === 11 || type === 22) {
    const footprint = type === 22 ? def : (core.ObjectDefinition.forId(object.getId()) ?? def);
    return core.PathFinder.reachedObject(player, at.getX(), at.getY(), footprint.getSizeX(), footprint.getSizeY(), object.getFace(), 10, def.getBlockingMask());
  }
  return core.PathFinder.reachedObject(player, at.getX(), at.getY(), 1, 1, object.getFace(), type, 0);
}

/** The banks used from the tile (x, y, z), or an empty list: for a search to the nearest one. */
function banksAt(core, getFlag, x, y, z) {
  if (!banksByStand) {
    banksByStand = new Map();
    for (const bank of allBanks(core, getFlag)) {
      for (const t of bank.stands) {
        const key = tileKey(t.x, t.y, t.z);
        if (!banksByStand.has(key)) banksByStand.set(key, []);
        banksByStand.get(key).push(bank);
      }
    }
  }
  const key = tileKey(x, y, z);
  return badStands.has(key) ? [] : banksByStand.get(key) ?? [];
}

/**
 * The bank nearest `here` (a floor counts as 15 tiles), or null. With a reach run, only stands it
 * reached count, nearest first (a banker's counter has a reachable side and one behind it).
 */
function nearestBank(core, getFlag, here, avoid = new Set()) {
  const { lastReach, reached } = require("./Reach.SppBots");
  const reach = lastReach();
  let best = null;
  for (const candidate of allBanks(core, getFlag)) {
    if (avoid.has(`${candidate.kind}:${candidate.x},${candidate.y},${candidate.z}`)) continue;
    const stands = reach ? candidate.stands.filter((t) => reached(t.x, t.y, t.z)) : candidate.stands;
    if (!stands.length) continue;
    const bank = { ...candidate, stands: [...stands].sort((a, b) => Math.max(Math.abs(a.x - here.x), Math.abs(a.y - here.y)) - Math.max(Math.abs(b.x - here.x), Math.abs(b.y - here.y))) };
    const distance = Math.max(Math.abs(bank.x - here.x), Math.abs(bank.y - here.y)) + 15 * Math.abs(bank.z - here.z);
    if (!best || distance < best.distance) best = { bank, distance };
  }
  return best?.bank ?? null;
}

/** Withdraws `items` ([{ item, amount }], up to amount in the inventory) from an open bank. */
function withdraw(core, player, items) {
  const { Bank } = core;
  const inventory = player.getInventory();
  for (const { item, amount, noted = false } of items) {
    // `noted`: with the bank's "Note" toggle on, as a player takes a stack of bones out as notes.
    const noteId = noted ? Number(core.ItemDefinition.forId(item)?.getNoteId?.() ?? -1) : -1;
    if (noted && !(noteId > 0)) continue;
    if (noted) player.setNoteWithdrawal(true);
    let remaining = amount - inventory.getAmount(noted ? noteId : item);
    for (let tab = 0; tab < Bank.TOTAL_BANK_TABS && remaining > 0; tab++) {
      const bank = player.getBank(tab);
      const slot = bank?.getSlotForItemId?.(item) ?? -1;
      if (slot < 0) continue;
      const stack = bank.getItems()[slot];
      if (!stack || stack.getId() !== item) continue;
      const take = Math.min(remaining, stack.getAmount());
      Bank.withdraw(player, item, slot, take, tab);
      remaining -= take;
    }
    if (noted) player.setNoteWithdrawal(false);
  }
}

/** Deposits the inventory (or only `ids`) into an open bank. */
function deposit(core, player, ids = null) {
  const { Bank } = core;
  if (!ids) {
    Bank.depositItems(player, player.getInventory(), false);
    return;
  }
  player.getInventory().getItems().forEach((item, slot) => {
    if (item && ids.includes(item.getId())) Bank.deposit(player, item.getId(), slot, item.getAmount(), false);
  });
}

/** The bank's "Deposit worn items": everything worn goes in. */
function depositWorn(core, player) {
  core.Bank.depositItems(player, player.getEquipment(), false);
  player.getEquipment().refreshItems?.();
  player.getUpdateFlag?.()?.flag?.(core.Flag?.APPEARANCE);
}

module.exports = { depositWorn, bankObjectIds, allBanks, bankStandKeys, banksAt, markBadStand, reachesBankObject, nearestBank, bankerOption, withdraw, deposit, OPEN_MS };
