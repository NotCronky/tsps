"use strict";

/**
 * The Gauntlet played by a bot, for the player bots' Gauntlet tasks ("gauntlet:play" { player,
 * corrupted?, controller }: the regular Gauntlet, or with `corrupted` the Corrupted one; a
 * controller whose tick() plays a tick and says whether it's still playing, and stop()). It plays
 * as a player does, through the Gauntlet's own code: every gathering node, station and barrier is
 * clicked with its option, the singing bowl's menu answered, the Hunllef fought with the weapons
 * it made.
 *
 * It follows the Wiki's standard strategy (The Gauntlet/Strategies), the same in both modes:
 * - The lobby: anything carried goes in the deposit box, a waiting reward is taken from the
 *   chest (and deposited), and a run begins at the entrance (Bryn's warning heard the first time).
 * - Run 1: the "C" round the start room (the seven rooms about it, the boss room the gap), killing
 *   the weak monsters for a weapon frame and about 100 shards (at most RUN1_TICKS), and gathering
 *   in each room what its goals need (not the Wiki's: run 1 there only kills).
 * - Home: the staff sung and attuned, and the vials.
 * - Run 2: straight out to the rim and a lap of it, gathering in every room on the way what it
 *   still needs (fish, the ore, bark and linum for its armour, a grym leaf a potion; the vials
 *   filled at the fishing spots, the leaves put in and the potions finished as it goes), killing
 *   the dark beast and the dragon for the bowstring and the orb (the demi-bosses wait on the rim),
 *   and the monsters while it's short of shards or of its second frame. With everything, the
 *   teleport crystal home. A full pack is a trip home (the raw fish left by the range) and back.
 * - The finish (everything found, or only the time left that the finish needs, finishTicks; it
 *   drops whatever it's at): the bow sung and attuned, both weapons perfected, its armour (basic;
 *   attuned in the Corrupted Gauntlet), the Egniol potions (two; three in the Corrupted Gauntlet),
 *   the tools and leftovers dropped, the fish cooked, all worn; then through the barrier.
 * - The Hunllef: auto-prayer ("combat:autopray-set") keeps the right protection and the weapon's
 *   offensive prayer up (with no Egniol left and prayer low, protection only). The 5:1 method:
 *   five attacks with its main weapon, then the sixth with the other (the Hunllef protecting
 *   against melee) or an unarmed kick (protecting against the other), so it never protects
 *   against the main one. The main weapon is the staff (here it hits harder than the bow), the bow
 *   when it's the higher tier; the bow on Rapid. It keeps off the floor's lit tiles, out of the
 *   corners and from under the Hunllef, walking past tornadoes rather than stand on the floor,
 *   attacking between steps (eating doesn't stop a step); with no tile clear, the least bad. It
 *   eats below half health and drinks when its prayer runs low.
 *
 * Not the Wiki's: Vengeance and Redemption (a bot has neither), restarting a run that starts on
 * Protect from Missiles (the main weapon's partner turns it instead), the bow as the main weapon
 * (the staff hits harder here), and the final phase's safe tiles (bestTile).
 *
 * Then back to the lobby for the next run, until the task stops it.
 */
const Shared = require("./Shared.Gauntlet");
const Run = require("./RunState.Gauntlet");
const Items = require("./Items.Gauntlet");
const Resources = require("./Resources.Gauntlet");
const Monsters = require("./Monsters.Gauntlet");
const Rewards = require("./Rewards.Gauntlet");
const GauntletMap = require("./Map.Gauntlet");
const Commands = require("./Commands.Gauntlet");

const ATTR_SPOKEN_TO_BRYN = "gauntlet:spoken-to-bryn";
// The lobby's reward chest (a multiloc: its ids by state), deposit box and entrance, on their tiles.
const LOBBY_CHESTS = [[37341, 3027, 6123], [36087, 3027, 6123], [35988, 3027, 6123]];
const DEPOSIT_BOX = [36086, 3038, 6129];
const ENTRANCE = [37340, 3032, 6128];
const CURRENT_PET_ATTRIBUTE = "pets:current";
// Fish it takes into the fight (raw, cooked and stashed by the range all count).
const FOOD = { regular: 17, corrupted: 24 };
// Going in short (fewer cooked fish than this, armour under its goal, or a weapon unperfected), it
// uses ::gauntletgear: perfected bow and staff, attuned armour, potions and a pack of fish for the fight (the run takes
// them when it ends). A cheat, asked for by the server's owner. 16 is where test runs' win rate
// fell off (under it, 56%).
const SHORT_FOOD = { regular: 12, corrupted: 16 };
// A trip home this many rooms out or more takes the teleport crystal; nearer, it walks.
const TELEPORT_ROOMS = 3;
// Egniol potions it makes (prayer for the maze and the Hunllef), and their doses' ids.
// Egniol potions: the Wiki's two, and in the Corrupted Gauntlet a third.
const POTIONS = { regular: 2, corrupted: 3 };
// The armour tier (0 basic, 1 attuned, 2 perfected) it gathers materials and shards for: basic,
// the Wiki's standard setup; attuned in the Corrupted Gauntlet (the Wiki's "3-7" materials: its
// hits through prayer are most of the damage, and attuned armour takes a quarter off them; in
// test runs it won 73% to basic's 61%). It still sings a higher tier when what it holds pays.
const ARMOUR_GOAL = { regular: 0, corrupted: 1 };
// Run 1 ends early with a frame and this many shards (the Wiki: a frame and about 100).
const RUN1_SHARDS = 100;
// Run 1 ends after this many ticks whatever it has (a character weak in melee, the sceptre's
// style, kills slowly; the rest of the prep is what it needs most).
const RUN1_TICKS = 250;
// Its doses by id: 4, 3, 2 and 1 dose(s).
const EGNIOL = [23885, 23884, 23883, 23882];
// Start-room steps before it goes through the barrier whatever is left (nothing loops forever).
const MAKE_STEPS = 400;
// The finish's time, estimated (finishTicks), in ticks: a room walked, a raw fish picked up and
// cooked, a song at the bowl, a potion made, and the rest (the tools dropped, the walk to the
// barrier) with a margin. It heads back with that much prep left: as late as it can (in test runs
// going back later won more, the time spent on its armour's and weapons' last pieces). Fitted to
// test runs' finishes (about 26 ticks besides, 1.5 a fish, 1 a song) with a margin of two of
// their spreads; a smaller one is dragged into the fight before it has cooked.
const FINISH = { ROOM: 9, TELEPORT: 4, FISH: 1.5, SONG: 1.5, POTION: 12, REST: 40 };
// Shards kept back for the Egniol potion: a vial and the dust.
const POTION_SHARDS = 20;
// Shards that attune a basic weapon.
const ATTUNE_SHARDS = 50;
// Raw fish dropped a tick at the stash.
const DROPS_PER_TICK = 3;
// Shards kept above what the materials in hand will cost: a teleport crystal and a little over.
const SHARD_MARGIN = 100;
// Clicks on one gathering node before it's given up as out of reach.
const NODE_TRIES = 6;
const ROOM = GauntletMap.ROOM_TILES;
// Weapons and the style each attacks with.
const WEAPONS = [["staff", "magic"], ["bow", "ranged"], ["halberd", "melee"]];
// The weapon each demi-boss's component perfects.
const COMPONENT_WEAPON = { orb: "staff", bowstring: "bow", spike: "halberd" };
// Its weapons: the staff (made and attuned after run 1), and the bow; both perfected.
const PLAN = ["staff", "bow"];
// The 5:1 method: this many attacks with the main weapon, then one of another style.
const BOW_ATTACKS = 5;
// A tornado this close is too close.
const TORNADO_TILES = 2;
// Stand within this of the Hunllef, inside the staff's and bow's range.
const FIGHT_RANGE = 7;
// Melee reach from the Hunllef's body: the halberd's, and a kick's.
const HALBERD_REACH = 2;
const KICK_REACH = 1;
// A dodge tile in a corner of the arena counts as this many tiles further off.
const CORNER_COST = 4;
// What a tile costs to stand on, in tiles of walking (bestTile).
const COST = { BURNING: 1000, LIT: 100, TORNADO_NEXT: 30, TORNADO_NEAR: 10, CROSS_BURNING: 15, CROSS_UNDER: 60, REACH: 12 };
const EAT_BELOW = 0.55;
const PREP_EAT_BELOW = 0.4;
// A demi-boss is fought from this much health, with this many fish to hand.
const DEMI_FIT = 0.7;
const DEMI_FOOD = 0;
// Ticks at most it waits where a monster died for its drop (it lands as the death animation
// ends; the wait is over as soon as it's picked up).
const DROP_WAIT = 3;
// Slots kept free while gathering, for what the bowl, the pump and the pestle make.
const ROOM_TO_MAKE = 4;
// On run 2 (nothing made in the field but filled vials): the one slot kept free.
const FIELD_ROOM = 1;
// A full pack with nothing else missing but this many fish or fewer: done, not a trip home.
const FISH_SLACK = 1;
const DRINK_BELOW = 20;
// With no Egniol left, prayer points below which it keeps only its protection prayer up.
const SAVE_PRAYER_BELOW = 30;
// Run back on (as the run orb does) once its energy is back to this many percent.
const RUN_BACK_ON = 15;

const cycle = () => Shared.core().World.getProcessCycle();
const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));
const inv = (player) => player.getInventory();
const count = (player, id) => inv(player).getAmount(id);
const has = (player, id) => count(player, id) > 0 || player.getEquipment().contains(id);
const stacks = (id) => Shared.core().ItemDefinition.forId(id)?.isStackable?.() === true;
const slotOf = (player, id) => inv(player).getItems().findIndex((item) => item?.getId?.() === id);

/** The object as the player sees it (a multiloc, such as the barrier, shows by their varbits). */
function definitionFor(player, object) {
  return Shared.core().ObjectDefinition?.forPlayer?.(object.getId(), player) ?? object.getDefinition?.();
}

/** Clicks an object's option through the plugins, as a player's click on it does. */
function use(player, object, option, after) {
  const definition = definitionFor(player, object);
  const clickType = (definition?.getActions?.() ?? definition?.getInteractions?.() ?? []).indexOf(option) + 1;
  if (clickType <= 0) return false;
  const at = object.getLocation();
  player.getMovementQueue().walkToObject(object, {
    execute: () => {
      Shared.api().emitObjectInteraction({
        player, object, objectId: object.getId(), clickType, definition,
        location: { x: at.getX(), y: at.getY(), z: at.getZ() },
        sourceLocation: { x: player.getLocation().getX(), y: player.getLocation().getY(), z: player.getLocation().getZ() },
        handled: false,
      });
      after?.();
    },
  }, clickType);
  return true;
}

/** One item on another in the inventory, as a player's use does. */
function combine(player, a, b) {
  const first = slotOf(player, a);
  const second = slotOf(player, b);
  if (first < 0 || second < 0) return false;
  Shared.core().UseItemPacketListener.itemOnItem(player, first, second);
  return true;
}

/** An inventory item's first option (eat, drink). */
function click(player, id) {
  const slot = slotOf(player, id);
  if (slot < 0) return false;
  const { ItemActionPacketListener, Inventory } = Shared.core();
  ItemActionPacketListener.handleAction(player, Inventory.INTERFACE_ID, id, slot, 1);
  return true;
}

function wear(player, id) {
  const slot = slotOf(player, id);
  if (slot < 0) return;
  const { EquipPacketListener, Inventory } = Shared.core();
  EquipPacketListener.equip(player, id, slot, Inventory.INTERFACE_ID);
}

/**
 * The bot's play for one character: `corrupted` plays the Corrupted Gauntlet (its entrance option,
 * open once a Gauntlet has been completed), else the regular one.
 */
function createController(player, { corrupted = false } = {}) {
  const bot = {
    waitUntil: 0,
    visited: new Set(),
    makeSteps: 0,
    trip: false,
    heading: null,
    runs: 0,
    autopray: null,
    offensive: false,
    // The resource (its item key) the node it's at yields: gathering stops once it has enough.
    gathering: null,
    run: null,
    retaliate: null,
    lootTarget: null,
    // The monster it last fought ({ npc, room, diedAt }): waited on for its drop.
    lastTarget: null,
    // Done preparing: making its gear and going in, not back out into the maze.
    finishing: false,
    // Where it is in the Wiki's plan: "run1" (the C), "home1" (staff and vials), "run2" (out and round the rim).
    phase: "run1",
    // The rooms of the run it's on, in order, and the next one to go to.
    route: [],
    routeIndex: 0,
    // The 5:1 method's count: off-prayer attacks thrown since the Hunllef last switched.
    fiveOne: { pending: [], landed: 0, lastDelay: 0, style: null, skip: false },
    // What it has dropped in the field: not picked up again.
    dropped: new Set(),
    nodeTries: new Map(),
    // The run whose fight it checked its gear for, and what it was short of (null: nothing).
    checked: null,
    geared: null,
  };
  const wait = (ticks) => { bot.waitUntil = cycle() + ticks; };
  /** What it's at, for ::botmode status. */
  const step = (what) => { bot.step = what; };
  // Gathering, filling or cooking: the station's loop (a finished one stays behind, stopped).
  const working = () => player.__gauntletGathering?.isRunning?.() === true;
  const busy = () => player.getMovementQueue().size() > 0 || working() || cycle() < bot.waitUntil;

  /** Auto-prayer on (with or without the offensive prayers), remembering how it was to put it back. */
  function autopray(on, offensive) {
    const request = { player, on, offensive, was: false, wasOffensive: true };
    Shared.api().emitCustomEvent("combat:autopray-set", request);
    if (on && bot.autopray === null) bot.autopray = { on: request.was, offensive: request.wasOffensive };
  }

  /** Run switched back on once there's energy for it (it goes off at none), as clicking the orb does. */
  function keepRunning() {
    if (player.isRunningReturn?.() !== false || player.getRunEnergy() < RUN_BACK_ON) return;
    player.setRunning(true);
    player.getPacketSender().sendRunStatus?.();
    Shared.api().emitCustomEvent("player:run-toggled", { player, running: true });
  }

  /** What it goes into the fight short of (none: an empty list): too few fish, armour, a weapon. */
  function shortfall(run) {
    const items = Items.itemsFor(run.mode);
    const short = [];
    if (count(player, items.paddlefish) < SHORT_FOOD[run.mode]) short.push("food");
    const tierOf = (piece) => Math.max(...items[piece].map((id, index) => (has(player, id) ? index : -1)));
    if (["helm", "body", "legs"].some((piece) => tierOf(piece) < ARMOUR_GOAL[run.mode])) short.push("armour");
    if (PLAN.some((name) => !has(player, items[name][2]))) short.push("weapons");
    return short;
  }

  function restorePrayer() {
    if (bot.autopray === null) return;
    const { on, offensive } = bot.autopray;
    bot.autopray = null;
    Shared.api().emitCustomEvent("combat:autopray-set", { player, on, offensive });
  }

  // -------------------------------------------------------------- the lobby

  function inLobby() {
    const at = player.getLocation();
    const zone = Shared.LOBBY_ZONE;
    return at.getX() >= zone.minX && at.getX() <= zone.maxX && at.getY() >= zone.minY && at.getY() <= zone.maxY && zone.levels.includes(at.getZ());
  }

  function deposit() {
    const { Bank } = Shared.core();
    if (inv(player).getValidItems().length > 0) Bank.depositItems(player, inv(player), true);
    if (player.getEquipment().getValidItems().length > 0) Bank.depositItems(player, player.getEquipment(), true);
    inv(player).refreshItems();
    player.getEquipment().refreshItems();
  }

  /** A lobby object (the reward chest, the deposit box, the entrance) on its tile. */
  function lobbyObject(id, x, y) {
    const { MapObjects, Location } = Shared.core();
    return MapObjects.get(id, new Location(x, y, Shared.LOBBY.z), null) ?? null;
  }

  /**
   * In the lobby, walked as a player does: to the reward chest to take a waiting reward, to the
   * deposit box with whatever it carries, then to the entrance and in. Each is a walk, so there's
   * time to see a run's end and stop before the next.
   */
  function lobby() {
    if (!inLobby()) {
      const portal = Shared.loc(Shared.PRIFDDINAS);
      if (player.getLocation().getZ() !== portal.getZ() || chebyshev(player.getLocation(), portal) > 12) return false;
      // Down the Gauntlet Portal, as its Enter does.
      Shared.fadeMove(player, () => player.moveTo(Shared.loc(Shared.LOBBY_ENTRY)));
      wait(4);
      return true;
    }
    if (player.getAttribute(CURRENT_PET_ATTRIBUTE)) return false;
    const carrying = inv(player).getValidItems().length + player.getEquipment().getValidItems().length > 0;
    if (Rewards.waitingReward(player) && inv(player).getFreeSlots() > 0) {
      const chest = LOBBY_CHESTS.map(([id, x, y]) => lobbyObject(id, x, y)).find(Boolean);
      if (chest && use(player, chest, "Open")) {
        wait(3);
        return true;
      }
      Rewards.openChest(player);
      wait(2);
      return true;
    }
    if (carrying) {
      const box = lobbyObject(...DEPOSIT_BOX);
      if (box) player.getMovementQueue().walkToObject(box, { execute: () => deposit() });
      else deposit();
      wait(3);
      return true;
    }
    // Bryn's first talk, which the entrance asks for.
    player.setAttribute(ATTR_SPOKEN_TO_BRYN, true);
    // The Corrupted Gauntlet only once a Gauntlet has been completed: not open, nothing to play.
    if (corrupted && !Run.hasCompleted(player)) return false;
    const entrance = lobbyObject(...ENTRANCE);
    if (!entrance || !use(player, entrance, corrupted ? "Enter-corrupted" : "Enter")) Run.startRun(player, { corrupted });
    wait(4);
    return true;
  }

  /** A run it has just gone into: fresh plans, and prayer up against the maze's monsters. */
  function begin(run) {
    bot.run = run;
    bot.visited.clear();
    bot.nodeTries.clear();
    bot.makeSteps = 0;
    bot.trip = false;
    bot.heading = null;
    bot.lastTarget = null;
    bot.finishing = false;
    bot.leftOff = false;
    bot.phase = "run1";
    bot.route = cRoute(run);
    bot.routeIndex = 0;
    bot.fiveOne = { pending: [], landed: 0, lastDelay: 0, style: null, skip: false };
    bot.dropped.clear();
    bot.runs += 1;
    // In the maze it prays against the monsters, protection only: the points are for the Hunllef.
    autopray(true, false);
    bot.offensive = false;
    if (bot.retaliate === null) bot.retaliate = player.autoRetaliateReturn?.() !== false;
  }

  /** Auto-retaliate as the player had it, once the maze no longer needs it off. */
  function restoreRetaliate() {
    if (bot.retaliate === null) return;
    player.setAutoRetaliate?.(bot.retaliate);
    bot.retaliate = null;
  }

  // -------------------------------------------------------------- preparing

  function roomObjects(run, room, accept) {
    const map = run.map;
    const found = map.getObjects().filter((object) => map.roomAt(object.getLocation()) === room && accept(object));
    for (let x = 0; x < ROOM; x++) {
      for (let y = 0; y < ROOM; y++) {
        for (const object of map.getTemplateObjects(map.roomTile(room, x, y))) if (accept(object)) found.push(object);
      }
    }
    return found;
  }

  const nearest = (list) => list.sort((a, b) => chebyshev(a.getLocation(), player.getLocation()) - chebyshev(b.getLocation(), player.getLocation()))[0] ?? null;
  const named = (name) => (object) => definitionFor(player, object)?.getName?.() === name;

  /**
   * How many more of a resource (by its item key) its goals need: what the armour still to make
   * takes (each piece up to perfected) less what it holds; fish up to FOOD (raw and cooked); a grym
   * leaf until it has the potion or its makings.
   */
  function stillNeeded(run, key) {
    const items = Items.itemsFor(run.mode);
    if (key === "rawPaddlefish") return Math.max(0, FOOD[run.mode] - count(player, items.rawPaddlefish) - count(player, items.paddlefish) - stash(run).length);
    if (key === "grymLeaf") return Math.max(0, potionsNeeded() - count(player, items.grymLeaf) - count(player, items.grymPotion));
    if (!["ore", "bark", "linum"].includes(key)) return 0;
    let need = 0;
    for (const piece of ["helm", "body", "legs"]) {
      // The tier it has (-1 none), and every tier after it up to perfected still to pay for.
      const tier = Math.max(...items[piece].map((id, index) => (has(player, id) ? index : -1)));
      Items.ARMOUR_COST[piece].forEach((cost, index) => { if (index > tier && index <= ARMOUR_GOAL[run.mode]) need += cost.each; });
    }
    return Math.max(0, need - count(player, items[key]));
  }

  /** Potions on the way (an empty or filled vial, a grym potion). */
  function potionsUnderWay(items) {
    return count(player, items.grymPotion) + count(player, items.vial) + count(player, items.waterVial);
  }

  /** Egniol potions made (any doses left). */
  function potions() {
    return EGNIOL.reduce((sum, id) => sum + count(player, id), 0);
  }

  /** Egniol potions made this run (the run counts them). */
  const made = () => bot.run?.made?.egniol ?? 0;

  /** Potions still to make this run (made at the finish). */
  function potionsNeeded() {
    return Math.max(0, (POTIONS[bot.run?.mode] ?? POTIONS.regular) - made());
  }

  /**
   * The ticks the finish will take from here: home (the teleport crystal, or room by room), each
   * raw fish picked up and cooked, the songs at the bowl still to sing (the armour to its goal, the
   * weapons to perfected), the potions still to make, and the rest.
   */
  function finishTicks(run, room) {
    const items = Items.itemsFor(run.mode);
    const start = startRoom(run);
    const crystal = Run.items()[run.mode].teleportCrystal;
    const rooms = gridSteps(room, start);
    // Walking home goes through lit rooms, often further than the straight way.
    const travel = rooms === 0 ? 0 : count(player, crystal) > 0 && rooms >= TELEPORT_ROOMS ? FINISH.TELEPORT : litSteps(run, room, start) * FINISH.ROOM;
    const fish = count(player, items.rawPaddlefish) + stash(run).length;
    let songs = 0;
    for (const piece of ["helm", "body", "legs"]) {
      const tier = Math.max(...items[piece].map((id, index) => (has(player, id) ? index : -1)));
      songs += Math.max(0, ARMOUR_GOAL[run.mode] - tier);
    }
    for (const name of PLAN) {
      const tier = Math.max(...items[name].map((id, index) => (has(player, id) ? index : -1)));
      songs += 2 - tier;
    }
    return travel + fish * FINISH.FISH + songs * FINISH.SONG + potionsNeeded() * FINISH.POTION + FINISH.REST;
  }

  /** Whether nothing is missing but FISH_SLACK fish or fewer. */
  function nearlyDone(run) {
    const others = ["ore", "bark", "linum", "grymLeaf"].every((key) => stillNeeded(run, key) === 0)
      && weapons(run).length >= 2 && !componentsWanted(run);
    return others && stillNeeded(run, "rawPaddlefish") <= FISH_SLACK;
  }

  /**
   * On run 2, a grym leaf in a water-filled vial as soon as it has both (a player can anywhere):
   * one slot where there were two.
   */
  function mixLeaves(run) {
    if (bot.phase !== "run2") return false;
    const items = Items.itemsFor(run.mode);
    if (count(player, items.grymLeaf) > 0 && count(player, items.waterVial) > 0) {
      combine(player, items.grymLeaf, items.waterVial);
      wait(2);
      return true;
    }
    // Then the potion finished there too (the dust ground and added: neither needs the start
    // room), so the finish has less to do, and goes later.
    if (count(player, items.grymPotion) <= 0 || potionsNeeded() <= 0) return false;
    if (count(player, items.dust) >= Items.DUST_PER_POTION) {
      combine(player, items.dust, items.grymPotion);
      wait(2);
      return true;
    }
    if (count(player, items.pestle) > 0 && count(player, items.shards) >= Items.DUST_PER_POTION
      && (count(player, items.dust) > 0 || inv(player).getFreeSlots() > 0)) {
      combine(player, items.pestle, items.shards);
      wait(2);
      return true;
    }
    return false;
  }

  /** Slots kept free: room to make things at home; on run 2, only the one. */
  const roomToKeep = () => (bot.phase === "run2" && !bot.trip ? FIELD_ROOM : ROOM_TO_MAKE);

  /**
   * On run 2, what it no longer needs goes on the floor, for room in the pack: the sceptre once
   * it holds a staff, and each tool once what it gathers is enough (the pickaxe the ore, the axe
   * the bark, the harpoon the fish).
   */
  function dropSpent(run) {
    if (bot.phase !== "run2") return false;
    const items = Items.itemsFor(run.mode);
    const spent = [
      [items.sceptre, items.staff.some((id) => player.getEquipment().contains(id))],
      [items.pickaxe, stillNeeded(run, "ore") === 0],
      [items.axe, stillNeeded(run, "bark") === 0],
      [items.harpoon, stillNeeded(run, "rawPaddlefish") === 0],
    ].find(([id, done]) => done && count(player, id) > 0);
    if (!spent) return false;
    drop(spent[0]);
    bot.dropped.add(spent[0]);
    wait(1);
    return true;
  }

  /** What it would gather now: what it needs, while the pack keeps room for making. */
  function wanted(run, key) {
    if (inv(player).getFreeSlots() <= roomToKeep()) return 0;
    return stillNeeded(run, key);
  }

  /** Whether its goals still need more from the maze (a full pack doesn't make it done). */
  function needsMore(run) {
    return ["ore", "bark", "linum", "rawPaddlefish", "grymLeaf"].some((key) => stillNeeded(run, key) > 0) || weapons(run).length < 2
      || componentsWanted(run);
  }

  /** Weapons it holds or can make, by name. */
  function weapons(run) {
    const items = Items.itemsFor(run.mode);
    return WEAPONS.filter(([name]) => items[name].some((id) => has(player, id))).map(([name]) => name);
  }

  /**
   * A demi-boss worth fighting: the dragon for the staff's orb, the dark beast for the bow's
   * bowstring, while it still needs that one and is armed and fit for it.
   */
  function demiWanted(run, monster) {
    const items = Items.itemsFor(run.mode);
    const weapon = COMPONENT_WEAPON[monster?.component];
    if (!PLAN.includes(weapon) || has(player, items[monster.component]) || has(player, items[weapon][2])) return false;
    const armed = WEAPONS.some(([name]) => items[name].some((id) => player.getEquipment().contains(id)));
    const hp = player.getHitpoints() / Math.max(1, player.getSkillManager().getMaxLevel(Shared.core().Skill.HITPOINTS));
    return armed && hp >= DEMI_FIT && count(player, items.paddlefish) + count(player, items.rawPaddlefish) >= DEMI_FOOD;
  }

  /**
   * The shards it still wants: what its materials in hand can turn into armour (each piece's next
   * tiers, lowest first, while the ore, bark and linum last), attuning its weapons, the potions,
   * a teleport crystal, and a little over (gathering finds shards too). It kills for shards only
   * while they lag behind the materials: the materials are what a run is short of.
   */
  function shardsNeeded(run) {
    const items = Items.itemsFor(run.mode);
    const left = { ore: count(player, items.ore), bark: count(player, items.bark), linum: count(player, items.linum) };
    const tierOf = (piece) => Math.max(...items[piece].map((id, index) => (has(player, id) ? index : -1)));
    let need = 0;
    for (let tier = 0; tier <= ARMOUR_GOAL[run.mode]; tier++) {
      for (const piece of ["helm", "body", "legs"]) {
        if (tierOf(piece) >= tier) continue;
        const cost = Items.ARMOUR_COST[piece][tier];
        if (["ore", "bark", "linum"].some((key) => left[key] < cost.each)) continue;
        for (const key of ["ore", "bark", "linum"]) left[key] -= cost.each;
        need += cost.shards;
      }
    }
    for (const name of PLAN) if (!has(player, items[name][1]) && !has(player, items[name][2])) need += ATTUNE_SHARDS;
    need += potionsNeeded() * POTION_SHARDS;
    need += SHARD_MARGIN;
    return Math.max(0, need - count(player, items.shards));
  }

  /** Whether it still wants the weak and strong monsters: short of shards, or of frames. */
  function wantsKills(run) {
    const items = Items.itemsFor(run.mode);
    return shardsNeeded(run) > 0 || count(player, items.frame) + weapons(run).length < 2;
  }

  function fightMonsters(run, room) {
    // Run 1 is for the weak monsters (a frame and shards), whatever it holds already.
    const run1 = bot.phase === "run1";
    const kills = run1 || wantsKills(run);
    const tiers = run1 ? ["weak"] : ["weak", "strong"];
    // With what it needs, the maze's monsters are left alone (prayer takes their hits): auto-
    // retaliate goes off so they don't drag it into a fight, and one it's in is walked away from.
    player.setAutoRetaliate?.(kills);
    const target = player.getCombat().getTarget?.();
    if (target && target.getHitpoints?.() > 0) {
      const monster = Monsters.byId.get(target.getId?.());
      if (kills || demiWanted(run, monster)) {
        fought(run, target);
        return true;
      }
      player.getCombat().reset();
    }
    // The maze's own monsters are its entities (getNpcs lists only those that walked in).
    const monsters = [...run.map.entities].filter((npc) => npc?.isNpc?.() && npc.getHitpoints?.() > 0 && run.map.roomAt(npc.getLocation()) === room
      && ((kills && tiers.includes(Monsters.byId.get(npc.getId())?.tier)) || demiWanted(run, Monsters.byId.get(npc.getId()))));
    const monster = nearest(monsters);
    if (!monster) return false;
    player.getCombat().attack(monster);
    fought(run, monster);
    wait(1);
    return true;
  }

  function fought(run, npc) {
    if (bot.lastTarget?.npc !== npc) bot.lastTarget = { npc, room: run.map.roomAt(npc.getLocation()), diedAt: null };
  }

  /**
   * Whether a monster it fought here has just died, its drop still to come: it waits on the tile
   * it died on (where the drop lands as the death animation ends), till it's landed and what it
   * wants of it is picked up.
   */
  function awaitingDrop(run, room) {
    const last = bot.lastTarget;
    if (!last) return false;
    if (last.npc.getHitpoints?.() > 0 && last.npc.isRegistered?.() !== false) return false;
    if (last.diedAt == null) {
      last.diedAt = cycle();
      const at = last.npc.getLocation();
      last.at = new (Shared.core().Location)(at.getX(), at.getY(), at.getZ());
    }
    if (dropsAt(run, last.at).length > 0) last.landed = true;
    if (last.room !== room || cycle() - last.diedAt > DROP_WAIT) {
      bot.lastTarget = null;
      return false;
    }
    return true;
  }

  /** On towards where the drop will land, while it's still to come. */
  function meetDrop() {
    const at = bot.lastTarget?.at;
    if (!at || player.getLocation().equals(at)) return false;
    if (player.getMovementQueue().size() === 0) player.getMovementQueue().walkToTile(at, () => {});
    return true;
  }

  /** Ground items of its own on a tile. */
  function dropsAt(run, at) {
    return Shared.core().World.getItems().filter((item) => item.getPrivateArea?.() === player.getPrivateArea?.()
      && !item.isPendingRemoval?.() && item.getPosition().equals(at));
  }

  /** Drops in this room (shards, the weapon frame, fish, leaves), picked up as a player does. */
  function loot(run, room) {
    // What lies in the start room is its own stash, picked up when it cooks.
    if (room === startRoom(run)) return false;
    const { World } = Shared.core();
    const manager = Shared.api().getItemOnGroundManager();
    const items = Items.itemsFor(run.mode);
    // Frames past the two weapons it makes would only fill the pack.
    const enoughFrames = count(player, items.frame) + weapons(run).length >= 2;
    const drops = World.getItems().filter((item) => item.getPrivateArea?.() === player.getPrivateArea?.()
      && !item.isPendingRemoval?.() && run.map.roomAt(item.getPosition()) === room
      && !(enoughFrames && item.getItem().getId() === items.frame)
      // What it dropped itself (the tools it's done with) stays dropped.
      && !bot.dropped.has(item.getItem().getId())
      // A grym leaf past the potions' is only weight.
      && !(item.getItem().getId() === items.grymLeaf && stillNeeded(run, "grymLeaf") === 0)
      // Fish past FOOD (raw, cooked and stashed all counted) would only be overstock.
      && !([items.rawPaddlefish, items.paddlefish].includes(item.getItem().getId()) && stillNeeded(run, "rawPaddlefish") === 0)
      // Nor a component its weapons don't want (the spike: no halberd). Shards and materials it
      // takes all of: what it needs of them grows as it goes.
      && !(item.getItem().getId() === items.spike)
      && !([items.orb, items.bowstring].includes(item.getItem().getId()) && !componentWanted(run, item.getItem().getId()))
      // A frame it still needs comes before the space kept for making.
      && (stacks(item.getItem().getId()) || [items.frame, items.orb, items.bowstring, items.spike].includes(item.getItem().getId())
        || inv(player).getFreeSlots() > roomToKeep())
      && manager.inventoryCapacity(player, item.getItem()) > 0);
    if (drops.length === 0) {
      bot.lootTarget = null;
      return false;
    }
    // The drop it set out for, while it's still there: no turning back and forth as others come
    // nearer on the way. Otherwise the most wanted (frame, orb, bowstring, then shards), nearest first.
    let drop = drops.includes(bot.lootTarget) ? bot.lootTarget : null;
    if (!drop) {
      const rank = (item) => {
        const id = item.getItem().getId();
        if ([items.frame, items.orb, items.bowstring, items.spike].includes(id)) return 0;
        if (id === items.shards) return 1;
        return 2;
      };
      drop = drops.sort((a, b) => rank(a) - rank(b)
        || chebyshev(a.getPosition(), player.getLocation()) - chebyshev(b.getPosition(), player.getLocation()))[0];
      bot.lootTarget = drop;
    }
    // On its tile: taken now, one a tick (the next one there straight after).
    if (player.getLocation().equals(drop.getPosition())) {
      manager.pickup(player, drop);
      bot.lootTarget = null;
      return true;
    }
    if (player.getMovementQueue().size() === 0) player.getMovementQueue().walkToTile(drop.getPosition(), () => {});
    return true;
  }

  const nodeKey = (object) => `${object.getId()}:${object.getLocation().getX()},${object.getLocation().getY()}`;

  function gather(run, room) {
    const nodes = roomObjects(run, room, (object) => {
      const found = Resources.resourceById(object.getId());
      return found && found.mode === run.mode && wanted(run, found.resource.item) > 0
        && (bot.nodeTries.get(nodeKey(object)) ?? 0) < NODE_TRIES;
    });
    // Fish first: food is what runs out at the Hunllef.
    const fishing = nodes.filter((object) => Resources.resourceById(object.getId()).key === "fishing");
    const node = nearest(fishing.length ? fishing : nodes);
    if (!node) return false;
    const key = Resources.resourceById(node.getId()).key;
    // Its empty vials filled at the fishing spot first, as the Wiki has it (a vial on the spot).
    if (key === "fishing" && count(player, Items.itemsFor(run.mode).vial) > 0 && fillAt(run, node)) return true;
    const option = { deposit: "Mine", roots: "Chop", fishing: "Fish", linum: "Pick", grym: "Pick" }[key];
    // A node clicked this often without the gathering starting can't be reached: left alone.
    bot.nodeTries.set(nodeKey(node), (bot.nodeTries.get(nodeKey(node)) ?? 0) + 1);
    bot.gathering = Resources.resourceById(node.getId()).resource.item;
    use(player, node, option);
    // Two ticks for the walk to start (a click sooner would set off a new walk).
    wait(2);
    return true;
  }

  /** Its vials on a fishing spot: filled there, one a tick. */
  function fillAt(run, spot) {
    const vial = Items.itemsFor(run.mode).vial;
    const slot = slotOf(player, vial);
    if (slot < 0) return false;
    const at = spot.getLocation();
    player.getMovementQueue().walkToObject(spot, {
      execute: () => Shared.api().emitItemOnObject({
        player, object: spot, objectId: spot.getId(), item: inv(player).getItems()[slot], itemId: vial, itemSlot: slot,
        interfaceType: 0, location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
      }),
    });
    wait(2);
    return true;
  }

  const startRoom = (run) => run.map.room(run.map.start.x, run.map.start.y);

  /** The raw fish it left on the start room's floor, by the range. */
  function stash(run) {
    const { World } = Shared.core();
    const raw = Items.itemsFor(run.mode).rawPaddlefish;
    const start = startRoom(run);
    return World.getItems().filter((item) => item.getPrivateArea?.() === player.getPrivateArea?.() && !item.isPendingRemoval?.()
      && item.getItem().getId() === raw && run.map.roomAt(item.getPosition()) === start);
  }

  /** Drops one of an item where it stands, as a player's Drop does. */
  function drop(id) {
    const slot = slotOf(player, id);
    if (slot < 0) return false;
    const { Item } = Shared.core();
    // The amount first: deleting the stack zeroes the item it was read from.
    const amount = inv(player).getItems()[slot].getAmount();
    inv(player).deleteAtSlot(slot, amount);
    inv(player).refreshItems();
    Shared.api().getItemOnGroundManager().registers(player, new Item(id, amount));
    return true;
  }

  const gridSteps = (a, b) => Math.abs(a.gridX - b.gridX) + Math.abs(a.gridY - b.gridY);

  /** Rooms on the way from `from` to `target` through lit rooms (the straight count without one). */
  function litSteps(run, from, target) {
    const distance = new Map([[roomKey(from), 0]]);
    const queue = [from];
    while (queue.length) {
      const room = queue.shift();
      if (room === target) return distance.get(roomKey(room));
      for (const side of GauntletMap.SIDES) {
        const next = run.map.room(room.gridX + side.dx, room.gridY + side.dy);
        if (!next || (!next.lit && next !== target) || isBossRoom(next) || distance.has(roomKey(next))) continue;
        distance.set(roomKey(next), distance.get(roomKey(room)) + 1);
        queue.push(next);
      }
    }
    return gridSteps(from, target);
  }

  /** The next lit room on the way to `target`, over the lit rooms (every pair of neighbours opens into each other). */
  function nextRoomToward(run, from, target) {
    const key = (room) => `${room.gridX},${room.gridY}`;
    const previous = new Map([[key(from), null]]);
    const queue = [from];
    while (queue.length) {
      const room = queue.shift();
      if (room === target) {
        let step = room;
        while (previous.get(key(step)) && previous.get(key(step)) !== from) step = previous.get(key(step));
        return step;
      }
      for (const side of GauntletMap.SIDES) {
        const next = run.map.room(room.gridX + side.dx, room.gridY + side.dy);
        if (!next?.lit || isBossRoom(next) || previous.has(key(next))) continue;
        previous.set(key(next), room);
        queue.push(next);
      }
    }
    return null;
  }

  const roomKey = (room) => `${room.gridX},${room.gridY}`;
  const isBossRoom = (room) => room.gridX === GauntletMap.CENTRE && room.gridY === GauntletMap.CENTRE;
  const centre = (run, room) => run.map.roomTile(room, 7 + Math.floor(Math.random() * 2), 7 + Math.floor(Math.random() * 2));

  /** Whether a component (by id) would still perfect its weapon. */
  function componentWanted(run, id) {
    const items = Items.itemsFor(run.mode);
    const part = Object.keys(COMPONENT_WEAPON).find((key) => items[key] === id);
    const weapon = COMPONENT_WEAPON[part];
    return !!weapon && PLAN.includes(weapon) && !has(player, items[weapon][2]) && count(player, id) === 0;
  }

  /** Whether the staff or bow still wants its demi-boss's component (and it's armed to get one). */
  function componentsWanted(run) {
    const items = Items.itemsFor(run.mode);
    const armed = WEAPONS.some(([name]) => items[name].some((id) => player.getEquipment().contains(id)));
    const part = (name) => Object.keys(COMPONENT_WEAPON).find((key) => COMPONENT_WEAPON[key] === name);
    return armed && PLAN.some((name) => !has(player, items[name][2]) && !has(player, items[part(name)]));
  }

  /**
   * The demi-boss rooms still worth going to: unlit ones (whose demi-boss it can't know yet), and
   * lit ones whose demi-boss is alive and has a component it wants (not a bear, not one it has).
   */
  function demiSpots(run) {
    const spots = [];
    for (let x = 0; x < GauntletMap.GRID; x++) {
      for (let y = 0; y < GauntletMap.GRID; y++) {
        if (!GauntletMap.isDemiBossRoom(x, y)) continue;
        const room = run.map.room(x, y);
        if (!room.lit || demiIn(run, room)) spots.push(room);
      }
    }
    return spots;
  }

  /** A demi-boss alive in a room that it wants (for its component), or null. */
  function demiIn(run, room) {
    return [...run.map.entities].find((npc) => npc?.isNpc?.() && npc.getHitpoints?.() > 0
      && run.map.roomAt(npc.getLocation()) === room && Monsters.byId.get(npc.getId())?.tier === "demi"
      && wantsComponent(run, Monsters.byId.get(npc.getId()))) ?? null;
  }

  /** Whether a demi-boss's component would perfect a weapon it hasn't perfected (fit or not). */
  function wantsComponent(run, monster) {
    const items = Items.itemsFor(run.mode);
    const weapon = COMPONENT_WEAPON[monster?.component];
    return PLAN.includes(weapon) && !has(player, items[monster.component]) && !has(player, items[weapon][2]);
  }

  const gridDistance = (a, b) => Math.abs(a.gridX - b.gridX) + Math.abs(a.gridY - b.gridY);

  /**
   * Run 1's rooms: the seven round the start room, clockwise from beside the boss room to its
   * other side (the Wiki's "C"; the boss room is the gap).
   */
  function cRoute(run) {
    const { x, y } = run.map.start;
    const ring = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]]
      .map(([dx, dy]) => run.map.room(x + dx, y + dy));
    const gap = ring.findIndex((room) => room && isBossRoom(room));
    return [...ring.slice(gap + 1), ...ring.slice(0, gap)].filter(Boolean);
  }

  /**
   * Run 2's rooms: straight out from the start, away from the boss room, to the rim, and a lap of
   * the rim clockwise from there (the demi-bosses wait in the middle of each side).
   */
  function rimRoute(run) {
    const { CENTRE, GRID } = GauntletMap;
    const { x, y } = run.map.start;
    const dx = x - CENTRE;
    const dy = y - CENTRE;
    const out = [];
    for (let step = 1; step <= GRID; step++) {
      const room = run.map.room(x + dx * step, y + dy * step);
      if (!room) break;
      out.push(room);
    }
    const last = GRID - 1;
    const rim = [];
    for (let i = 0; i <= last; i++) rim.push([i, last]);
    for (let i = last - 1; i >= 0; i--) rim.push([last, i]);
    for (let i = last - 1; i >= 0; i--) rim.push([i, 0]);
    for (let i = 1; i < last; i++) rim.push([0, i]);
    const entry = out[out.length - 1];
    const from = rim.findIndex(([rx, ry]) => rx === entry.gridX && ry === entry.gridY);
    const lap = [...rim.slice(from + 1), ...rim.slice(0, from + 1)].map(([rx, ry]) => run.map.room(rx, ry));
    return [...out, ...lap];
  }

  /** The next room on the shortest way from `from` to `target`, round the boss room (lit or not). */
  function stepToward(run, from, target) {
    const previous = new Map([[roomKey(from), null]]);
    const queue = [from];
    while (queue.length) {
      const room = queue.shift();
      if (room === target) {
        let step = room;
        while (previous.get(roomKey(step)) && previous.get(roomKey(step)) !== from) step = previous.get(roomKey(step));
        return step;
      }
      for (const side of GauntletMap.SIDES) {
        const next = run.map.room(room.gridX + side.dx, room.gridY + side.dy);
        if (!next || isBossRoom(next) || previous.has(roomKey(next))) continue;
        previous.set(roomKey(next), room);
        queue.push(next);
      }
    }
    return null;
  }

  /**
   * On along the run's route: the rooms it has reached are passed (what it does in a room comes
   * first: the monsters, the drops, the nodes), then a step towards the next. False at its end.
   */
  function followRoute(run, room) {
    while (bot.routeIndex < bot.route.length && bot.route[bot.routeIndex] === room) {
      bot.visited.add(roomKey(room));
      bot.routeIndex++;
    }
    const target = bot.route[bot.routeIndex];
    if (!target) return false;
    const next = stepToward(run, room, target);
    if (!next) {
      bot.routeIndex++;
      return true;
    }
    const side = GauntletMap.SIDES.find((candidate) => candidate.dx === next.gridX - room.gridX && candidate.dy === next.gridY - room.gridY);
    return enterRoom(run, room, side, next);
  }

  /**
   * Just inside a neighbouring room, through the doorway on `side` (the one it leaves by): it
   * stops there and looks round (monsters, drops, nodes) rather than going on to the middle.
   */
  const entryTile = (run, next, side) => run.map.roomTile(next, side.dx > 0 ? 2 : side.dx < 0 ? ROOM - 3 : 7, side.dy > 0 ? 2 : side.dy < 0 ? ROOM - 3 : 7);

  /** Into a neighbouring room: lighting its nodes first if it's dark (walking to them), then just in. */
  function enterRoom(run, room, side, next) {
    if (!next.lit) {
      const edge = run.map.roomTile(room, side.dx > 0 ? ROOM - 3 : side.dx < 0 ? 2 : 7, side.dy > 0 ? ROOM - 3 : side.dy < 0 ? 2 : 7);
      if (chebyshev(player.getLocation(), edge) > 2) {
        player.getMovementQueue().walkToTile(edge, () => {});
        wait(1);
        return true;
      }
      if (!run.lightRoom(next.gridX, next.gridY)) return false;
      player.sendMessage("You light the nodes in the corridor to help guide the way.");
    }
    player.getMovementQueue().walkToTile(entryTile(run, next, side), () => {});
    wait(1);
    return true;
  }

  /**
   * On to the next room. Armed and still after an orb or bowstring: straight for the nearest
   * demi-boss room worth it (their places are the maze's, three in the middle of each side),
   * gathering on the way, since each room's resources come before moving on. Otherwise: a room
   * not yet visited next door (the one nearest the start), else the nearest one further off.
   */
  function explore(run, room) {
    bot.visited.add(roomKey(room));
    const neighbours = GauntletMap.SIDES
      .map((side) => ({ side, next: run.map.room(room.gridX + side.dx, room.gridY + side.dy) }))
      .filter(({ next }) => next && !isBossRoom(next));
    if (componentsWanted(run)) {
      const goal = demiSpots(run).filter((spot) => spot !== room).sort((a, b) => gridDistance(a, room) - gridDistance(b, room))[0];
      if (goal) {
        // A step that brings it nearer, through a room not yet seen when there's a choice.
        const steps = neighbours.filter(({ next }) => gridDistance(next, goal) < gridDistance(room, goal))
          .sort((a, b) => Number(bot.visited.has(roomKey(a.next))) - Number(bot.visited.has(roomKey(b.next))));
        if (steps.length) return enterRoom(run, room, steps[0].side, steps[0].next);
      }
    }
    const start = startRoom(run);
    // Done with the demi-bosses: inwards, towards the start, rather than on round the edge (the
    // middle is nearer home for its trips, and it's where the rest of its materials are found).
    const fresh = neighbours.filter(({ next }) => !bot.visited.has(roomKey(next)))
      .sort((a, b) => gridDistance(a.next, start) - gridDistance(b.next, start))[0];
    if (fresh) return enterRoom(run, room, fresh.side, fresh.next);
    // Everything round here is done: on to any lit room not yet visited, or back to a demi-boss
    // it passed before it was armed for it.
    const demiRoom = (other) => [...run.map.entities].some((npc) => npc?.isNpc?.() && npc.getHitpoints?.() > 0
      && run.map.roomAt(npc.getLocation()) === other && demiWanted(run, Monsters.byId.get(npc.getId())));
    const lit = run.map.rooms.flat().filter((other) => other.lit && !isBossRoom(other) && other !== room
      && (!bot.visited.has(roomKey(other)) || demiRoom(other)));
    // The nearest, and of those the nearest the start.
    const target = lit.sort((a, b) => gridDistance(a, room) - gridDistance(b, room) || gridDistance(a, start) - gridDistance(b, start))[0];
    if (!target) return false;
    if (!towards(run, room, target)) bot.visited.add(roomKey(target));
    return true;
  }

  /** A room's step towards a lit room further off, through lit rooms; false when there's none. */
  function towards(run, room, target) {
    const step = GauntletMap.SIDES.find((side) => Math.sign(target.gridX - room.gridX) === side.dx && side.dy === 0)
      ?? GauntletMap.SIDES.find((side) => Math.sign(target.gridY - room.gridY) === side.dy && side.dx === 0);
    const next = step && run.map.room(room.gridX + step.dx, room.gridY + step.dy);
    if (!next?.lit || isBossRoom(next)) return false;
    player.getMovementQueue().walkToTile(entryTile(run, next, step), () => {});
    wait(1);
    return true;
  }

  /** Eats a paddlefish when low: below half in the fight, below 40% in the maze (fish are for the Hunllef). */
  function eat(run) {
    const items = Items.itemsFor(run.mode);
    const hp = player.getHitpoints() / Math.max(1, player.getSkillManager().getMaxLevel(Shared.core().Skill.HITPOINTS));
    if (hp < (run.stage === "boss" ? EAT_BELOW : PREP_EAT_BELOW) && click(player, items.paddlefish)) {
      wait(2);
      return true;
    }
    return false;
  }

  function prep(run) {
    keepRunning();
    // Time to finish: whatever it's at (a node, a monster) is left, not finished first.
    if (bot.finishing && !bot.leftOff) {
      bot.leftOff = true;
      if (working()) Resources.stopGathering(player);
      player.getCombat().reset();
      player.setAutoRetaliate?.(false);
      player.getMovementQueue().reset();
      // A walk to a node or a drop re-paths after a reset unless its task goes too.
      Shared.core().TaskManager.cancelWalkToTasks(player.getIndex());
    }
    // Enough of what it's gathering (fish to FOOD, the armour's materials): it stops, as a player
    // steps away from the node, rather than overstocking.
    if (working() && bot.gathering && stillNeeded(run, bot.gathering) === 0) {
      Resources.stopGathering(player);
      bot.gathering = null;
    }
    if (busy()) return;
    if (eat(run)) return;
    // Gear goes on as soon as it's made, wherever it is.
    if (wearGear(Items.itemsFor(run.mode))) return;
    const room = run.map.roomAt(player.getLocation());
    if (!room) return;
    const items = Items.itemsFor(run.mode);
    // Once done, it stays done: the leftovers it drops at home don't send it back out for more.
    if (!bot.finishing && (run.prepLeft <= finishTicks(run, room) || (bot.phase === "run2" && !needsMore(run)))) bot.finishing = true;
    const homeTime = bot.finishing;
    // A monster just killed here: its drop (a demi-boss's orb or bowstring) is waited for and
    // picked up before anything else, a trip home included.
    if (!homeTime && awaitingDrop(run, room)) {
      if (loot(run, room)) return step("looting");
      // Landed, and nothing of it wanted is left: on with the room.
      if (bot.lastTarget.landed) bot.lastTarget = null;
      else {
        meetDrop();
        return step("waiting for the drop");
      }
    }
    // Run 2's trips home: its first weapon, if run 1 found no frame; and a full pack (gear to
    // sing, fish to stash by the range). Each lasts till the work at home is done.
    if (!homeTime && !bot.trip && bot.phase === "run2") {
      const firstWeapon = count(player, items.frame) > 0 && weapons(run).length === 0 && count(player, items.shards) >= ATTUNE_SHARDS;
      const full = inv(player).getFreeSlots() <= roomToKeep()
        && (nextRecipe(run, { unloading: true }) !== null || count(player, items.rawPaddlefish) > 0);
      // Full, and short of nothing but a few fish: not worth the trip home and the walk back out.
      if (full && nearlyDone(run)) {
        bot.finishing = true;
        return;
      }
      if (firstWeapon || full) bot.trip = true;
    }
    if (!homeTime && !bot.trip && dropSpent(run)) return step("dropping what it's done with");
    if (!homeTime && !bot.trip && mixLeaves(run)) return step("making its potions");
    if (!homeTime && !bot.trip && bot.phase !== "home1") {
      if (fightMonsters(run, room)) return step("fighting");
      if (loot(run, room)) return step("looting");
      if (bot.phase === "run1") {
        // What its goals need from these rooms too, monsters or none: not a walk back for it later.
        if (gather(run, room)) return step("gathering");
        // The C, till it's round or has what run 1 is for: a frame and about 100 shards.
        const done = (count(player, items.frame) > 0 && count(player, items.shards) >= RUN1_SHARDS)
          || run.prepTicks - run.prepLeft >= RUN1_TICKS;
        if (!done && followRoute(run, room)) return step("run 1: the rooms round the start");
        bot.phase = "home1";
      } else {
        if (gather(run, room)) return step("gathering");
        if (followRoute(run, room)) return step("run 2: out to the rim and round it");
        if (explore(run, room)) return step("exploring");
      }
    }
    // The barrier's corridor is the boss room's edge: on its way in, not lost.
    const atBarrier = isBossRoom(room) && !run.inArena(player.getLocation());
    if (atBarrier && homeTime) {
      makeAndGo(run);
      return;
    }
    if (!run.inStartRoom(player.getLocation())) {
      step("heading home");
      goHome(run, room);
      return;
    }
    if (!homeTime && bot.phase === "home1") {
      // Between the runs: the staff sung and attuned, and the vials; then run 2.
      step("home after run 1: the staff and vials");
      if (!homeTrip(run, items)) {
        bot.phase = "run2";
        bot.route = rimRoute(run);
        bot.routeIndex = 0;
      }
      return;
    }
    step(homeTime ? "making its gear" : "at home on a trip");
    if (bot.trip && !homeTime) {
      if (!homeTrip(run, items)) bot.trip = false;
      return;
    }
    bot.trip = false;
    makeAndGo(run);
  }

  /**
   * At home on a trip: sing what it can (its weapons first, a new teleport crystal if it used its
   * one), then leave its raw fish on the floor by the range for later. False when it's done.
   */
  function homeTrip(run, items) {
    const station = (name) => nearest(roomObjects(run, startRoom(run), named(name)));
    if (makeNext(run, items, station, { unloading: true })) return true;
    if (count(player, items.rawPaddlefish) > 0) {
      const range = station("Range");
      if (range && chebyshev(range.getLocation(), player.getLocation()) > 2) {
        player.getMovementQueue().walkToObject(range, { execute: () => {} });
        wait(2);
        return true;
      }
      // A few a tick, all on the tile it stands on: one place to pick them up from.
      for (let i = 0; i < DROPS_PER_TICK && drop(items.rawPaddlefish); i++);
      return true;
    }
    return false;
  }

  /** Home to the start room: by the teleport crystal when it's far, walking room by room when near. */
  function goHome(run, room) {
    const start = startRoom(run);
    const crystal = Run.items()[run.mode].teleportCrystal;
    const slot = slotOf(player, crystal);
    if (slot >= 0 && gridSteps(room, start) >= TELEPORT_ROOMS) {
      // The teleport crystal's Activate: once, back to the start room.
      inv(player).deleteAtSlot(slot, 1);
      inv(player).refreshItems();
      run.teleportToStart();
      wait(2);
      return;
    }
    // Room by room through the doorways (kept clear of nodes), not to each room's middle (a node
    // can stand there, and a walk to it goes nowhere).
    const next = nextRoomToward(run, room, start) ?? stepToward(run, room, start);
    const side = next && GauntletMap.SIDES.find((candidate) => candidate.dx === next.gridX - room.gridX && candidate.dy === next.gridY - room.gridY);
    if (side) enterRoom(run, room, side, next);
    else {
      player.getMovementQueue().walkToTile(centre(run, start), () => {});
      wait(1);
    }
  }

  /** In the start room: the bowl, the gear on, the range, the potion, then the barrier. */
  function makeAndGo(run) {
    const items = Items.itemsFor(run.mode);
    const start = run.map.room(run.map.start.x, run.map.start.y);
    const station = (name) => nearest(roomObjects(run, start, named(name)));
    if (++bot.makeSteps <= MAKE_STEPS && makeNext(run, items, station)) return;
    const boss = run.map.room(GauntletMap.CENTRE, GauntletMap.CENTRE);
    const barrier = nearest(roomObjects(run, boss, named(Shared.OBJECT.BARRIER)));
    if (barrier) passBarrier(run, barrier);
    wait(4);
  }

  /**
   * Through the barrier from a tile beside it, outside the arena: the nearest one it can walk to
   * (found over the rooms' own collision), where its Quick-pass starts the fight.
   */
  function passBarrier(run, barrier) {
    const path = barrierPath(run, barrier);
    if (!path) return;
    const spot = path[path.length - 1];
    const click = () => {
      const definition = definitionFor(player, barrier);
      const clickType = (definition?.getActions?.() ?? []).indexOf("Quick-pass") + 1;
      const at = barrier.getLocation();
      Shared.api().emitObjectInteraction({
        player, object: barrier, objectId: barrier.getId(), clickType, definition,
        location: { x: at.getX(), y: at.getY(), z: at.getZ() },
        sourceLocation: { x: player.getLocation().getX(), y: player.getLocation().getY(), z: player.getLocation().getZ() },
        handled: false,
      });
    };
    if (player.getLocation().equals(spot)) {
      click();
      return;
    }
    // Step by step along the path found, as the route finder's own walk stops short here.
    const movement = player.getMovementQueue();
    movement.reset();
    for (const tile of path) movement.addSteps(tile);
  }

  /** The way to the nearest walk-reachable tile beside the barrier, outside the arena (tiles, in order). */
  function barrierPath(run, barrier) {
    const { RegionManager, Location } = Shared.core();
    const definition = definitionFor(player, barrier);
    const turned = (barrier.getFace?.() & 1) === 1;
    const sizeX = (turned ? definition?.getSizeY?.() : definition?.getSizeX?.()) ?? 1;
    const sizeY = (turned ? definition?.getSizeX?.() : definition?.getSizeY?.()) ?? 1;
    const at = barrier.getLocation();
    const beside = (x, y) => x >= at.getX() - 1 && x <= at.getX() + sizeX && y >= at.getY() - 1 && y <= at.getY() + sizeY
      && !(x >= at.getX() && x < at.getX() + sizeX && y >= at.getY() && y < at.getY() + sizeY)
      && (x === at.getX() - 1 || x === at.getX() + sizeX) !== (y === at.getY() - 1 || y === at.getY() + sizeY);
    const z = player.getLocation().getZ();
    const start = player.getLocation();
    const from = new Map([[`${start.getX()},${start.getY()}`, null]]);
    const queue = [[start.getX(), start.getY()]];
    for (let head = 0; head < queue.length && head < 4000; head++) {
      const [x, y] = queue[head];
      if (beside(x, y) && !run.inArena(new Location(x, y, z))) {
        const path = [];
        for (let key = `${x},${y}`; key !== null && from.has(key); key = from.get(key)) {
          const [px, py] = key.split(",").map(Number);
          path.unshift(new Location(px, py, z));
        }
        return path.slice(1).length ? path.slice(1) : [start];
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${x + dx},${y + dy}`;
        if (from.has(key) || !RegionManager.canMove(x, y, x + dx, y + dy, z, 1, 1, run.map)) continue;
        from.set(key, `${x},${y}`);
        queue.push([x + dx, y + dy]);
      }
    }
    return null;
  }

  /** One step of making; false when there's nothing left to make. */
  /** Makes room for what it's about to make: spare frames and burnt fish go on the floor. */
  function makeRoom(run, items) {
    if (inv(player).getFreeSlots() > 0) return false;
    const spareFrame = count(player, items.frame) + weapons(run).length > 2 ? items.frame : null;
    const junk = [items.burntPaddlefish, spareFrame].find((id) => id !== null && count(player, id) > 0);
    if (junk === undefined) return false;
    const slot = slotOf(player, junk);
    const { Item } = Shared.core();
    inv(player).deleteAtSlot(slot, 1);
    inv(player).refreshItems();
    Shared.api().getItemOnGroundManager().registers(player, new Item(junk, 1));
    return true;
  }

  function makeNext(run, items, station, { unloading = false } = {}) {
    if (wearGear(items) || makeRoom(run, items)) return true;
    const recipe = inv(player).getFreeSlots() > 0 || !needsSlot(run) ? nextRecipe(run, { unloading }) : null;
    if (recipe) {
      const bowl = station("Singing Bowl");
      if (bowl && use(player, bowl, "Sing-crystal", () => {
        const menu = player.getCreationMenu?.();
        if (!menu) return;
        player.getPacketSender().closeCreationMenu?.();
        menu.execute(recipe.id, 1);
      })) {
        wait(1);
        return true;
      }
    }
    if (unloading) return false;
    if (potionsNeeded() > 0 && makePotion(items, station)) return true;
    if (dropTools(run, items)) return true;
    return cookStash(run, items, station);
  }

  /** One step towards the next Egniol potion: fill the vial, the leaf in, the shards ground, the dust in. */
  function makePotion(items, station) {
    if (count(player, items.vial) > 0) {
      const pump = station("Water Pump");
      if (pump && use(player, pump, "Fill-from")) {
        wait(3);
        return true;
      }
    }
    if (count(player, items.grymLeaf) > 0 && count(player, items.waterVial) > 0 && count(player, items.grymPotion) < potionsNeeded()) {
      combine(player, items.grymLeaf, items.waterVial);
      wait(2);
      return true;
    }
    if (count(player, items.grymPotion) <= 0) return false;
    if (count(player, items.dust) >= Items.DUST_PER_POTION) {
      combine(player, items.dust, items.grymPotion);
      wait(2);
      return true;
    }
    // The dust needs a slot of its own.
    if (count(player, items.shards) >= Items.DUST_PER_POTION && (count(player, items.dust) > 0 || inv(player).getFreeSlots() > 0)) {
      combine(player, items.pestle, items.shards);
      wait(2);
      return true;
    }
    return false;
  }

  /**
   * Done gathering and making: the tools (and the sceptre, the crystal) go on the floor, room for
   * food; then, with nothing left to sing, the materials and shards left over (the potion's makings
   * kept while one can still be made).
   */
  function dropTools(run, items) {
    const kit = Run.items()[run.mode];
    const potionsDone = potionsNeeded() === 0 || count(player, items.grymLeaf) + count(player, items.grymPotion) === 0;
    const tools = [kit.sceptre, ...kit.tools].filter((id) => id !== items.pestle || potionsDone);
    const tool = tools.find((id) => count(player, id) > 0);
    if (tool !== undefined) {
      drop(tool);
      wait(1);
      return true;
    }
    if (nextRecipe(run) !== null) return false;
    const leftovers = [items.ore, items.bark, items.linum, items.frame, items.spike, items.orb, items.bowstring, items.burntPaddlefish,
      ...(potionsDone ? [items.shards, items.dust, items.vial, items.waterVial, items.grymLeaf, items.grymPotion] : [])];
    let dropped = 0;
    for (const id of leftovers) {
      while (dropped < DROPS_PER_TICK && drop(id)) dropped++;
    }
    if (dropped === 0) return false;
    wait(1);
    return true;
  }

  /** The stash by the range: picked up as the pack has room, and cooked a load at a time. */
  function cookStash(run, items, station) {
    const raw = count(player, items.rawPaddlefish);
    const left = stash(run);
    if (left.length > 0 && inv(player).getFreeSlots() > 0) {
      const manager = Shared.api().getItemOnGroundManager();
      const fish = left.sort((a, b) => chebyshev(a.getPosition(), player.getLocation()) - chebyshev(b.getPosition(), player.getLocation()))[0];
      // One a tick from the tile it's on; a walk only when there are none underfoot.
      if (player.getLocation().equals(fish.getPosition())) manager.pickup(player, fish);
      else {
        player.getMovementQueue().walkToTile(fish.getPosition(), () => manager.pickup(player, fish));
        wait(1);
      }
      return true;
    }
    if (raw > 0) {
      const range = station("Range");
      if (range && use(player, range, "Cook")) {
        wait(4);
        return true;
      }
    }
    return false;
  }

  /** The best armour on, and the best staff (else bow) in hand; true when it put something on. */
  function wearGear(items) {
    let changed = false;
    for (const piece of ["helm", "body", "legs"]) {
      const best = [...items[piece]].reverse().find((id) => count(player, id) > 0);
      const worn = items[piece].findIndex((id) => player.getEquipment().contains(id));
      if (best && items[piece].indexOf(best) > worn) {
        wear(player, best);
        changed = true;
      }
    }
    const armed = WEAPONS.some(([name]) => items[name].some((id) => player.getEquipment().contains(id)));
    const weapon = WEAPONS.map(([name]) => [...items[name]].reverse().find((id) => count(player, id) > 0)).find(Boolean);
    if (!armed && weapon) {
      wear(player, weapon);
      changed = true;
    }
    return changed;
  }

  /** Whether the next song needs an empty slot (an upgrade of a worn piece doesn't). */
  function needsSlot(run) {
    const recipe = nextRecipe(run);
    return recipe ? !recipe.needs.some(([id]) => player.getEquipment().contains(id)) : false;
  }

  /** The next thing to sing: weapons, then attuning them, the potion's vial, then armour. */
  function nextRecipe(run, { unloading = false } = {}) {
    const items = Items.itemsFor(run.mode);
    const crystal = Run.items()[run.mode].teleportCrystal;
    const shards = count(player, items.shards);
    const reserve = count(player, items.grymLeaf) + count(player, items.waterVial) + count(player, items.grymPotion) > 0
      && potionsNeeded() > 0 ? POTION_SHARDS : 0;
    const affordable = Items.bowlRecipes(run.mode, (id) => has(player, id)).filter((recipe) =>
      shards >= recipe.shards && recipe.needs.every(([id, need]) => count(player, id) + (player.getEquipment().contains(id) ? 1 : 0) >= need));
    const pick = (accept, keep = 0) => affordable.find((recipe) => accept(recipe) && shards - recipe.shards >= keep);
    const ofKind = (names) => (recipe) => names.some((name) => items[name].includes(recipe.id));
    // Its weapons, in order: the first not yet made is the one a frame goes to.
    const plan = PLAN;
    const unmade = plan.filter((name) => !items[name].some((id) => has(player, id))).slice(0, 1);
    // A full set first: the Hunllef's hits count the lowest piece's tier, and none for a gap.
    const armour = affordable.filter((recipe) => recipe.kind === "armour" && shards - recipe.shards >= reserve)
      .sort((a, b) => a.tier - b.tier)[0] ?? null;
    return pick((recipe) => recipe.kind === "weapon" && recipe.tier === 0 && ofKind(unmade)(recipe))
      ?? (unloading ? pick((recipe) => recipe.id === crystal && count(player, crystal) === 0, reserve) : null)
      // Its vials, one a potion (sung after run 1, filled at the fishing spots on run 2).
      ?? pick((recipe) => recipe.id === items.vial && potionsUnderWay(items) < potionsNeeded())
      ?? pick((recipe) => recipe.kind === "weapon" && recipe.tier === 1 && ofKind(plan)(recipe), reserve)
      ?? pick((recipe) => recipe.kind === "weapon" && recipe.tier === 2 && ofKind(plan)(recipe))
      ?? armour
      ?? null;
  }

  // -------------------------------------------------------------- the Hunllef

  function boss(run) {
    keepRunning();
    restoreRetaliate();
    // At the Hunllef, the weapon's offensive prayer too; but with no Egniol left and its prayer
    // running low, protection only (the offensive prayers drain it fastest; unprotected, its hits
    // are four times as hard).
    const saving = EGNIOL.every((id) => count(player, id) === 0)
      && player.getSkillManager().getCurrentLevel(Shared.core().Skill.PRAYER) < SAVE_PRAYER_BELOW;
    if (saving ? bot.offensive : !bot.offensive) {
      autopray(true, !saving);
      bot.offensive = !saving;
    }
    const fight = run.hunllef;
    const npc = fight?.npc;
    if (!npc || npc.getHitpoints() <= 0) return;
    const items = Items.itemsFor(run.mode);
    if (cycle() >= bot.waitUntil) {
      const prayer = player.getSkillManager().getCurrentLevel(Shared.core().Skill.PRAYER);
      // Eating and drinking clear the target, as an inventory click does: straight back to it.
      if (eat(run) || (prayer < DRINK_BELOW && [...EGNIOL].reverse().some((id) => click(player, id)) && (wait(2), true))) {
        // Food delays the attack timer: not an attack, for the 5:1 count. The click clears its
        // target: the dodge (which keeps it walking off a tornado's path) or the attack below
        // puts it back the same tick; an attack straight away would stop the dodge where it is.
        bot.fiveOne.skip = true;
      }
    }
    switchWeapon(run, fight, items);
    rapid(items);
    if (!dodge(run, fight)) {
      const target = player.getCombat().getTarget?.();
      if (target !== npc) player.getCombat().attack(npc);
    }
    // The style in hand for whatever attack goes this tick.
    bot.fiveOne.style = wielded(items);
  }

  /** The style of the weapon in hand. */
  function wielded(items) {
    return WEAPONS.find(([name]) => items[name].some((id) => player.getEquipment().contains(id)))?.[1] ?? "melee";
  }

  /** The bow on Rapid, as a player sets it: a tick off each attack. */
  function rapid(items) {
    if (!items.bow.some((id) => player.getEquipment().contains(id))) return;
    const { FightType, WeaponInterfaceManager } = Shared.core();
    const fast = Object.values(player.getWeapon?.()?.getFightType?.() ?? {}).find((type) => type?.isRapid?.());
    if (fast && FightType.resolve(player.getFightType()) !== fast) WeaponInterfaceManager.changeCombatStyle(player, fast.getChildId());
  }

  /** Its best of a weapon (in hand or carried), or null. */
  function bestOf(ids) {
    return [...ids].reverse().find((id) => has(player, id)) ?? null;
  }

  /**
   * The 5:1 method (Wiki): the Hunllef switches its protection to the style of every sixth hit
   * that lands off its prayer, so five attacks with its main weapon and then a sixth of another
   * style keep it off the main one: the other weapon while it protects against melee (it turns to
   * that one's style), a kick while it protects against the other weapon (it turns to melee); while
   * it protects against the main one, the other till it turns. The main weapon is the bow (the
   * Wiki's), but the staff when the staff is the higher tier (a perfected staff over an unperfected
   * bow hits far harder). Its attacks still in the air are counted with those landed: an attack is seen as its
   * attack timer starting again (eating's delay is not one), a landing as the Hunllef's count of
   * hits. Without both a bow and a staff: whatever weapon it isn't protecting against.
   */
  function switchWeapon(run, fight, items) {
    const f = bot.fiveOne;
    const combat = player.getCombat();
    const delay = combat.getAttackDelay();
    if (delay > f.lastDelay && !f.skip && f.style) f.pending.push(f.style);
    f.skip = false;
    f.lastDelay = delay;
    for (; f.landed < (fight.hitsLanded ?? 0); f.landed++) f.pending.shift();
    const bow = bestOf(items.bow);
    const staff = bestOf(items.staff);
    let want;
    if (bow && staff) {
      const tier = (ids, id) => ids.indexOf(id);
      const [main, other] = tier(items.staff, staff) >= tier(items.bow, bow) ? ["magic", "ranged"] : ["ranged", "magic"];
      const off = fight.offPrayerHits + f.pending.filter((style) => style !== fight.protecting).length;
      if (fight.protecting === main) want = other;
      else if (off !== BOW_ATTACKS) want = main;
      else want = fight.protecting === "melee" ? other : "melee";
    } else if (wielded(items) === fight.protecting) {
      want = WEAPONS.find(([name, style]) => style !== fight.protecting && bestOf(items[name]))?.[1];
    }
    if (!want || wielded(items) === want) return;
    if (want === "melee" && bow && staff) {
      // The kick: the weapon off (a free slot for it), and at it unarmed.
      const { EquipPacketListener, Equipment } = Shared.core();
      if (inv(player).getFreeSlots() <= 0 || !EquipPacketListener.unequip(player, Equipment.WEAPON_SLOT)) return;
    } else {
      const name = WEAPONS.find(([, style]) => style === want)?.[0];
      const id = name && bestOf(items[name]);
      if (!id || player.getEquipment().contains(id)) return;
      wear(player, id);
    }
    combat.attack(fight.npc);
  }

  function danger(run, fight, tile) {
    const corner = fight.arenaTile(0, 0);
    const key = `${tile.getX() - corner.getX()},${tile.getY() - corner.getY()}`;
    if (fight.floor.has(key)) return true;
    if (fight.tornadoes.some(({ npc }) => chebyshev(npc.getLocation(), tile) <= TORNADO_TILES)) return true;
    const body = fight.npc.getLocation();
    const x = tile.getX() - body.getX();
    const y = tile.getY() - body.getY();
    return x >= 0 && y >= 0 && x < 5 && y < 5;
  }

  /** Tiles between `tile` and the Hunllef's 5x5 body (0 under it). */
  function bodyGap(fight, tile) {
    const body = fight.npc.getLocation();
    const gap = (value, from) => Math.max(0, from - value, value - (from + 4));
    return Math.max(gap(tile.getX(), body.getX()), gap(tile.getY(), body.getY()));
  }

  /**
   * Whether `tile` is hit this tick or the next: under the Hunllef, an orange floor tile, or a
   * tornado close enough to be on it (they move a tile a tick and hit the tile they stand on).
   */
  function imminent(fight, tile) {
    const corner = fight.arenaTile(0, 0);
    const lit = fight.floor.get(`${tile.getX() - corner.getX()},${tile.getY() - corner.getY()}`);
    if (lit && (lit.state === "orange" || fight.ticks + 1 >= lit.orangeAt)) return true;
    if (fight.tornadoes.some(({ npc }) => chebyshev(npc.getLocation(), tile) <= 1)) return true;
    const body = fight.npc.getLocation();
    const x = tile.getX() - body.getX();
    const y = tile.getY() - body.getY();
    return x >= 0 && y >= 0 && x < 5 && y < 5;
  }

  /**
   * Off a lit tile, away from tornadoes, out from under the Hunllef: to the best tile (bestTile),
   * keeping its target, so the next attack goes as soon as it's ready (a swing stops the walk, as
   * a player's does). With the attack ready and nothing about to hit it here, it swings first and
   * steps after.
   */
  function dodge(run, fight) {
    const here = player.getLocation();
    if (!danger(run, fight, here)) return false;
    const combat = player.getCombat();
    if (combat.getTarget?.() === fight.npc && combat.getAttackDelay() <= 0 && !imminent(fight, here)) return false;
    const best = bestTile(run, fight, here);
    if (!best || best.equals(here)) return false;
    // Targeting first: it resets the walk. Then the route (a plain walk would drop the target), and
    // the combat told not to turn it back towards the Hunllef till it's there.
    if (combat.getTarget?.() !== fight.npc) combat.attack(fight.npc);
    player.getMovementQueue().reset();
    Shared.core().PathFinder.calculateWalkRoute(player, best.getX(), best.getY());
    combat.preserveMovementForTicks(Math.ceil(chebyshev(best, here) / 2) + 1);
    return true;
  }

  /**
   * The best tile on the floor to stand on, by cost, in tiles of walking. The floor and the
   * Hunllef hurt every tick it stays, a tornado only on the tick it reaches its tile: so an orange
   * tile (or one turning orange next tick) and the tiles under the Hunllef cost most, then a blue
   * one (orange soon), and a tornado close by much less (walking past one beats standing on the
   * floor). Its walk there costs for each orange tile crossed and for passing under the Hunllef;
   * then out of its weapon's reach (the halberd's or a kick's from the body, the staff's and
   * bow's FIGHT_RANGE from the middle), a corner (the Wiki: keep out of them), and the walk. So
   * with no tile clear there is still the least bad. (Not the Wiki's final-phase safe tiles: they
   * lie against the Hunllef, where the tornadoes corner it; in test runs they cost more than the
   * floor they save.)
   */
  function bestTile(run, fight, here) {
    const centreTile = fight.npc.getLocation().transform(2, 2);
    const items = Items.itemsFor(run.mode);
    const melee = wielded(items) === "melee";
    const reach = items.halberd.some((id) => player.getEquipment().contains(id)) ? HALBERD_REACH : KICK_REACH;
    const inReach = (tile) => (melee ? bodyGap(fight, tile) <= reach : chebyshev(tile, centreTile) <= FIGHT_RANGE);
    const corner = fight.arenaTile(0, 0);
    const floorAt = (tile) => fight.floor.get(`${tile.getX() - corner.getX()},${tile.getY() - corner.getY()}`);
    const burning = (tile) => {
      const lit = floorAt(tile);
      return !!lit && (lit.state === "orange" || fight.ticks + 1 >= lit.orangeAt);
    };
    const tornado = (tile) => Math.min(Infinity, ...fight.tornadoes.map(({ npc }) => chebyshev(npc.getLocation(), tile)));
    let best = null;
    let bestCost = Infinity;
    for (let x = 0; x < 12; x++) {
      for (let y = 0; y < 12; y++) {
        const tile = fight.arenaTile(x, y);
        const near = tornado(tile);
        let cost = (burning(tile) || bodyGap(fight, tile) === 0 ? COST.BURNING : floorAt(tile) ? COST.LIT : 0)
          + (near <= 1 ? COST.TORNADO_NEXT : near <= TORNADO_TILES ? COST.TORNADO_NEAR : 0)
          + (inReach(tile) ? 0 : COST.REACH)
          + ((x <= 1 || x >= 10) && (y <= 1 || y >= 10) ? CORNER_COST : 0)
          + chebyshev(tile, here);
        // The walk there: each orange tile it crosses, and under the Hunllef.
        const steps = chebyshev(here, tile);
        for (let i = 1; i < steps; i++) {
          const step = here.transform(Math.round(((tile.getX() - here.getX()) * i) / steps), Math.round(((tile.getY() - here.getY()) * i) / steps));
          if (burning(step)) cost += COST.CROSS_BURNING;
          if (bodyGap(fight, step) === 0) cost += COST.CROSS_UNDER;
        }
        if (cost < bestCost) {
          best = tile;
          bestCost = cost;
        }
      }
    }
    return best;
  }

  // -------------------------------------------------------------- the controller

  return {
    tick() {
      const run = Run.runOf(player);
      if (!run) {
        restorePrayer();
        restoreRetaliate();
        if (busy()) return true;
        // A run just over is still fading back to the lobby: wait for it, not away from it.
        if (/Gauntlet/.test(player.getArea?.()?.getName?.() ?? "")) return true;
        return lobby();
      }
      if (run !== bot.run) begin(run);
      if (run.stage === "boss" && bot.checked !== run) {
        // Into the fight short of food or gear: ::gauntletgear's loadout instead.
        bot.checked = run;
        const short = shortfall(run);
        bot.geared = short.length ? short.join(", ") : null;
        if (bot.geared) Commands.gearUp({ player, parts: ["gauntletgear", "perfected"] });
      }
      if (run.stage === "prep") prep(run);
      else if (run.stage === "boss") boss(run);
      return true;
    },
    // Stopping hands the character back where it is: a run under way goes on, the player's to finish.
    stop() {
      restorePrayer();
      restoreRetaliate();
    },
    describe() {
      const run = Run.runOf(player);
      if (!run) return `in the Gauntlet lobby (${bot.runs} ${corrupted ? "corrupted " : ""}runs)`;
      return run.stage === "boss" ? `fighting the Hunllef${bot.geared ? ` (::gauntletgear, it was short of ${bot.geared})` : ""}` : `preparing (${Math.ceil(run.prepLeft * 0.6)}s left): ${bot.step ?? "starting"}`;
    },
    runs: () => bot.runs,
  };
}

function play(request) {
  if (!request?.player || request.controller) return;
  request.controller = createController(request.player, { corrupted: request.corrupted === true });
}

module.exports = function registerGauntletBots(api) {
  Shared.bind(api);
  api.onCustomEvent("gauntlet:play", play);
  api.onCustomEvent("gauntlet:in-run", (request) => {
    if (request?.player && Run.runOf(request.player)) request.inRun = true;
  });
  // "gauntlet:completed" { player, completed }: whether a Gauntlet has been completed (the Corrupted one opens).
  api.onCustomEvent("gauntlet:completed", (request) => {
    if (request?.player) request.completed = Run.hasCompleted(request.player);
  });
};
module.exports.createController = createController;
