"use strict";

/**
 * Wintertodt bots: a crowd that fights the Wintertodt alongside real players, through the same
 * clicks a player makes (object routes, item-on-item, NPC options), so points, warmth, the
 * Wintertodt's attacks and their interruptions all apply to them as to anyone.
 *
 * Population: while a real player is in the camp or the prison, the world keeps `target` bots
 * (::wtbots sets it; 0 turns them off). They arrive outside the Doors of Dinh and go in through
 * them; with no real player around for IDLE_LOGOUT_TICKS they log out. They are never saved.
 *
 * Each bot has a home corner (bots are dealt round the four in turn) and works it the way the
 * Wiki's strategy page describes a team doing it:
 *   1. keep warm: eat a cake (35% warmth a bite) or drink a rejuvenation potion when cold;
 *   2. fix its brazier when broken, light it when out (and its pyromancer is up);
 *   3. chop the corner's bruma roots until the pack is full, then (fletchers) cut them into
 *      kindling, then feed the burning brazier until the fuel is gone; and again.
 * One bot in four is a healer: it keeps a few rejuvenation potions (concoctions from the crate,
 * herbs from the sprouting roots, mixed) and heals any pyromancer who is down, else works its
 * corner like the rest. Between rounds the bots wait by their braziers.
 *
 * A bot that runs out of food while freezing, or that dies, logs out instead of dying in the
 * prison (its kit would litter the floor); a fresh one takes its place.
 *
 * The world sends no zone events for bots (it skips their player-process event), and the round
 * counts only those its zone handlers saw come in: each bot replays the Doors of Dinh's zone
 * handlers as it crosses between the camp and the prison, so the cold, the attacks, the end
 * of a round's sweep and its reward reach it as they reach a player.
 */

const Shared = require("./Shared.Wintertodt");
const Round = require("./Round.Wintertodt");
const Corners = require("./Corners.Wintertodt");
const Warmth = require("./Warmth.Wintertodt");
const Doors = require("./Doors.Wintertodt");
const { createBotPlayer } = require("../../bots/behaviours/spawn/PlayerFactory.PlayerBots");
const { ATTR_SKIP_PERSISTENCE } = require("../../bots/runtime/PersistenceConstants.PlayerBots");
const { realisticName } = require("../../bots/ai/Names.PlayerBots");

/** How many bots a world keeps while a real player is about, unless ::wtbots says otherwise. */
const DEFAULT_TARGET = 8;
const MAX_TARGET = 40;
/** A minute with no real player in the camp or prison and the bots log out. */
const IDLE_LOGOUT_TICKS = 100;
/** At most one new bot a tick, so a crowd trickles in as players do. */
const SPAWNS_PER_TICK = 1;
const NAME_ATTEMPTS = 8;

/** Every fourth bot keeps potions for the pyromancers. */
const HEALER_EVERY = 4;
/** Half the bots fletch their roots into kindling first (more points per trip, Wiki). */
const FLETCHER_SHARE = 0.5;

/** Warmth (0-1000) below which a bot eats; below LEAVE_WARMTH with nothing to eat, it gives up. */
const EAT_WARMTH = 450;
const LEAVE_WARMTH = 150;
/** Hitpoints share below which a bot eats too (the brazier's shrapnel, area attacks). */
const EAT_HP_RATIO = 0.5;
/** Cakes in the kit: each has three bites and each bite restores 35% warmth (Wiki). */
const CAKES = 5;

/** The healer keeps this many doses, and tops up when it has fewer than MIN_DOSES. */
const POTIONS_KEPT = 2;
const MIN_DOSES = 2;

/** Ticks a click may take (the walk there) before the bot tries again. */
const CLICK_PATIENCE_TICKS = 12;
/** Ticks between two tries of the same thing that did not start. */
const RETRY_TICKS = 3;
/** Ticks a bot waits before re-entering after landing outside. */
const DOOR_RETRY_TICKS = 6;

const DOORS = { id: 29322, x: 1627, y: 3964 };
/** Each corner's bruma roots, in the HUD's corner order (south-west, north-west, north-east, south-east). */
const ROOTS = [{ x: 1620, y: 3988 }, { x: 1621, y: 4025 }, { x: 1638, y: 4025 }, { x: 1639, y: 3988 }];
const SPROUTING_ROOTS = [{ x: 1625, y: 3978 }, { x: 1635, y: 3978 }, { x: 1611, y: 4007 }, { x: 1649, y: 4007 }];
const CONCOCTION_CRATES = [{ x: 1626, y: 3982 }, { x: 1634, y: 3982 }];
const LOC = { ROOTS: 29311, SPROUTING_ROOTS: 29315, CONCOCTION_CRATE: 29320 };
/** Option slots (1-based click types): every loc and the pyromancer use their first option. */
const CLICK = { FIRST: 1, TAKE_FIVE: 2 };

/** Warm clothing worn by the bots (four pieces each, so the cold does the least it can). */
const OUTFITS = [
  { HEAD: "PYROMANCER_HOOD", BODY: "PYROMANCER_GARB", LEG: "PYROMANCER_ROBE", FEET: "PYROMANCER_BOOTS" },
  { HEAD: "PYROMANCER_HOOD", BODY: "PYROMANCER_GARB", HANDS: "WARM_GLOVES", FEET: "PYROMANCER_BOOTS" },
  { HEAD: "SANTA_HAT", AMULET: "WOOLLY_SCARF", HANDS: "WARM_GLOVES", FEET: "PYROMANCER_BOOTS" },
  { HEAD: "BOBBLE_HAT", AMULET: "WOOLLY_SCARF", HANDS: "WARM_GLOVES", BODY: "PYROMANCER_GARB" },
];

/** Levels: Firemaking 50+ to enter (Wiki), the rest what a typical player there has. */
const LEVELS = { FIREMAKING: [60, 99], WOODCUTTING: [60, 99], FLETCHING: [50, 99], HITPOINTS: [60, 99] };

const BOT_ATTRIBUTE = "wintertodt:bot";

const population = {
  target: DEFAULT_TARGET,
  brains: new Map(),
  lastRealTick: -Infinity,
  tick: 0,
  serial: 0,
  task: null,
};

// --- Pure helpers ------------------------------------------------------------------------

function randomInt([min, max], random = Math.random) {
  return min + Math.floor(random() * (max - min + 1));
}

/** The role for the `serial`-th bot: its home corner, whether it heals and whether it fletches. */
function roleFor(serial, random = Math.random) {
  return {
    corner: serial % Shared.CORNERS.length,
    healer: serial % HEALER_EVERY === HEALER_EVERY - 1,
    fletcher: random() < FLETCHER_SHARE,
  };
}

/** Real (non-bot) players in the camp or the prison. */
function realPlayersAbout(players) {
  return players.filter((player) => player?.isPlayerBot?.() !== true
    && (Shared.inZone(Shared.PRISON_ZONE, player.getLocation()) || Shared.inZone(Shared.CAMP_ZONE, player.getLocation())));
}

/** How many more bots to spawn now: up to the target, at most SPAWNS_PER_TICK a tick. */
function spawnsNeeded(target, count) {
  return Math.max(0, Math.min(SPAWNS_PER_TICK, target - count));
}

function countOf(player, ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
  return player.getInventory().getItems().reduce((sum, item) => sum + (item && wanted.has(item.getId()) ? item.getAmount() : 0), 0);
}

function slotOf(player, ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
  return player.getInventory().getItems().findIndex((item) => item && wanted.has(item.getId()));
}

/** Rejuvenation doses carried. */
function dosesOf(player) {
  return Shared.POTIONS.reduce((sum, id, index) => sum + countOf(player, id) * (4 - index), 0);
}

function nearest(location, tiles) {
  let best = tiles[0];
  for (const tile of tiles) if (Shared.distance(location, tile) < Shared.distance(location, best)) best = tile;
  return best;
}

/**
 * What a bot should do next in a running round, from what it can see: `self` (its warmth,
 * hitpoints, kit and current action), its home `corner`, the `downed` corners and its `role`.
 * Returns one of: eat, leave, busy, heal, brew, fix, light, fletch, feed, chop, wait.
 */
function decide({ self, corner, downed, role, phase }) {
  const cold = self.warmth < EAT_WARMTH || self.hp < self.maxHp * EAT_HP_RATIO;
  if (cold && self.food > 0) return { action: "eat" };
  if (cold && self.doses > 0) return { action: "drink" };
  if (self.warmth < LEAVE_WARMTH) return { action: "leave" };
  if (role.healer && downed.length > 0 && self.doses > 0) return { action: "heal", corner: downed[0] };
  if (self.action) return { action: "busy" };
  if (role.healer && self.doses < MIN_DOSES) return { action: "brew" };
  if (corner.brazier === Shared.BRAZIER.BROKEN) return { action: "fix" };
  if (corner.brazier === Shared.BRAZIER.UNLIT && corner.pyromancerHealthy) return { action: "light" };
  const fuel = self.roots + self.kindling;
  const burning = corner.brazier === Shared.BRAZIER.LIT;
  if (phase === "burn" && fuel > 0) {
    if (role.fletcher && self.roots > 0 && !self.safe) return { action: "fletch" };
    return burning ? { action: "feed" } : { action: "wait" };
  }
  if (self.free > 0) return { action: "chop" };
  return burning && fuel > 0 ? { action: "feed" } : { action: "wait" };
}

/** Herbs a healer still wants: one for each concoction it holds (picking runs till the pack is full). */
function herbsWanted(unf) {
  return Math.max(1, Math.min(unf, POTIONS_KEPT));
}

// --- The bot -----------------------------------------------------------------------------

class WintertodtBot {
  constructor(player, role) {
    this.player = player;
    this.role = role;
    this.phase = "gather";
    this.pending = null;
    this.nextTryTick = 0;
    this.doorTick = 0;
    this.zone = null;
  }

  /** Where the bot stands: "prison", "camp" or null (anywhere else). */
  zoneNow() {
    const at = this.player.getLocation();
    if (Shared.inZone(Shared.PRISON_ZONE, at)) return "prison";
    if (Shared.inZone(Shared.CAMP_ZONE, at)) return "camp";
    return null;
  }

  /** Runs the Doors' zone handlers on a crossing, as the world's zone events do for players. */
  crossZones() {
    const zone = this.zoneNow();
    if (zone === this.zone) return;
    const event = { player: this.player };
    if (this.zone === "prison") Doors.leftPrison(event);
    if (zone === "prison") Doors.enteredPrison(event);
    else Doors.syncHud(event);
    this.zone = zone;
  }

  core() {
    return Shared.core();
  }

  /** What the bot sees of itself. */
  self() {
    const { player } = this;
    const inventory = player.getInventory();
    return {
      warmth: Warmth.warmthOf(player),
      hp: player.getHitpoints(),
      maxHp: player.getSkillManager().getMaxLevel(this.core().Skill.HITPOINTS),
      food: countOf(player, this.core().ItemIdentifiers.CAKE) + countOf(player, CAKE_BITES()),
      doses: dosesOf(player),
      roots: countOf(player, Shared.ITEM.BRUMA_ROOT),
      kindling: countOf(player, Shared.ITEM.BRUMA_KINDLING),
      free: inventory.getFreeSlots(),
      safe: Shared.inSafeArea(player.getLocation()),
      action: Shared.actionOf(player),
    };
  }

  /** One think a tick. Returns false when the bot should be logged out. */
  tick(tick) {
    const { player } = this;
    if (player.isRegistered?.() === false) return false;
    if (player.getHitpoints() <= 0) return false;
    if (player.isNeedsPlacement?.() === true) return true;
    this.crossZones();
    if (!Round.inPrison(player)) return this.outside(tick);
    if (this.walking()) return true;
    const self = this.self();
    if (self.action === "pick" && countOf(player, Shared.ITEM.BRUMA_HERB) >= herbsWanted(countOf(player, Shared.ITEM.REJUVENATION_UNF))) {
      Shared.stopAction(player, "pick");
      self.action = null;
    }
    if (self.action) this.pending = null;
    if (this.pending && tick < this.pending.until) return true;
    this.pending = null;
    if (!Round.isActive()) {
      this.phase = "gather";
      this.standBy();
      return true;
    }
    if (self.roots + self.kindling === 0) this.phase = "gather";
    else if (self.free === 0) this.phase = "burn";
    const home = Corners.corner(this.role.corner);
    const downed = Shared.CORNERS.map((_, index) => index).filter((index) => !Corners.corner(index).pyromancerHealthy);
    const plan = decide({ self, corner: home, downed, role: this.role, phase: this.phase });
    if (tick < this.nextTryTick && plan.action !== "eat" && plan.action !== "drink") return true;
    return this.act(plan, tick);
  }

  act(plan, tick) {
    switch (plan.action) {
      case "eat": return this.useItem(slotOf(this.player, [this.core().ItemIdentifiers.CAKE, ...CAKE_BITES()]), tick);
      case "drink": return this.useItem(slotOf(this.player, Shared.POTIONS), tick);
      case "leave": return false;
      case "heal": return this.heal(plan.corner, tick);
      case "brew": return this.brew(tick);
      case "fix":
      case "light": return this.clickBrazier(tick);
      case "fletch": return this.fletch(tick);
      case "feed": return this.clickBrazier(tick);
      case "chop": return this.clickLoc(LOC.ROOTS, ROOTS[this.role.corner], CLICK.FIRST, tick);
      default: return true;
    }
  }

  walking() {
    return this.player.getMovementQueue().size() > 0;
  }

  /** Waits by its brazier between rounds, a tile or two out from the 3x3. */
  standBy() {
    const { player } = this;
    const brazier = Shared.CORNERS[this.role.corner].brazier;
    const spot = { x: brazier.x + 1 + (this.role.corner < 2 ? 2 : -2), y: brazier.y + 1 };
    if (Shared.distance(player.getLocation(), spot) <= 2) return;
    this.core().PathFinder.calculateWalkRoute(player, spot.x, spot.y);
  }

  /** Outside the prison: walk in through the Doors of Dinh; anywhere else, log out. */
  outside(tick) {
    const { player } = this;
    if (!Shared.inZone(Shared.CAMP_ZONE, player.getLocation())) return false;
    if (tick < this.doorTick || this.walking()) return true;
    this.doorTick = tick + DOOR_RETRY_TICKS;
    const doors = this.object(DOORS.id, DOORS);
    if (doors) this.clickObject(doors, CLICK.FIRST);
    return true;
  }

  object(id, tile) {
    const { MapObjects, Location } = this.core();
    return MapObjects.get(id, new Location(tile.x, tile.y, 0), null);
  }

  /** As a click on a loc: the route hook, the walk, then the option. */
  clickObject(object, clickType) {
    const { player } = this;
    player.getMovementQueue().walkToObject(object, {
      execute: () => {
        const at = object.getLocation();
        const from = player.getLocation();
        Shared.api().emitObjectInteraction({
          player, object, objectId: object.getId(), clickType,
          location: { x: at.getX(), y: at.getY(), z: at.getZ() },
          sourceLocation: { x: from.getX(), y: from.getY(), z: from.getZ() },
          handled: false,
        });
      },
    }, clickType);
  }

  clickLoc(id, tile, clickType, tick) {
    const object = this.object(id, tile);
    if (!object) return this.retry(tick);
    this.clickObject(object, clickType);
    return this.wait(tick);
  }

  /** The home brazier, whatever its state (Fix, Light and Feed are each its first option). */
  clickBrazier(tick) {
    const { brazier } = Shared.CORNERS[this.role.corner];
    const state = Corners.corner(this.role.corner).brazier;
    const id = state === Shared.BRAZIER.LIT ? Shared.OBJECT.BRAZIER_LIT
      : state === Shared.BRAZIER.BROKEN ? Shared.OBJECT.BRAZIER_BROKEN : Shared.OBJECT.BRAZIER_UNLIT;
    return this.clickLoc(id, brazier, CLICK.FIRST, tick);
  }

  /** Knife on a root, as the client sends an item used on another. */
  fletch(tick) {
    const knife = slotOf(this.player, [Shared.ITEM.KNIFE, Shared.ITEM.FLETCHING_KNIFE]);
    const root = slotOf(this.player, Shared.ITEM.BRUMA_ROOT);
    if (knife < 0 || root < 0) {
      this.role = { ...this.role, fletcher: false };
      return true;
    }
    this.core().UseItemPacketListener.itemOnItem(this.player, knife, root);
    return this.wait(tick);
  }

  /** An inventory item's first option (eat a cake, drink a potion). */
  useItem(slot, tick) {
    if (slot < 0) return true;
    const { ItemActionPacketListener, Inventory } = this.core();
    const item = this.player.getInventory().getItems()[slot];
    ItemActionPacketListener.handleAction(this.player, Inventory.INTERFACE_ID, item.getId(), slot, 1);
    this.nextTryTick = tick + RETRY_TICKS;
    return true;
  }

  /** Help a downed pyromancer with a potion. */
  heal(index, tick) {
    const npc = Corners.pyromancerNpc(index);
    if (!npc) return this.retry(tick);
    const { player } = this;
    Shared.stopAction(player);
    player.getMovementQueue().walkToEntity(npc, () => {
      const at = npc.getLocation();
      Shared.api().emitNpcInteraction({
        player, npc, npcId: npc.getId(), npcIndex: npc.getIndex(), clickType: CLICK.FIRST,
        location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
      });
    }, CLICK.FIRST);
    return this.wait(tick);
  }

  /** Keep potions: concoctions from the crate, herbs from the sprouting roots, then mix. */
  brew(tick) {
    const { player } = this;
    const unf = countOf(player, Shared.ITEM.REJUVENATION_UNF);
    const herbs = countOf(player, Shared.ITEM.BRUMA_HERB);
    if (unf > 0 && herbs > 0) {
      this.core().UseItemPacketListener.itemOnItem(player, slotOf(player, Shared.ITEM.BRUMA_HERB), slotOf(player, Shared.ITEM.REJUVENATION_UNF));
      return this.wait(tick);
    }
    if (unf === 0) {
      return this.clickLoc(LOC.CONCOCTION_CRATE, nearest(player.getLocation(), CONCOCTION_CRATES), CLICK.FIRST, tick);
    }
    if (herbs >= herbsWanted(unf)) return true;
    return this.clickLoc(LOC.SPROUTING_ROOTS, nearest(player.getLocation(), SPROUTING_ROOTS), CLICK.FIRST, tick);
  }

  wait(tick) {
    this.pending = { until: tick + CLICK_PATIENCE_TICKS };
    this.nextTryTick = tick + RETRY_TICKS;
    return true;
  }

  retry(tick) {
    this.nextTryTick = tick + RETRY_TICKS;
    return true;
  }
}

/** A cake's partly-eaten forms, which are food too. */
function CAKE_BITES() {
  const { ItemIdentifiers } = Shared.core();
  return [ItemIdentifiers._2_3_CAKE, ItemIdentifiers.SLICE_OF_CAKE].filter((id) => Number.isInteger(id));
}

// --- Kit ---------------------------------------------------------------------------------

function kitOut(player, serial, random = Math.random) {
  const { Skill, ItemIdentifiers, Item, Equipment, Flag } = Shared.core();
  const skills = player.getSkillManager();
  for (const [name, range] of Object.entries(LEVELS)) skills.setLevel(Skill[name], randomInt(range, random));
  player.setHitpoints?.(skills.getMaxLevel(Skill.HITPOINTS));

  const equipment = player.getEquipment();
  const outfit = OUTFITS[serial % OUTFITS.length];
  for (const [slot, name] of Object.entries(outfit)) {
    const id = ItemIdentifiers[name];
    if (Number.isInteger(id)) equipment.set(Equipment[`${slot}_SLOT`], new Item(id, 1));
  }
  equipment.refreshItems();
  player.getUpdateFlag?.()?.flag?.(Flag.APPEARANCE);

  const inventory = player.getInventory();
  const woodcutting = skills.getMaxLevel(Skill.WOODCUTTING);
  inventory.adds(woodcutting >= 61 ? ItemIdentifiers.DRAGON_AXE : ItemIdentifiers.RUNE_AXE, 1);
  inventory.adds(Shared.ITEM.KNIFE, 1);
  inventory.adds(Shared.ITEM.TINDERBOX, 1);
  inventory.adds(Shared.ITEM.HAMMER, 1);
  for (let i = 0; i < CAKES; i++) inventory.adds(ItemIdentifiers.CAKE, 1);
}

// --- Population --------------------------------------------------------------------------

function spawnBot() {
  const api = Shared.api();
  const serial = population.serial++;
  const tile = Shared.randomTile(Shared.EXIT_AREA);
  let player = null;
  for (let attempt = 0; attempt < NAME_ATTEMPTS && !player; attempt++) {
    player = createBotPlayer(realisticName(), tile, {
      api, loadPersistence: false, saveRandomizedAppearance: false,
    });
  }
  if (!player) return null;
  player.setPlayerBot(true);
  player.setRunning(true);
  player.setAttribute(ATTR_SKIP_PERSISTENCE, true);
  player.setAttribute(BOT_ATTRIBUTE, true);
  kitOut(player, serial);
  api.emitPlayerLogin({ player, username: player.getUsername() });
  const brain = new WintertodtBot(player, roleFor(serial));
  population.brains.set(player, brain);
  return brain;
}

function logoutBot(player) {
  population.brains.delete(player);
  if (player.isRegistered?.() === false) return;
  player.setAttribute(ATTR_SKIP_PERSISTENCE, true);
  player.getForcedLogoutTimer?.().start(0);
  player.requestLogout?.();
}

function tick() {
  const tickNow = ++population.tick;
  const { World } = Shared.core();
  const players = [];
  World.getPlayers().forEach((player) => player && players.push(player));
  if (realPlayersAbout(players).length > 0) population.lastRealTick = tickNow;
  const wanted = tickNow - population.lastRealTick <= IDLE_LOGOUT_TICKS ? population.target : 0;

  for (const [player, brain] of [...population.brains]) {
    if (population.brains.size > wanted || brain.tick(tickNow) === false) logoutBot(player);
  }
  for (let count = spawnsNeeded(wanted, population.brains.size); count > 0; count--) spawnBot();
  return true;
}

function start() {
  population.task ??= Shared.repeat(null, 1, tick);
}

/** ::wtbots [count] - how many bots the world keeps while players are about. */
function setTarget({ player, parts }) {
  const value = Number.parseInt(parts?.[1] ?? "", 10);
  if (Number.isInteger(value)) population.target = Math.max(0, Math.min(MAX_TARGET, value));
  player.sendMessage(`Wintertodt bots: ${population.target} (now ${population.brains.size}).`);
  return true;
}

module.exports = function registerWintertodtBots(api) {
  Shared.bind(api);
  api.onServerStartup(start);
  api.registerCommand("wtbots", setTarget, api.core.PlayerRights.DEVELOPER, "Set how many Wintertodt bots join");
};

Object.assign(module.exports, {
  BOT_ATTRIBUTE,
  DEFAULT_TARGET,
  population,
  _test: { herbsWanted, roleFor, realPlayersAbout, spawnsNeeded, decide, dosesOf, WintertodtBot, kitOut, spawnBot, tick, logoutBot, EAT_WARMTH, LEAVE_WARMTH },
});
