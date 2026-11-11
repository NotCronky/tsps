"use strict";

/**
 * Prayer at a host's gilded altar (docs/playerbots.md, Prayer hosts), the way players do it at
 * Rimmington:
 *
 * - **The host** (a roster bot with role "prayerHost" and a max house moved to Rimmington) stays
 *   online in its house, by the altar, and lights both incense burners again before they go out
 *   (a tinderbox and marrentill). It never leaves (the user's rule): when its marrentill runs low
 *   the pack is topped up on the spot. Its house has no doors, so guests walk straight in.
 * - **A guest** banks for its bones: the coins for Phials, the rest of the stack noted, the pack
 *   filled with unnoted ones. At the Rimmington portal, "Friend's house" and the host's name; the
 *   bones on the altar (the game's own offering loop uses them all); out by the exit portal; the
 *   notes on Phials, "Exchange all"; back in. Until it's out of bones (or coins for Phials, or at
 *   its target level).
 *
 * Every step is a player's click: portal options and the name prompt, Use on the altar and on
 * Phials, the exchange's option, the burner's Light.
 */

const INVENTORY_INTERFACE = 3214;
const RIMMINGTON = { location: 1, portalId: 15478, boardId: 29091, x: 2954, y: 3224, z: 0 };
// Where to stand to click the portal: in front of it.
const PORTAL_STAND = { x: 2953, y: 3221, z: 0 };
const PHIALS = { id: 1614, x: 2950, y: 3212, z: 0 };
const PHIALS_FEE = 5;
// "Exchange all" is the third option of Phials' menu.
const EXCHANGE_ALL = 3;
// Bones best first (by Prayer XP): a guest takes the best it owns.
const BONES = ["DRAGON_BONES", "BABYDRAGON_BONES", "BIG_BONES", "BONES"];
const BONE_XP = { DRAGON_BONES: 72, BABYDRAGON_BONES: 30, BIG_BONES: 15, BONES: 4.5 };
// A burner is relit with this many ticks still to burn (it lasts 200 + Firemaking).
const RELIGHT_TICKS = 25;
const MARRENTILL_STOCK = 27;
const STEP_MS = 15000;
// A guest whose host has stepped out (restocking marrentill takes a minute or two) waits this
// long for it before giving the altar up.
const HOST_WAIT_MS = 180000;
// The garden's exit portal (loc "poh_exit_portal"), should the cache lookup fail.
const EXIT_PORTAL_ID = 4525;

const lower = (value) => String(value ?? "").toLowerCase();

function tileOf(location) {
  return { x: location.getX(), y: location.getY(), z: location.getZ() };
}

function idOf(core, key) {
  const id = core.ItemIds?.[key];
  return Number.isInteger(id) ? id : null;
}

function inHouse(player) {
  const area = player.getPrivateArea?.();
  return Boolean(area && area.constructor?.name === "PlayerHouseInstance");
}

/**
 * The house's exit portal (the garden's, loc "poh_exit_portal"), or null. By id: the house's
 * teleport portals ("Ardougne Portal", option Enter too) share the name and the option, and a
 * guest clicking one of those stands there for good (seen live).
 */
function exitPortal(core, player) {
  const area = player.getPrivateArea?.();
  if (!area) return null;
  const exitId = core.CacheDefinitions?.getLocId?.("poh_exit_portal") ?? EXIT_PORTAL_ID;
  const here = player.getLocation();
  let best = null;
  for (const object of [...(area.furnitureObjects ?? []), ...(area.extraObjects ?? [])]) {
    if (object.getId() !== exitId) continue;
    const at = object.getLocation();
    const distance = Math.max(Math.abs(at.getX() - here.getX()), Math.abs(at.getY() - here.getY()));
    if (!best || distance < best.distance) best = { object, distance };
  }
  return best?.object ?? null;
}

/** The online prayer host (a bot whose roster role is "prayerHost"), or null. */
function onlineHost(population) {
  for (const entry of population.online.values()) if (entry.bot.role === "prayerHost" && entry.hosting) return entry;
  return null;
}

/** Click an object's option as the client does. */
function clickObject(core, player, object, option) {
  const at = object.getLocation();
  new core.ObjectActionPacketListener().executeAction(player, object.getId(), at.getX(), at.getY(), 0, option);
}

/** The portal outside (Rimmington's), live from the map, or null. */
function portalObject(map) {
  // Near the location's tile, not on it: the map has Rimmington's at 2951,3222 (seen live).
  return objectNear(map, RIMMINGTON.portalId);
}

/** An object by id within 12 tiles of the house location's tile, or null. */
function objectNear(map, id) {
  for (let dx = -12; dx <= 12; dx++) {
    for (let dy = -12; dy <= 12; dy++) {
      for (const object of map.objectsAt(RIMMINGTON.x + dx, RIMMINGTON.y + dy, RIMMINGTON.z)) if (object.getId() === id) return object;
    }
  }
  return null;
}

/** The house advertisement board by the Rimmington portal, or null. */
function boardObject(map) {
  return objectNear(map, RIMMINGTON.boardId);
}

function npcById(core, id, near) {
  let found = null;
  core.World.getNpcs().forEach((npc) => {
    if (found || !npc || npc.getId?.() !== id) return;
    const at = npc.getLocation();
    if (Math.max(Math.abs(at.getX() - near.x), Math.abs(at.getY() - near.y)) <= 8) found = npc;
  });
  return found;
}

/**
 * The host's routine: stock up, go home (the portal's "Home"), stand by the altar, keep both
 * burners lit. Never finishes; Population keeps a host online.
 */
function createHostActivity({ api, entry, log = () => {} }) {
  const core = api.core;
  const { createBankVisit, createTravelAction, createMap } = require("./Travel.SppBots");
  const map = createMap(core);
  const state = { phase: "stock" };
  const marrentill = idOf(core, "MARRENTILL");
  const tinderbox = idOf(core, "TINDERBOX");

  /**
   * The pack filled: a tinderbox and MARRENTILL_STOCK marrentill, put straight in (the user's
   * design: the host never leaves its house, so the game can't be its source; it's a roster
   * bot, whose supplies are the simulation's anyway).
   */
  function restock(player) {
    // Once a minute at most (a pack full of something else would otherwise log every tick).
    if (Date.now() < (state.nextRestock ?? 0)) return;
    state.nextRestock = Date.now() + 60000;
    const inventory = player.getInventory();
    const herbs = inventory.getAmount(marrentill);
    const added = { tinderbox: 0, marrentill: 0 };
    if (!inventory.contains(tinderbox) && inventory.getFreeSlots() > 0) inventory.adds(tinderbox, 1), added.tinderbox = 1;
    const room = Math.min(MARRENTILL_STOCK - herbs, inventory.getFreeSlots());
    if (room > 0) inventory.adds(marrentill, room), added.marrentill = room;
    log("spp_bots_host", { name: entry.bot.name, step: "restock", ...added, held: inventory.getAmount(marrentill) });
  }

  /** Something went wrong: say what, wait a minute, start over (a host never gives up). */
  function retry(why) {
    log("spp_bots_host", { name: entry.bot.name, step: "retry", why });
    entry.hosting = false;
    state.visit?.stop?.({ player: entry.player });
    state.visit = null;
    state.travel = null;
    state.clicked = false;
    state.enterTries = 0;
    state.phase = "wait";
    state.until = Date.now() + 60000;
    return "running";
  }

  function update(ctx) {
    const player = ctx.player;
    const nowMs = Date.now();
    const inventory = player.getInventory();
    switch (state.phase) {
      case "stock": {
        if (inventory.getAmount(marrentill) >= 3 && inventory.contains(tinderbox)) {
          state.phase = inHouse(player) ? "tend" : "travel";
          return "running";
        }
        // Short in the house: the host never leaves (the user's rule), so its pack is topped up
        // on the spot. (Before, it went to its bank step inside: a bank search from an instance
        // finds nothing, and it stood there unlit, not hosting, for hours.)
        if (inHouse(player)) {
          restock(player);
          state.phase = "tend";
          return "running";
        }
        state.visit ??= createBankVisit({ api, depositAll: true, withdraw: [{ item: tinderbox, amount: 1 }, { item: marrentill, amount: MARRENTILL_STOCK }], log });
        const result = state.visit.update(ctx);
        if (result === "running") return "running";
        state.visit.stop(ctx);
        state.visit = null;
        // Whatever the bank had (or hadn't): the pack is filled all the same.
        if (inventory.getAmount(marrentill) < MARRENTILL_STOCK || !inventory.contains(tinderbox)) restock(player);
        state.phase = "travel";
        return "running";
      }
      case "travel": {
        if (inHouse(player)) return (state.phase = "tend"), "running";
        state.travel ??= createTravelAction({ api, goal: PORTAL_STAND, log });
        const result = state.travel.update(ctx);
        if (result === "running") return "running";
        state.travel.stop(ctx);
        state.travel = null;
        if (result === "failed") return retry("travel to Rimmington failed");
        state.phase = "enter";
        state.since = nowMs;
        return "running";
      }
      case "wait": {
        // After a failure: a minute's pause, then from the top.
        if (nowMs < state.until) return "running";
        state.phase = "stock";
        return "running";
      }
      case "enter": {
        if (inHouse(player)) {
          entry.hosting = true;
          log("spp_bots_host", { name: entry.bot.name, step: "hosting" });
          return (state.phase = "tend"), "running";
        }
        if (!state.clicked) {
          // Add-House on the board: the house goes on the board and the host goes in (as a host
          // advertises); the portal's Home if the board isn't there.
          const board = boardObject(map);
          if (board) clickObject(core, player, board, "add-house");
          else {
            const portal = portalObject(map);
            if (!portal) return retry("no board or portal at Rimmington");
            clickObject(core, player, portal, "home");
          }
          state.clicked = true;
        }
        if (nowMs - state.since > STEP_MS) {
          if (state.enterTries = (state.enterTries ?? 0) + 1, state.enterTries >= 3) return retry("couldn't get into the house");
          state.clicked = false;
          state.since = nowMs;
        }
        return "running";
      }
      case "tend": {
        if (!inHouse(player)) {
          entry.hosting = false;
          return (state.phase = "travel"), "running";
        }
        entry.hosting = true;
        // Running low: the pack topped up where it stands (never out of the house).
        if (inventory.getAmount(marrentill) < 3) restock(player);
        if (player.busy?.() || nowMs < (state.nextLight ?? 0)) return "running";
        // The burner closest to going out, if it's nearly time.
        const house = player.getPrivateArea();
        const cycle = core.World.getProcessCycle();
        let due = null;
        for (const object of [...(house.furnitureObjects ?? [])]) {
          const name = lower(core.ObjectDefinition.forPlayer(object.getId(), player)?.getName?.());
          if (!name.includes("burner")) continue;
          const at = object.getLocation();
          const furniture = house.getFurnitureAt?.(at, object.getId(), object.getType?.() ?? 10);
          const until = (furniture && house.litBurners?.get(furniture)) ?? 0;
          if (until - cycle > RELIGHT_TICKS) continue;
          if (!due || until < due.until) due = { object, until };
        }
        if (due) {
          clickObject(core, player, due.object, "light");
          state.nextLight = nowMs + 2400;
        }
        return "running";
      }
      default:
        return "running";
    }
  }

  const action = {
    id: "prayerHost",
    update,
    madeProgress: () => true,
    describe: () => ({ host: true, phase: state.phase, hosting: Boolean(entry.hosting) }),
    stop(ctx) {
      state.visit?.stop?.(ctx);
      state.travel?.stop?.(ctx);
      entry.hosting = false;
    },
  };
  return {
    id: "prayer-host", skill: "prayer", resolver: false, resolves: null, mode: "host", capacity: 1, repeat: false,
    ephemeral: false, manual: false, failureCooldownMs: 0, requires: [], setup: [], actions: [action],
    describe: () => action.describe(), produces: [], site: null,
  };
}

/**
 * A guest's Prayer training at the host's altar, to `until` (a Prayer level) or out of bones.
 * `host()` gives the host's name while one is hosting (null otherwise).
 */
function createAltarActivity({ api, entry, host, until = 99, log = () => {}, onDone = () => {} }) {
  const core = api.core;
  const { createBankVisit, createTravelAction, createMap } = require("./Travel.SppBots");
  const map = createMap(core);
  const state = { phase: "bank", trips: 0 };
  let finished = false;
  const finish = (result, why) => {
    if (finished) return;
    finished = true;
    state.result = result;
    log("spp_bots_altar", { name: entry.bot.name, result, why, trips: state.trips, level: prayerLevel(entry.player) });
    onDone(result, why);
  };
  const prayerLevel = (player) => player.getSkillManager().getMaxLevel(core.Skill.PRAYER);
  const items = (player) => player.getInventory().getItems();

  function bonesHeld(player, noted) {
    if (!state.bone) return 0;
    const id = noted ? state.noteId : state.bone;
    return player.getInventory().getAmount(id);
  }

  function update(ctx) {
    const player = ctx.player;
    const nowMs = Date.now();
    if (finished) return state.result;
    if (prayerLevel(player) >= until) return finish("success", "level"), "success";
    const hostName = host();
    if (!hostName && state.phase !== "bank") {
      // The host has stepped out (restocking takes it a minute or two): the other steps go on
      // (offering what's in the pack, leaving, Phials), and at the portal the guest waits for it
      // a while before giving the altar up.
      state.hostGoneAt ??= nowMs;
      if (nowMs - state.hostGoneAt > HOST_WAIT_MS) return finish("failed", "no host"), "failed";
      if (state.phase === "enter") return "running";
    } else if (hostName && state.hostGoneAt) {
      // Back: the portal step clicks afresh.
      state.hostGoneAt = null;
      state.since = nowMs;
      state.clicked = false;
    }
    switch (state.phase) {
      case "bank": {
        if (!state.visit) {
          // The best bones it owns, all of them: coins for Phials, noted the rest, 26 to carry.
          const { owned } = require("./CombatTask.SppBots");
          const have = owned(core, player);
          // Notes count too (the stack a guest carries between trips is one; the bank takes it in
          // as bones): without them a bot back from a trip saw 26 and called the rest "out".
          const noteOf = (id) => Number(core.ItemDefinition.forId(id)?.getNoteId?.() ?? -1);
          const count = (name) => {
            const id = idOf(core, name);
            return (have.get(id) ?? 0) + (noteOf(id) > 0 ? have.get(noteOf(id)) ?? 0 : 0);
          };
          // The kind worth the most Prayer XP in all (a big stack of big bones over a few dragon
          // bones), as a player would bring.
          const key = BONES.filter((name) => count(name) > 0)
            .sort((a, b) => count(b) * BONE_XP[b] - count(a) * BONE_XP[a])[0];
          if (!key) return finish("failed", "no bones"), "failed";
          state.bone = idOf(core, key);
          state.noteId = noteOf(state.bone);
          const total = count(key);
          const carried = Math.min(26, total);
          const noted = total - carried;
          const coins = Math.min(have.get(idOf(core, "COINS")) ?? 0, noted * PHIALS_FEE);
          const withdraw = [];
          if (coins > 0) withdraw.push({ item: idOf(core, "COINS"), amount: coins });
          if (noted > 0) withdraw.push({ item: state.bone, amount: noted, noted: true });
          withdraw.push({ item: state.bone, amount: carried });
          state.visit = createBankVisit({ api, depositAll: true, withdraw, log });
          log("spp_bots_altar", { name: entry.bot.name, step: "bank", bones: key, total, noted, coins });
        }
        const result = state.visit.update(ctx);
        if (result === "running") return "running";
        state.visit.stop(ctx);
        state.visit = null;
        if (result === "failed" || bonesHeld(player, false) === 0) return finish("failed", "bank"), "failed";
        state.phase = "travel";
        return "running";
      }
      case "travel": {
        state.travel ??= createTravelAction({ api, goal: PORTAL_STAND, log });
        const result = state.travel.update(ctx);
        if (result === "running") return "running";
        state.travel.stop(ctx);
        state.travel = null;
        if (result === "failed") return finish("failed", "travel"), "failed";
        state.phase = "enter";
        state.since = nowMs;
        state.clicked = false;
        return "running";
      }
      case "enter": {
        if (inHouse(player)) {
          state.trips += 1;
          state.phase = "offer";
          state.since = nowMs;
          state.offered = false;
          log("spp_bots_altar", { name: entry.bot.name, step: "in", trip: state.trips, owner: player.getPrivateArea()?.owner?.getUsername?.() ?? null, bones: bonesHeld(player, false), noted: bonesHeld(player, true) });
          return "running";
        }
        if (!state.clicked) {
          // The advertisement board's View, then the host's row (the board takes the clicked row's
          // name through the name prompt); the portal's "Friend's house" and the name on the second
          // try, or if there's no board. (Phials' last word, "converts your banknotes", is still
          // up after a trip.)
          player.getDialogueManager?.()?.reset?.();
          player.getPacketSender().sendInterfaceRemoval();
          const board = boardObject(map);
          const portal = portalObject(map);
          const tries = state.enterTries ?? 0;
          // Back from Phials: the board's Visit-Last (the user's suggestion), no name to type.
          const again = state.trips > 0;
          if (board && tries % 2 === 0) clickObject(core, player, board, again ? "visit-last" : "view");
          else if (portal) clickObject(core, player, portal, "friend's house");
          else if (board) clickObject(core, player, board, again ? "visit-last" : "view");
          else return finish("failed", "no board or portal"), "failed";
          state.clicked = true;
          state.typedAt = nowMs + 1800;
          return "running";
        }
        // The name, once the prompt is up: the walk to the board takes a few ticks more from
        // Phials' side than from the portal's (a single look 1.8 s after the click missed it).
        if (state.typedAt && nowMs >= state.typedAt) {
          const prompt = player.getEnteredSyntaxAction?.();
          if (prompt) {
            state.typedAt = null;
            player.setEnteredSyntaxAction?.(null);
            prompt.execute(hostName);
          }
        }
        if (nowMs - state.since > STEP_MS) {
          // Not in: the host left, or the click didn't land. The other way in, then give up.
          state.enterTries = (state.enterTries ?? 0) + 1;
          if (state.enterTries >= 3) return finish("failed", "couldn't enter"), "failed";
          log("spp_bots_altar", { name: entry.bot.name, step: "enter again", tries: state.enterTries, at: tileOf(player.getLocation()) });
          state.clicked = false;
          state.since = nowMs;
        }
        return "running";
      }
      case "offer": {
        if (!inHouse(player)) return (state.phase = "unnote"), "running";
        // The wrong house (its own): out again, and the board next time.
        const owner = player.getPrivateArea()?.owner?.getUsername?.();
        if (owner && hostName && lower(owner) !== lower(hostName)) {
          log("spp_bots_altar", { name: entry.bot.name, step: "wrong house", owner });
          state.wrongHouse = true;
          state.phase = "leave";
          state.since = nowMs;
          state.clicked = false;
          return "running";
        }
        if (bonesHeld(player, false) === 0) {
          state.phase = "leave";
          state.since = nowMs;
          state.clicked = false;
          return "running";
        }
        // Use a bone on the altar once; the game's offering loop takes the rest. Again if it stalls.
        if (state.offered && nowMs - state.since < STEP_MS && !player.busy?.()) {
          if (state.lastCount === bonesHeld(player, false) && nowMs - state.since > 6000) state.offered = false;
          return "running";
        }
        if (state.offered && player.busy?.()) return "running";
        const altar = map.instanceObject(player, /altar/i, "pray");
        if (!altar) return finish("failed", "no altar"), "failed";
        const slot = items(player).findIndex((item) => item?.getId?.() === state.bone);
        if (slot < 0) return "running";
        const at = altar.getLocation();
        core.UseItemPacketListener.itemOnObject(player, INVENTORY_INTERFACE, altar.getId(), state.bone, slot, at.getX(), at.getY());
        state.offered = true;
        state.since = nowMs;
        state.lastCount = bonesHeld(player, false);
        return "running";
      }
      case "leave": {
        if (!inHouse(player) && state.wrongHouse) {
          state.wrongHouse = false;
          state.phase = "enter";
          state.since = nowMs;
          state.clicked = false;
          return "running";
        }
        if (!inHouse(player)) {
          if (bonesHeld(player, true) === 0) return finish("success", "out of bones"), "success";
          state.phase = "unnote";
          state.since = nowMs;
          state.clicked = false;
          return "running";
        }
        if (player.busy?.()) return "running";
        if (!state.clicked || nowMs - state.since > STEP_MS) {
          // The garden's exit portal by id: the house's teleport portals have Enter too, and the
          // nearest "portal" from the chapel was the Ardougne one (the guest stood at it for good).
          const exit = exitPortal(core, player);
          if (!exit) return finish("failed", "no exit portal"), "failed";
          if (!state.clicked) log("spp_bots_altar", { name: entry.bot.name, step: "leave", trip: state.trips, noted: bonesHeld(player, true), coins: player.getInventory().getAmount(idOf(core, "COINS")) });
          clickObject(core, player, exit, "enter");
          state.clicked = true;
          state.since = nowMs;
        }
        return "running";
      }
      case "unnote": {
        if (bonesHeld(player, false) > 0) {
          state.phase = "enter";
          state.since = nowMs;
          state.clicked = false;
          state.enterTries = 0;
          return "running";
        }
        if (bonesHeld(player, true) === 0) return finish("success", "out of bones"), "success";
        if (player.getInventory().getAmount(idOf(core, "COINS")) < PHIALS_FEE) {
          // Seen live: the trip back from the bank paid a 30 gp fare out of the Phials money.
          if ((state.rebanks = (state.rebanks ?? 0) + 1) > 5) return finish("success", "out of coins for Phials"), "success";
          log("spp_bots_altar", { name: entry.bot.name, step: "rebank", why: "coins", noted: bonesHeld(player, true) });
          state.visit = null;
          state.phase = "bank";
          return "running";
        }
        const dialogue = player.getDialogueManager();
        if (state.used && dialogue.isActive?.()) {
          dialogue.handleOption(EXCHANGE_ALL);
          state.used = false;
          return "running";
        }
        if (state.used && nowMs - state.since < STEP_MS) return "running";
        const phials = npcById(core, PHIALS.id, PHIALS);
        if (!phials) return finish("failed", "no Phials"), "failed";
        const slot = items(player).findIndex((item) => item?.getId?.() === state.noteId);
        log("spp_bots_altar", { name: entry.bot.name, step: "phials", trip: state.trips, noted: bonesHeld(player, true), coins: player.getInventory().getAmount(idOf(core, "COINS")) });
        core.UseItemPacketListener.itemOnNpc(player, INVENTORY_INTERFACE, phials.getIndex(), state.noteId, slot);
        state.used = true;
        state.since = nowMs;
        return "running";
      }
      default:
        return "running";
    }
  }

  const action = {
    id: "houseAltar",
    update,
    madeProgress: () => true,
    describe: () => ({ altar: true, phase: state.phase, trips: state.trips, bone: state.bone ?? null }),
    stop(ctx) {
      state.visit?.stop?.(ctx);
      state.travel?.stop?.(ctx);
      finish("failed", "stopped");
    },
  };
  return {
    id: "train:prayer:altar", skill: "prayer", resolver: false, resolves: null, mode: "training", capacity: 1, repeat: false,
    ephemeral: false, manual: false, failureCooldownMs: 0, requires: [], setup: [], actions: [action],
    describe: () => action.describe(), produces: [], site: null,
  };
}

// The plugin sets how to find the hosting bot's name (Population's online entries).
let hostLookup = () => null;
function setHostLookup(lookup) {
  hostLookup = lookup;
}
function hostName() {
  return hostLookup();
}

module.exports = { createHostActivity, createAltarActivity, onlineHost, setHostLookup, hostName, exitPortal, RIMMINGTON, BONES };
