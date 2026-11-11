"use strict";

/**
 * Getting a bot anywhere (docs/playerbots.md, "Travel everywhere"): plans with the travel
 * planner (TravelRoutes.AgentMcp.js) over the transport table plus what scouts discovered, then
 * plays the plan the way agent travel_to does, but a tick at a time: walk clicks along the path,
 * and each door, ladder, cave or boat clicked through the same listener a client's click runs,
 * with dialogues answered on the way. A transport that doesn't work is avoided for the rest of
 * the trip and the route planned again.
 */

const { createTravelSearch, toLegs, unmetRequirements, BLOCKED, TRANSPORTS_FILE } = require("./Imports.SppBots");
const { transportIndex } = require("./Transports.SppBots");
const { holdings } = require("./Activities.SppBots");
const Banks = require("./Banks.SppBots");
const Teleports = require("./Teleports.SppBots");
const Networks = require("./Networks.SppBots");
const { HOUSE } = require("./Imports.SppBots");
const { SAVE_DIRECTORY } = require("./Roster.SppBots");
const { answerDialogue, answerPrompt } = require("./Dialogue.SppBots");
const MultiPrompt = { pending: (core, player) => Boolean(core.MultiChatboxPrompt?.getPending?.(player)) };

// Path tiles per walk click: inside the route finder's 128-tile window, as travel_to.
const WALK_STEP = 30;
// A walk that leaves the bot on the same tile this many clicks running is stuck.
const STUCK_CLICKS = 3;
// A transport's object or NPC is looked for this close to where it's clicked from.
const CLICK_RADIUS = 10;
// Boats and stairs land loosely; doors land exactly.
const ARRIVE_REACH = 2;
const MAX_ANSWERS = 8;
// A teleport lands on a random tile near its destination; a few brain ticks (each up to 4 game
// ticks for a bot nobody watches) is plenty for the animation.
const TELEPORT_LANDING = 4;
// How long a cast may take to land, in ms (the minigame teleport is a long sequence); a bot
// still mid-teleport is given longer.
// In the house: getting in, then each step inside (walking to the furniture, its menu).
const HOUSE_ENTER_MS = 15000;
const HOUSE_STEP_MS = 20000;
// Walking up to a tree or ring and its menu opening; then the landing.
const NETWORK_MENU_MS = 20000;
const NETWORK_LANDING_MS = 12000;
const TELEPORT_PATIENCE_MS = { spell: 8000, tablet: 8000, jewellery: 8000, minigame: 30000 };
const COINS = 995;
const TOLL_OPTION = /^pay-toll\((\d+)gp\)$/i;
// Transports bots can't use yet: their destination is picked on an interface.
const UNSUPPORTED_TYPES = new Set(["charter_ships", "canoes"]);
// Rows that are tricks, not ways a player travels ("Shantay Pass arrest": jailed in Port Sarim).
const AVOIDED_INFO = /arrest/i;
// The table's house portals ("Home Portal" to Shortest Path's stand-in house at 1858,7051): the
// server puts the player in their real house instead, where the route doesn't go on. Houses are
// spp-bots' own hops (houseHops). A bank walk from Rimmington took one and stood in sppdev's house.
const HOUSE_PORTAL_MENU = /^home portal$/i;
// A walk to the nearest bank is a walk: no boats or networks. The Port Sarim ship made the Pest
// Control island's bank the "nearest" from Rimmington (sppdev, the prayer host after logins).
const VEHICLE_TYPES = new Set(["boats", "ships", "canoes", "charter_ships", "magic_carpets", "minecarts"]);
// Options NPC boats show before a quest renames them (as travel_to).
const TRAVEL_OPTIONS = ["travel", "pay-fare", "take-boat", "board", "sail"];
const DOOR_NAME = /door|gate|curtain/i;
const DOOR_OPTION = /^(open|release|pay-toll\(\d+gp\))$/i;
// The account unlocks the table checks, and the event that answers each (as travel_to).
const UNLOCK_QUERIES = {
  CANOE_AXE: { event: "canoes:stored-axe", request: { stored: false }, answer: "stored" },
  KARAMJA_ELITE: { event: "diary:is-complete", request: { diary: "karamja", tier: "elite", complete: false }, answer: "complete" },
};

const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const tileOf = (location) => ({ x: location.getX(), y: location.getY(), z: location.getZ() });
const asTile = ([x, y, z]) => ({ x, y, z });
const transportKey = (transport) => `${transport.menu}@${transport.from.join(",")}`;

function createMap(core) {
  const { RegionManager, MapObjects, ObjectDefinition } = core;
  const regions = new Map();
  const getFlag = (x, y, z) => {
    const region = (x >> 6) * 256 + (y >> 6);
    if (!regions.has(region)) regions.set(region, RegionManager.getRegion(x, y) !== undefined);
    return regions.get(region) ? RegionManager.getClipping(x, y, z, null) : BLOCKED;
  };
  // A region's objects are only in MapObjects once its map files are loaded (as the agent's
  // nearby() does): a bot alone in a region would otherwise find no tree, ring or gate there.
  const loaded = new Set();
  const load = (x, y) => {
    const region = (x >> 6) * 256 + (y >> 6);
    if (loaded.has(region)) return;
    loaded.add(region);
    RegionManager.loadMapFiles?.(x, y, false);
  };
  const objectsAt = (x, y, z) => (load(x, y), MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? [])
    .filter((object) => {
      const at = object.getLocation();
      return at.getX() === x && at.getY() === y && at.getZ() === z;
    });
  /** A closed door, gate or curtain on the tile, as the planner's doorAt (travel_to's). */
  const doorAt = (player) => (x, y, z) => {
    for (const object of objectsAt(x, y, z)) {
      const definition = ObjectDefinition.forPlayer(object.getId(), player);
      const name = definition?.getName?.() ?? "";
      const option = definition?.getInteractions?.()?.find((value) => DOOR_OPTION.test(value ?? ""));
      if (DOOR_NAME.test(name) && option) return { type: "map-door", menu: `${option} ${name}`, id: object.getId(), object: { x, y, z } };
    }
    return null;
  };
  /** The nearest object in the player's instance (their house) whose name matches, or null. */
  const instanceObject = (player, name, option = null, radius = 40) => {
    const area = player.getPrivateArea?.();
    if (!area) return null;
    const here = player.getLocation();
    const z = here.getZ();
    let best = null;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const x = here.getX() + dx;
        const y = here.getY() + dy;
        const tile = new core.Location(x, y, z);
        const found = [...(MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? []), ...(area.getTemplateObjects?.(tile) ?? [])];
        for (const object of found) consider(object, Math.max(Math.abs(dx), Math.abs(dy)));
      }
    }
    // A house keeps its furniture on the instance, not in MapObjects.
    for (const object of [...(area.furnitureObjects ?? []), ...(area.extraObjects ?? [])]) {
      const at = object.getLocation();
      if (at.getZ() === z) consider(object, Math.max(Math.abs(at.getX() - here.getX()), Math.abs(at.getY() - here.getY())));
    }
    return best?.object ?? null;
    function consider(object, distance) {
      const definition = ObjectDefinition.forPlayer(object.getId(), player);
      if (!name.test(String(definition?.getName?.() ?? ""))) return;
      // The built piece, not its empty build space (which shares the name).
      if (option && !(definition?.getInteractions?.() ?? []).some((value) => String(value ?? "").toLowerCase() === option)) return;
      if (!best || distance < best.distance) best = { object, distance };
    }
  };
  return { getFlag, objectsAt, doorAt, instanceObject };
}

function carriedBy(player) {
  const carried = new Map();
  for (const container of [player.getInventory(), player.getEquipment()]) {
    for (const item of container.getItems()) {
      if (item && item.getId() >= 0 && item.getAmount() > 0) carried.set(item.getId(), (carried.get(item.getId()) ?? 0) + item.getAmount());
    }
  }
  return carried;
}

/**
 * What a bot carries and has done, in the terms the transport table's requirements use. With
 * `owned`, items count wherever the account has them (the bank too): the trip can fetch them.
 */
function requirementsOf(core, api, player, { owned = false } = {}) {
  const { Skill } = core;
  const carried = owned ? holdings(player) : carriedBy(player);
  const sender = player.getPacketSender();
  return {
    level: (name) => {
      const skill = Skill.values().find((s) => s.getName().toLowerCase() === name.toLowerCase());
      return skill ? player.getSkillManager().getCurrentLevel(skill) : undefined;
    },
    count: (ids) => ids.reduce((sum, id) => sum + (carried.get(id) ?? 0), 0),
    unlocked: (name) => {
      const ask = UNLOCK_QUERIES[name];
      if (!ask) return false;
      const request = { player, ...ask.request };
      api.emitCustomEvent(ask.event, request);
      return request[ask.answer] === true;
    },
    questComplete: (name) => {
      const request = { player, name, complete: false };
      api.emitCustomEvent("quest:is-complete", request);
      return request.complete === true;
    },
    varbit: (id) => sender.getVarbit(id),
    varp: (id) => sender.getVarp(id),
  };
}

/**
 * Items the route's transports need that the bot isn't carrying but owns (a boat fare in the
 * bank), as bank withdrawals: [{ item, amount }]. Totals over the trip (two fares, two lots).
 */
function itemsToFetch(legs, player, tollOf = () => 0) {
  const itemGroups = require(TRANSPORTS_FILE).itemGroups;
  const carried = carriedBy(player);
  const owned = holdings(player);
  const wanted = new Map();
  for (const leg of legs) {
    if (leg.kind !== "transport") continue;
    // A toll gate the table lists as a plain door (Al Kharid's): its fare is on the gate.
    const toll = tollOf(leg.transport);
    const items = [leg.transport.items, toll > 0 && (owned.get(COINS) ?? 0) >= toll + (wanted.get(COINS) ?? 0) ? `COINS=${toll}` : null].filter(Boolean).join("&");
    for (const all of String(items).replace(/\s+/g, "").toUpperCase().split("&").filter(Boolean)) {
      const options = all.split("|").filter(Boolean).map((option) => {
        const [name, quantity] = option.split("=");
        const ids = itemGroups[name] ?? (Number.isInteger(Number(name)) ? [Number(name)] : []);
        return { name, ids, amount: Number(quantity) || 0 };
      }).filter((option) => !option.name.startsWith("UNLOCK_") && option.amount > 0);
      const has = (counts, option) => option.ids.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0) >= option.amount + (wanted.get(option.ids[0]) ?? 0);
      if (options.length === 0 || options.some((option) => has(carried, option))) continue;
      const option = options.find((candidate) => has(owned, candidate));
      if (!option) continue;
      // The id the account has most of stands for the group (any axe, any coins).
      const id = [...option.ids].sort((a, b) => (owned.get(b) ?? 0) - (owned.get(a) ?? 0))[0];
      wanted.set(id, (wanted.get(id) ?? 0) + option.amount);
    }
  }
  return [...wanted].map(([item, amount]) => ({ item, amount })).filter(({ item, amount }) => (carried.get(item) ?? 0) < amount);
}

// Planning runs on the game thread, so it's shared out: tickPlanner (the plugin's tick task) gives
// all searches together PLAN_BUDGET_MS a tick, oldest first, and only MAX_SEARCHES are under way
// at once (one that fails can hold hundreds of thousands of tiles). A bot whose plan isn't done
// yet waits. Bots plan with a weighted heuristic: a route a little longer than the shortest, as a
// player's often is, found in far fewer steps.
const PLAN_BUDGET_MS = 12;
// More while the server has time to spare (its slowest recent tick, every 10 ticks): a busy
// server gets PLAN_BUDGET_MS, a quiet one up to PLAN_BUDGET_MAX_MS.
const PLAN_BUDGET_MAX_MS = 30;
const QUIET_TICK_MS = 100;
// A search that has done less than this goes first (an ordinary trip, a bank walk); above it the
// oldest search has the time left, so long trips finish one after another, not all together.
const SHORT_SEARCH = 20000;
// Small enough that every running search gets a turn each tick: a short plan mustn't queue
// behind a long one.
const PLAN_CHUNK = 500;
const MAX_SEARCHES = 8;
// Tiles one bot search may expand: with teleports in the graph a route not found by then is
// "too far", and a cap this size keeps a search's memory and time small.
const MAX_EXPANSIONS = 250000;
// A walk to the nearest bank (no teleports) searches outward for any bank stand the bot can reach
// (a guild it isn't in doesn't count), so it fails only with no bank this near. Small enough to
// never wait for a slot (SMALL_SEARCH).
const PLAIN_MAX_EXPANSIONS = 60000;
// A search this small holds little memory, so it never waits for a slot.
const SMALL_SEARCH = 60000;
const MAX_REPLANS = 8;
const ABANDONED_MS = 15000;
const HEURISTIC_WEIGHT = 2;
const planner = { queue: [], budgetMs: PLAN_BUDGET_MS, ticks: 0 };
// Trips that ran to the cap ("too far"), by start and goal region (64x64), for every bot a while:
// it's the map that's in the way more than the account, and each one costs MAX_EXPANSIONS.
const TOO_FAR_MS = 10 * 60 * 1000;
const tooFar = new Map();
const regionPair = (from, to) => `${from.z}:${from.x >> 6},${from.y >> 6}>${to.z}:${to.x >> 6},${to.y >> 6}`;

// Checked when they're built (Teleports/Networks.SppBots.js), not against the table's requirements.
const NETWORK_TYPES = new Set(["teleport", "spirit_tree", "fairy_ring"]);
// A bank visit before a teleport: walking up, withdrawing, closing the bank.
const BANK_VISIT_TICKS = 10;
const tileKey = (x, y, z) => z * 268435456 + x * 16384 + y;
let bankStands = null;

/** Tiles a player banks from: beside booths and chests, across from bankers (Banks.SppBots.js). */
function bankStandsOf(core, map) {
  if (!bankStands) bankStands = Banks.bankStandKeys(core, map.getFlag);
  return bankStands;
}

/** A teleport as a transport the planner can take from `from`; `fetch` withdrawals come first. */
function teleportTransport(entry, from, extraTicks = 0) {
  return {
    type: "teleport", menu: entry.menu, id: null, from, to: [entry.to.x, entry.to.y, entry.to.z],
    ticks: Teleports.costOf(entry) + extraTicks, teleport: entry, fetch: entry.fetch ?? [],
  };
}

// A step into a tile is stopped by the wall on the side it enters from (TravelRoutes' STRAIGHT).
const WALL_ENTERED = [
  { dx: 0, dy: 1, wall: 0x20 }, { dx: 1, dy: 0, wall: 0x80 }, { dx: 0, dy: -1, wall: 0x2 }, { dx: -1, dy: 0, wall: 0x8 },
];
const wallSided = new WeakMap();
const CANT_REACH = /can't reach (that|it)/i;

/**
 * The transport index plus, for each discovered object transport, the same transport from an open
 * tile just across a wall from where the scout stood. A player clicks the object from either side
 * and the server walks them to it: a ship's gangplank from the deck the boat leaves them on
 * (Ardougne's: the scout stood on the far side of the deck rail).
 */
function withWallSides(index, getFlag) {
  if (wallSided.has(index)) return wallSided.get(index);
  const extended = new Map(index);
  for (const transports of index.values()) {
    for (const transport of transports) {
      if (transport.type !== "discovered" || transport.id == null) continue;
      const [x, y, z] = transport.from;
      for (const { dx, dy, wall } of WALL_ENTERED) {
        // Standing at (x - dx, y - dy), a step (dx, dy) into the origin meets its wall.
        const nx = x - dx;
        const ny = y - dy;
        if (!(getFlag(x, y, z) & wall) || getFlag(nx, ny, z) & BLOCKED) continue;
        const at = tileKey(nx, ny, z);
        extended.set(at, [...(extended.get(at) ?? []), { ...transport, from: [nx, ny, z], ticks: (transport.ticks ?? 1) + 2 }]);
      }
    }
  }
  wallSided.set(index, extended);
  return extended;
}

/**
 * A search for a route for `player` to `goal`; `failed` are transports to leave out. Queue it with
 * advancePlan; its `search.result` is planTravel's.
 */
// Wilderness level by tile, one region (64x64) at a time, worked out as it's asked for: planning
// asks for every tile it searches, and the server's own check goes through the caves' hooks.
const wildernessLevels = new Map();
function wildernessLevel(Wilderness, x, y) {
  const region = (x >> 6) * 256 + (y >> 6);
  let levels = wildernessLevels.get(region);
  if (!levels) wildernessLevels.set(region, levels = new Int16Array(4096).fill(-1));
  const index = ((x & 63) << 6) | (y & 63);
  if (levels[index] < 0) levels[index] = Math.max(0, Number(Wilderness.levelAt(x, y)) || 0);
  return levels[index];
}

function startPlan({ api, map, player, goal, isGoal = null, failed = new Set(), exact = false, ignoreRequirements = false, owned = false, avoidWilderness = false, teleports: useTeleports = true }) {
  const { Wilderness } = api.core;
  // A player going from one safe place to another goes round the Wilderness, not through it.
  const getFlag = avoidWilderness
    ? (x, y, z) => (wildernessLevel(Wilderness, x, y) > 0 ? BLOCKED : map.getFlag(x, y, z))
    : map.getFlag;
  const index = withWallSides(transportIndex(), map.getFlag);
  const itemGroups = require(TRANSPORTS_FILE).itemGroups;
  const requirements = requirementsOf(api.core, api, player, { owned });
  const verdicts = new Map();
  const usable = (transport) => {
    if (failed.has(transportKey(transport)) || UNSUPPORTED_TYPES.has(transport.type) || AVOIDED_INFO.test(transport.info ?? "") || HOUSE_PORTAL_MENU.test(transport.menu ?? "")) return false;
    if (!useTeleports && (VEHICLE_TYPES.has(transport.type) || NETWORK_TYPES.has(transport.type))) return false;
    if (ignoreRequirements || transport.type === "map-door" || transport.type === "discovered" || transport.type === "loc_teleports" || NETWORK_TYPES.has(transport.type)) return true;
    if (!verdicts.has(transport)) verdicts.set(transport, unmetRequirements(transport, itemGroups, requirements).length === 0);
    return verdicts.get(transport);
  };
  // Teleports (not when only asking whether the map has a way): the ones on the bot from where it
  // stands, the ones in its bank from any bank.
  const start = tileOf(player.getLocation());
  const startKey = tileKey(start.x, start.y, start.z);
  let fromStart = [];
  let fromBank = [];
  let hops = new Map();
  if (!ignoreRequirements && useTeleports) {
    const counts = owned ? holdings(player) : carriedBy(player);
    const teleports = Teleports.teleportsFor(api, player, carriedBy(player), counts);
    fromStart = teleports.carried.map((entry) => teleportTransport(entry, [start.x, start.y, start.z]));
    fromBank = teleports.banked;
    // Spirit trees and fairy rings: from each tree or ring to where it goes.
    hops = Networks.networkHops(api, player, counts);
  }
  const stands = fromBank.length ? bankStandsOf(api.core, map) : null;
  const transportsAt = (x, y, z) => {
    const key = tileKey(x, y, z);
    const table = index.get(key) ?? [];
    const here = key === startKey ? fromStart : [];
    const banked = stands?.has(key) ? fromBank.map((entry) => teleportTransport(entry, [x, y, z], BANK_VISIT_TICKS)) : [];
    const network = hops.get(key) ?? [];
    return here.length || banked.length || network.length ? [...table, ...here, ...banked, ...network] : table;
  };
  const search = createTravelSearch({
    from: start,
    to: isGoal ? null : goal,
    shortcuts: isGoal ? [] : require("./Shortcuts.SppBots").networkShortcuts(hops, goal),
    isGoal,
    getFlag,
    transportsAt,
    doorAt: map.doorAt(player),
    usable,
    goalReach: exact ? 0 : undefined,
    heuristicWeight: HEURISTIC_WEIGHT,
    // The nearest of many (a bank, a tree) is near or nowhere: the small cap.
    maxExpansions: useTeleports && !isGoal ? MAX_EXPANSIONS : PLAIN_MAX_EXPANSIONS,
  });
  return { search, ms: 0, ticks: 0, touchedAt: Date.now(), name: player.getUsername(), from: start, goal, plain: !useTeleports, anyone: ignoreRequirements, createdAt: Date.now() };
}

/** The planner's own numbers since last asked: budget, ms used per tick it ran. */
function plannerLoad() {
  const load = { budgetMs: planner.budgetMs, msPerTick: planner.usedTicks ? +(planner.usedMs / planner.usedTicks).toFixed(1) : 0, ticks: planner.usedTicks ?? 0 };
  planner.usedMs = 0;
  planner.usedTicks = 0;
  return load;
}

/** The planner's queue (::sppbots planner): each search, oldest first. */
function plannerStatus() {
  const nowMs = Date.now();
  return planner.queue.map((plan) => ({
    name: plan.name, from: plan.from, goal: plan.goal, plain: plan.plain, anyone: plan.anyone,
    expansions: plan.search.expansions, ticks: plan.ticks, ms: Math.round(plan.ms), ageS: Math.round((nowMs - plan.createdAt) / 1000),
  }));
}

/** Queues the plan (once) and says whether it's done; tickPlanner does the searching. */
function advancePlan(plan) {
  plan.touchedAt = Date.now();
  if (plan.search.done) return true;
  if (!planner.queue.includes(plan)) planner.queue.push(plan);
  return false;
}

/**
 * Every game tick: searches under SHORT_SEARCH first, least advanced first; then the oldest of
 * the rest. Big ones (over SMALL_SEARCH, memory) only MAX_SEARCHES at a time.
 */
function tickPlanner(core = null) {
  const nowMs = Date.now();
  // A plan nobody has asked about for a while belongs to a bot that's gone.
  planner.queue = planner.queue.filter((plan) => !plan.search.done && nowMs - plan.touchedAt < ABANDONED_MS);
  if (core && planner.ticks++ % 10 === 0) {
    const slowest = Number(core.ServerPerf?.getSummary?.(10)?.maxTickMs ?? Infinity);
    planner.budgetMs = slowest < QUIET_TICK_MS ? PLAN_BUDGET_MAX_MS : PLAN_BUDGET_MS;
  }
  let big = 0;
  const running = planner.queue.filter((plan) => plan.search.expansions < SMALL_SEARCH || big++ < MAX_SEARCHES);
  if (running.length === 0) return;
  const started = performance.now();
  while (performance.now() - started < planner.budgetMs) {
    let plan = null;
    for (const candidate of running) {
      if (candidate.search.done) continue;
      const short = candidate.search.expansions < SHORT_SEARCH;
      if (!plan) { plan = candidate; continue; }
      const best = plan.search.expansions < SHORT_SEARCH;
      if (short !== best) { if (short) plan = candidate; continue; }
      // Both short: the least advanced. Both long: the oldest (the queue is oldest first).
      if (short && candidate.search.expansions < plan.search.expansions) plan = candidate;
    }
    if (!plan) break;
    const sliceStarted = performance.now();
    plan.search.run(PLAN_CHUNK);
    plan.ms += performance.now() - sliceStarted;
  }
  for (const plan of running) plan.ticks += 1;
  planner.usedMs = (planner.usedMs ?? 0) + (performance.now() - started);
  planner.usedTicks = (planner.usedTicks ?? 0) + 1;
  planner.queue = planner.queue.filter((plan) => !plan.search.done);
}

function dropPlan(plan) {
  if (plan) planner.queue = planner.queue.filter((other) => other !== plan);
}

/**
 * A brain action that takes the bot to `goal` ({ x, y, z }), or with `isGoal` ((x, y, z) => bool)
 * to the nearest tile it accepts, a plain walk (the nearest bank). Succeeds on arrival (within one
 * tile unless `exact`), fails when no route is left.
 */
function createTravelAction({ api, goal = null, isGoal = null, exact = false, log = () => {}, plain = false, fetch: mayFetch = true }) {
  const core = api.core;
  const map = createMap(core);
  const objects = new core.ObjectActionPacketListener();
  const npcs = new core.NPCOptionPacketListener();
  const states = new WeakMap();

  const stateOf = (player) => {
    if (!states.has(player)) states.set(player, { legs: null, at: 0, failed: new Set(), stuck: 0, lastWalkFrom: null, ride: null, replans: 0 });
    return states.get(player);
  };

  /**
   * Whether the bot owns what a teleport landing near `to` takes (a Zul-andra scroll): "too far"
   * by walking, remembered for every bot, isn't too far for it. (Rob Ok, given scrolls for Zulrah,
   * was refused at once by the known "too far" from the time it had none.)
   */
  function ownsTeleportNear(player, to) {
    const have = require("./CombatTask.SppBots").owned(api.core, player);
    return Teleports.catalogOf(api.core).some((entry) => entry.to && entry.to.z === to.z
      && chebyshev(entry.to, to) <= 64
      && (entry.items ?? []).length > 0
      && entry.items.every(({ ids, amount }) => ids.some((id) => (have.get(id) ?? 0) >= amount)));
  }

  /** Starts planning again from where the bot stands; false once it has planned too often. */
  function replan(player, state, { free = false } = {}) {
    if (!free && state.replans >= MAX_REPLANS) return false;
    if (!free) state.replans += 1;
    dropPlan(state.plan?.job);
    const here = tileOf(player.getLocation());
    if (goal && !plain && (tooFar.get(regionPair(here, goal)) ?? 0) > Date.now() && !ownsTeleportNear(player, goal)) {
      state.noRoute = "too far";
      log("spp_bots_no_route", { name: player.getUsername(), from: here, goal, why: "too far (known)" });
      state.plan = null;
      return false;
    }
    const avoidWilderness = !state.crossWilderness && api.core.Wilderness.levelAt(here.x, here.y) === 0 && (!goal || api.core.Wilderness.levelAt(goal.x, goal.y) === 0);
    // `plain`: a walk to a bank, which mustn't itself need a bank trip (no teleports, nothing to fetch).
    state.plan = { job: startPlan({ api, map, player, goal, isGoal, failed: state.failed, exact, owned: mayFetch && !state.fetchFailed && !plain, avoidWilderness, teleports: !plain }), purpose: "route", avoidWilderness };
    state.legs = null;
    state.at = 0;
    state.ride = null;
    state.stuck = 0;
    return true;
  }

  /** One tick of planning; a result once the search is done (or undefined while it isn't). */
  function plan(player, state) {
    const { job, purpose, avoidWilderness } = state.plan;
    if (!advancePlan(job)) return "running";
    state.plan = null;
    state.slowestPlanMs = Math.max(state.slowestPlanMs ?? 0, job.ms);
    if (job.ms > 50) log("spp_bots_slow_plan", { name: player.getUsername(), ms: Math.round(job.ms), ticks: job.ticks, expansions: job.search.expansions, goal, purpose });
    const result = job.search.result;
    if (purpose === "route") {
      if (result) {
        state.legs = toLegs(result.steps);
        const fetch = state.fetchFailed || plain || !mayFetch ? [] : itemsToFetch(state.legs, player, (transport) => tollOf(player, transport));
        if (fetch.length) state.fetch = { items: fetch, action: null };
        return "running";
      }
      if (avoidWilderness && !plain) {
        // The only way is through the Wilderness: so be it. (Not for a bank: another one will do.)
        state.crossWilderness = true;
        state.replans -= 1;
        return replan(player, state) ? "running" : "failed";
      }
      if (job.search.capped || plain) {
        // A bank walk: no need to ask why, the visit tries another bank.
        // Too far for one search: asking again without requirements would only hit the cap too.
        state.noRoute = job.search.capped ? "too far" : "map";
        if (job.search.capped && goal && !plain) tooFar.set(regionPair(tileOf(player.getLocation()), goal), Date.now() + TOO_FAR_MS);
        log("spp_bots_no_route", { name: player.getUsername(), from: tileOf(player.getLocation()), goal, why: state.noRoute });
        return "failed";
      }
      // Is it this account (a quest, a level, the fare) or the map? Plan once more, ignoring requirements.
      state.plan = { job: startPlan({ api, map, player, goal, isGoal, failed: state.failed, exact, ignoreRequirements: true }), purpose: "anyone" };
      return "running";
    }
    // A search that stopped at its cap doesn't know: the place may be too far for one plan.
    state.noRoute = result ? "requirements" : job.search.capped ? "too far" : "map";
    log("spp_bots_no_route", { name: player.getUsername(), from: tileOf(player.getLocation()), goal, why: state.noRoute });
    return "failed";
  }

  /**
   * A bank trip for what the route needs (a boat fare), as a player goes to the bank before a
   * trip; then the route is planned again from the bank. If the bank doesn't work out, the bot
   * plans with only what it carries.
   */
  function fetchItems(ctx, state) {
    const fetch = state.fetch;
    if (!fetch.visit) {
      // No room for it (a full load of ore): everything goes in first. The bank tops up only to
      // the amount, so a part (5 of a 30 gp fare) is simply topped up.
      const roomy = ctx.player.getInventory().getFreeSlots() >= fetch.items.length;
      fetch.visit = createBankVisit({ api, withdraw: fetch.items, depositAll: !roomy, log });
      log("spp_bots_travel_fetch", { name: ctx.player.getUsername(), items: fetch.items });
    }
    const result = fetch.visit.update(ctx);
    if (result !== "success" && result !== "failed") return "running";
    fetch.visit.stop(ctx);
    state.fetch = null;
    const carried = carriedBy(ctx.player);
    if (result === "failed" || fetch.items.some(({ item, amount }) => (carried.get(item) ?? 0) < amount)) state.fetchFailed = true;
    return replan(ctx.player, state) ? "running" : "failed";
  }

  function walk(player, state, leg) {
    const here = tileOf(player.getLocation());
    const tiles = leg.tiles;
    const last = tiles[tiles.length - 1];
    if (here.x === last.x && here.y === last.y && here.z === last.z) {
      state.at += 1;
      return "running";
    }
    if (player.getMovementQueue().size?.() > 0) return "running";
    if (state.lastWalkFrom && state.lastWalkFrom.x === here.x && state.lastWalkFrom.y === here.y && state.lastWalkFrom.z === here.z) {
      state.stuck += 1;
      if (state.stuck >= STUCK_CLICKS) {
        log("spp_bots_walk_stuck", { name: player.getUsername(), at: here, toward: last });
        return replan(player, state) ? "running" : "failed";
      }
    } else {
      state.stuck = 0;
    }
    let nearest = 0;
    tiles.forEach((tile, i) => {
      if (tile.z === here.z && chebyshev(tile, here) <= chebyshev(tiles[nearest], here)) nearest = i;
    });
    const target = tiles[Math.min(tiles.length - 1, nearest + WALK_STEP)];
    state.lastWalkFrom = here;
    player.getMovementQueue().requestWalk(new core.Location(target.x, target.y, target.z), null);
    return "running";
  }

  /** The gp a transport's object asks through a "Pay-toll(Ngp)" option, or 0. */
  function tollOf(player, transport) {
    const from = asTile(transport.from);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const object of map.objectsAt(from.x + dx, from.y + dy, from.z)) {
          // By name too: the map holds a multi-loc's raw id, the table the resolved one.
          const definition = core.ObjectDefinition.forPlayer(object.getId(), player);
          const name = String(definition?.getName?.() ?? "").toLowerCase();
          if (object.getId() !== transport.id && !(name && transport.menu.toLowerCase().endsWith(` ${name}`))) continue;
          const options = definition?.getInteractions?.() ?? [];
          for (const option of options) {
            const toll = TOLL_OPTION.exec(String(option ?? ""));
            if (toll) return Number(toll[1]);
          }
        }
      }
    }
    return 0;
  }

  /** The object or NPC a transport clicks, near where it's clicked from, and the option. */
  function resolveClick(player, transport) {
    const menu = transport.menu.toLowerCase();
    const from = asTile(transport.from);
    const optionFor = (name, options, fallback) => {
      const lower = String(name ?? "").toLowerCase();
      const index = options.findIndex((option) => option && `${option.toLowerCase()} ${lower}` === menu);
      if (index >= 0) return index;
      const prefix = options.findIndex((option) => option && menu.startsWith(`${option.toLowerCase()} `));
      if (prefix >= 0) return prefix;
      return fallback ? options.findIndex((option) => option && TRAVEL_OPTIONS.includes(option.toLowerCase())) : -1;
    };
    // Objects: the transport's own, by id first, then by name (an id this cache has differently).
    let best = null;
    for (let dx = -CLICK_RADIUS; dx <= CLICK_RADIUS; dx++) {
      for (let dy = -CLICK_RADIUS; dy <= CLICK_RADIUS; dy++) {
        for (const object of map.objectsAt(from.x + dx, from.y + dy, from.z)) {
          const definition = core.ObjectDefinition.forPlayer(object.getId(), player);
          const name = definition?.getName?.() ?? "";
          const byId = object.getId() === transport.id;
          if (!byId && !menu.endsWith(` ${name.toLowerCase()}`)) continue;
          const options = definition?.getInteractions?.() ?? [];
          // Pay the toll rather than "Open" (which only starts the guard's dialogue), if carrying it.
          const toll = options.findIndex((value) => TOLL_OPTION.test(String(value ?? "")));
          const paid = toll >= 0 && carriedBy(player).get(COINS) >= Number(TOLL_OPTION.exec(options[toll])[1]);
          const option = paid ? toll : optionFor(name, options, false);
          if (option < 0) continue;
          const score = (byId ? 0 : 100) + Math.max(Math.abs(dx), Math.abs(dy));
          if (!best || score < best.score) best = { kind: "object", object, option: options[option], score };
        }
      }
    }
    if (best) return best;
    // NPCs: boatmen, ferrymen, the Mage of Zamorak.
    let npcBest = null;
    core.World.getNpcs().forEach((npc) => {
      if (!npc || !npc.getLocation) return;
      const at = tileOf(npc.getLocation());
      if (at.z !== from.z || chebyshev(at, from) > CLICK_RADIUS) return;
      const definition = npc.getCurrentDefinition?.(player) ?? npc.getDefinition?.();
      const name = definition?.getName?.() ?? "";
      const byId = npc.getId?.() === transport.id;
      if (!byId && !menu.endsWith(` ${name.toLowerCase()}`)) return;
      const options = definition?.getActions?.() ?? [];
      const option = optionFor(name, options, true);
      if (option < 0) return;
      const score = (byId ? 0 : 100) + chebyshev(at, from);
      if (!npcBest || score < npcBest.score) npcBest = { kind: "npc", npc, clickType: option + 1, score };
    });
    return npcBest;
  }

  /**
   * A teleport leg: withdraw what it needs at the bank (then plan again: the teleport is now on the
   * bot), cast, and watch for the landing. A refusal (a quest lock) isn't planned again.
   */
  function teleport(player, state, leg) {
    const { transport } = leg;
    const entry = transport.teleport;
    const here = tileOf(player.getLocation());
    if (!state.ride) {
      if (transport.fetch.length) {
        state.fetch = { items: transport.fetch, steps: null };
        return "running";
      }
      if (Number(player.getInterfaceId?.() ?? -1) > 0) player.getPacketSender().sendInterfaceRemoval();
      if (player.busy?.() || player.getCombat?.()?.getAttacker?.()) return "running";
      // Standing still: the minigame (home) teleport can't start while walking, and moving cancels it.
      if (player.getMovementQueue().size?.() > 0) {
        player.getMovementQueue().reset();
        return "running";
      }
      if (!Teleports.cast(api, player, entry)) return fail(player, state, transport, "nothing to cast it with");
      log("spp_bots_teleport", { name: player.getUsername(), teleport: entry.key, from: here });
      state.ride = { ticks: 0, from: here, castAt: Date.now(), house: entry.kind === "house", phase: "entering", since: Date.now() };
      return "running";
    }
    const r = state.ride;
    r.ticks += 1;
    if (r.house && r.phase !== "leaving") return houseRide(player, state, transport, r);
    const waiting = Date.now() - r.castAt < TELEPORT_PATIENCE_MS[entry.kind] || player.isTeleportingReturn?.() === true;
    const to = entry.to;
    if (here.z === to.z && chebyshev(here, to) <= TELEPORT_LANDING) {
      state.ride = null;
      state.at += 1;
      // Landed: plan the rest from here (the landing tile differs a little from the table's).
      return replan(player, state, { free: true }) ? "running" : "failed";
    }
    const dialogue = player.getDialogueManager();
    if (dialogue.isActive() && waiting) {
      answerDialogue(dialogue);
      return "running";
    }
    if (waiting) return "running";
    return refused(player, state, transport, r.castAt);
  }

  /** The server didn't teleport the bot: why (its messages), and not again for a while or at all. */
  function refused(player, state, transport, sinceMs) {
    const { reason, lasting } = Teleports.refuse(player, transport.teleport, sinceMs);
    log("spp_bots_teleport_refused", { name: player.getUsername(), teleport: transport.teleport.key, reason, lasting });
    return fail(player, state, transport, `refused: ${reason}`);
  }

  /**
   * Inside the bot's house: in through the tablet or spell, then the nexus or jewellery box's
   * Teleport Menu and the destination's slot, as a client's clicks. Then the landing, as any
   * teleport's (phase "leaving").
   */
  /** An open tile next to an object in the instance (its clipping), or null. */
  function besideObject(at, player) {
    const { RegionManager } = api.core;
    for (let reach = 1; reach <= 3; reach++) {
      for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== reach) continue;
          const x = at.getX() + dx;
          const y = at.getY() + dy;
          if (!(RegionManager.getClipping(x, y, at.getZ(), player.getPrivateArea?.() ?? null) & BLOCKED)) return { x, y, z: at.getZ() };
        }
      }
    }
    return null;
  }

  function houseRide(player, state, transport, r) {
    const out = transport.teleport.out;
    const elapsed = Date.now() - r.since;
    const next = (phase) => Object.assign(r, { phase, since: Date.now() });
    if (r.phase === "entering") {
      if (HOUSE.houseFor(player) && !player.isTeleportingReturn?.()) return next("furniture"), "running";
      if (player.getDialogueManager().isActive()) answerDialogue(player.getDialogueManager());
      return elapsed < HOUSE_ENTER_MS ? "running" : refused(player, state, transport, r.castAt);
    }
    if (r.phase === "furniture") {
      if (player.busy?.()) return elapsed < HOUSE_STEP_MS ? "running" : fail(player, state, transport, "busy in the house");
      const object = map.instanceObject(player, out.furniture === "nexus" ? /portal nexus/i : /jewellery box/i, "teleport menu");
      if (!object) return elapsed < HOUSE_STEP_MS ? "running" : fail(player, state, transport, `no ${out.furniture} in the house`);
      const at = object.getLocation();
      // Walk up first, beside it (its own tile is blocked). The bot's house doors are open
      // (HOUSE.openDoors at login), so the rooms between are walkable.
      const here = tileOf(player.getLocation());
      if (chebyshev(here, tileOf(at)) > 2) {
        if (!player.getMovementQueue().size?.()) {
          const spot = besideObject(at, player);
          if (!spot) return fail(player, state, transport, `nowhere to stand at the ${out.furniture}`);
          player.getMovementQueue().requestWalk(new api.core.Location(spot.x, spot.y, spot.z), null);
        }
        return elapsed < HOUSE_STEP_MS ? "running" : fail(player, state, transport, `couldn't walk to the ${out.furniture}`);
      }
      objects.executeAction(player, object.getId(), at.getX(), at.getY(), 0, "teleport menu");
      r.clicked = { id: object.getId(), at: tileOf(at), from: tileOf(player.getLocation()), busy: player.busy?.() };
      return next("menu"), "running";
    }
    if (r.phase === "menu") {
      // Out already (the nexus moves the player at once) or on the way (the box's teleport).
      if (!HOUSE.houseFor(player) || player.isTeleportingReturn?.()) {
        r.castAt = Date.now();
        return next("leaving"), "running";
      }
      // The pick, as the menu's click. A bot's menu has no client interface to wait for: the
      // furniture's own menu session takes the click once it's open, and ignores it before.
      if (!player.getMovementQueue().size?.()) {
        const menu = out.furniture === "nexus" ? HOUSE.nexusMenu : HOUSE.jewelleryBoxMenu;
        const childId = out.furniture === "nexus" ? HOUSE.nexusRows : 0;
        api.core.PluginManager.emitInterfaceActionClick({ player, buttonId: (menu << 16) | childId, action: out.slot, groupId: menu, childId, handled: false });
      }
      if (elapsed < HOUSE_STEP_MS) return "running";
      log("spp_bots_house_menu", { name: player.getUsername(), clicked: r.clicked, at: tileOf(player.getLocation()), interfaceId: player.getInterfaceId?.(), busy: player.busy?.(), slot: out.slot });
      return fail(player, state, transport, `the ${out.furniture} menu didn't open`);
    }
    return "running";
  }

  /**
   * A spirit tree or fairy ring: (fairy rings) wield the staff, click the tree's Travel or the
   * ring's Configure, pick the destination on the menu or turn the dials, and watch for the landing.
   */
  function network(player, state, leg) {
    const { transport } = leg;
    const hop = transport.network;
    const here = tileOf(player.getLocation());
    if (!state.ride) {
      if (Number(player.getInterfaceId?.() ?? -1) > 0) player.getPacketSender().sendInterfaceRemoval();
      if (player.busy?.()) return "running";
      if (hop.kind === "fairy_ring") {
        const staff = Networks.heldStaff(player);
        if (!staff) return fail(player, state, transport, "no staff");
        if (!staff.worn) {
          Networks.wieldStaff(api, player);
          return "running";
        }
      }
      // A tree that shows only Talk-to (Khazard Battlefield's): its greeting, then the same menu.
      const click = resolveClick(player, transport)
        ?? (hop.kind === "spirit_tree" ? resolveClick(player, { ...transport, menu: "Talk-to Spirit tree" }) : null);
      if (!click || click.kind !== "object") return fail(player, state, transport, "no tree or ring here");
      const at = click.object.getLocation();
      objects.executeAction(player, click.object.getId(), at.getX(), at.getY(), 0, click.option);
      log("spp_bots_network", { name: player.getUsername(), kind: hop.kind, to: hop.name ?? hop.code, code: hop.code, from: here });
      state.ride = { phase: "menu", since: Date.now() };
      return "running";
    }
    const r = state.ride;
    const to = asTile(transport.to);
    if (here.z === to.z && chebyshev(here, to) <= TELEPORT_LANDING) {
      state.ride = null;
      state.at += 1;
      return replan(player, state, { free: true }) ? "running" : "failed";
    }
    if (r.phase === "menu") {
      if (hop.kind === "spirit_tree" && Networks.spiritMenuOpen(player)) {
        Networks.chooseSpiritTree(api, player, hop);
        Object.assign(r, { phase: "wait", since: Date.now() });
      } else if (hop.kind === "fairy_ring" && Networks.dialsOpen(player)) {
        Networks.dialCode(api, player, hop.code);
        Object.assign(r, { phase: "wait", since: Date.now() });
      } else if (player.getDialogueManager().isActive()) {
        answerDialogue(player.getDialogueManager());
      } else if (Date.now() - r.since > NETWORK_MENU_MS) {
        return fail(player, state, transport, "the menu didn't open");
      }
      return "running";
    }
    if (player.getDialogueManager().isActive()) answerDialogue(player.getDialogueManager());
    if (Date.now() - r.since > NETWORK_LANDING_MS && player.isTeleportingReturn?.() !== true) {
      return fail(player, state, transport, "didn't land");
    }
    return "running";
  }

  function ride(player, state, leg) {
    const { transport } = leg;
    if (transport.type === "teleport") return teleport(player, state, leg);
    if (transport.type === "spirit_tree" || transport.type === "fairy_ring") return network(player, state, leg);
    const here = tileOf(player.getLocation());
    const arrive = leg.arrive ?? asTile(transport.to);
    const from = asTile(transport.from);
    if (!state.ride) {
      // A click while busy does nothing: close what's open (the bank, after fetching a fare) and
      // wait out the rest (a teleport, a forced move).
      if (Number(player.getInterfaceId?.() ?? -1) > 0) player.getPacketSender().sendInterfaceRemoval();
      if (player.busy?.()) return "running";
      const click = resolveClick(player, transport);
      if (!click && transport.type === "map-door") {
        // Someone opened it since the plan was made: walk on through.
        state.at += 1;
        return "running";
      }
      if (!click) {
        log("spp_bots_transport_missing", { name: player.getUsername(), menu: transport.menu, from: transport.from });
        state.failed.add(transportKey(transport));
        return replan(player, state) ? "running" : "failed";
      }
      if (click.kind === "object") {
        const at = click.object.getLocation();
        objects.executeAction(player, click.object.getId(), at.getX(), at.getY(), 0, click.option);
      } else {
        npcs.executeOption(player, click.npc.getIndex(), click.clickType);
      }
      const door = from.z === arrive.z && chebyshev(from, arrive) <= ARRIVE_REACH;
      state.ride = { ticks: 0, idle: 0, last: here, answers: 0, reach: door ? 0 : ARRIVE_REACH, stepped: false, patience: Math.max(6, (transport.ticks ?? 1) + 6) };
      return "running";
    }
    const r = state.ride;
    r.ticks += 1;
    if (here.z === arrive.z && chebyshev(here, arrive) <= r.reach && !player.getPrivateArea?.()) {
      state.ride = null;
      state.at += 1;
      return "running";
    }
    const dialogue = player.getDialogueManager();
    if (dialogue.isActive() || MultiPrompt.pending(core, player)) {
      if (r.answers++ >= MAX_ANSWERS) return fail(player, state, transport, "too many dialogue answers");
      if (!answerPrompt(core, player)) answerDialogue(dialogue);
      r.idle = 0;
      return "running";
    }
    const moved = here.x !== r.last.x || here.y !== r.last.y || here.z !== r.last.z;
    r.last = here;
    r.idle = moved || player.getMovementQueue().size?.() > 0 || player.getPrivateArea?.() ? 0 : r.idle + 1;
    if (r.idle < r.patience) return "running";
    // A door that opened and left the bot in front of it: step through.
    if (!r.stepped && r.reach === 0 && here.x === from.x && here.y === from.y && here.z === from.z) {
      r.stepped = true;
      r.idle = 0;
      player.getMovementQueue().requestWalk(new core.Location(arrive.x, arrive.y, arrive.z), null);
      return "running";
    }
    // Taken somewhere else than the table says (a deck, a different landing): carry on from there.
    if (here.z !== from.z || chebyshev(here, from) > ARRIVE_REACH + 1) {
      return replan(player, state) ? "running" : "failed";
    }
    return fail(player, state, transport, "nothing happened");
  }

  function fail(player, state, transport, reason) {
    // Stuck inside the house (a menu that didn't open): out through its portal, then plan again.
    if (HOUSE.houseFor(player)) HOUSE.leave(player);
    log("spp_bots_transport_failed", { name: player.getUsername(), menu: transport.menu, from: transport.from, reason });
    state.failed.add(transportKey(transport));
    return replan(player, state) ? "running" : "failed";
  }

  return {
    id: "travel",
    goal,
    update(ctx) {
      const player = ctx.player;
      const state = stateOf(player);
      const here = tileOf(player.getLocation());
      const last = state.lastSeen;
      if (!last || last.x !== here.x || last.y !== here.y || last.z !== here.z || state.ride) state.progress = true;
      state.lastSeen = here;
      if (isGoal ? isGoal(here.x, here.y, here.z) : here.z === goal.z && chebyshev(here, goal) <= (exact ? 0 : 1)) {
        dropPlan(state.plan?.job);
        states.delete(player);
        return "success";
      }
      // In an instance the planner has no map; only a ride that's meant to be there goes on (the house).
      if (player.getPrivateArea?.() && !state.ride?.house) return "running";
      if (state.plan) {
        state.progress = true;
        return plan(player, state);
      }
      if (state.fetch) return fetchItems(ctx, state);
      if (!state.legs) return replan(player, state) ? "running" : "failed";
      const leg = state.legs[state.at];
      if (!leg) return replan(player, state) ? "running" : "failed";
      return leg.kind === "transport" ? ride(player, state, leg) : walk(player, state, leg);
    },
    /** For the brain's stall check: moved, or riding (a boat, a dialogue) since it last asked. */
    madeProgress(ctx) {
      const state = states.get(ctx.player);
      if (!state?.progress) return false;
      state.progress = false;
      return true;
    },
    /** Where the planned route ends (null before it's planned). */
    destination(player) {
      const legs = states.get(player)?.legs;
      const last = legs?.[legs.length - 1];
      if (!last) return null;
      return last.kind === "transport" ? asTile(last.transport.to) : last.tiles[last.tiles.length - 1];
    },
    /** Where the trip is now (for ::sppbots trip). */
    describe(player) {
      const state = states.get(player);
      if (!state) return { phase: "not started" };
      const job = state.plan?.job;
      const leg = state.legs?.[state.at];
      const phase = state.plan ? `planning (${state.plan.purpose})` : state.fetch ? "fetching" : !state.legs ? "to plan" : leg?.kind === "transport" ? "transport" : "walking";
      return {
        phase,
        plan: job ? { expansions: job.search.expansions, ticks: job.ticks, ms: Math.round(job.ms), queued: planner.queue.indexOf(job), queue: planner.queue.length } : null,
        leg: leg ? (leg.kind === "transport" ? { transport: leg.transport.menu ?? leg.transport.type, from: leg.transport.from, to: leg.transport.to } : { walkTo: leg.tiles[leg.tiles.length - 1] }) : null,
        legs: state.legs ? `${state.at + 1}/${state.legs.length}` : null,
        ride: state.ride ? { phase: state.ride.phase ?? null, house: Boolean(state.ride.house) } : null,
        fetch: state.fetch ? { items: state.fetch.items, visit: state.fetch.visit?.describe?.(player) ?? null } : null,
        replans: state.replans, failed: [...state.failed], stuck: state.stuck, noRoute: state.noRoute ?? null,
      };
    },
    /** What the trip has been like so far (for ::sppbots tour). */
    report(player) {
      const state = states.get(player);
      return state ? { replans: state.replans, failed: [...state.failed], slowestPlanMs: state.slowestPlanMs ?? 0, noRoute: state.noRoute ?? null } : null;
    },
    stop(ctx) {
      const state = states.get(ctx.player);
      dropPlan(state?.plan?.job);
      state?.fetch?.visit?.stop?.(ctx);
      states.delete(ctx.player);
    },
  };
}

/**
 * A trip to the nearest bank of any kind (booth, chest, banker), as a brain action: walk there,
 * click Bank (Use on a chest), and once it's open deposit (`depositAll`, or `depositIds`) and then
 * withdraw `withdraw` ([{ item, amount }], topped up to the amount). A bank that won't open is
 * skipped for the next nearest.
 */
// Banks a bot couldn't walk to or open (a guild it isn't in, a quest town), for its session: each
// visit would otherwise search for a way in again. player -> Set of bank keys.
const badBanks = new WeakMap();

/**
 * `teleports`: the nearest bank counted with the teleports the bot carries (a dueling ring's
 * Castle Wars; nothing fetched on the way), not only by walking: a player's restock from Zul-Andra
 * walked through Tirannwn's agility shortcuts and stuck.
 */
function createBankVisit({ api, withdraw = [], depositAll = false, depositIds = null, depositWorn = false, teleports = false, log = () => {} }) {
  const core = api.core;
  const map = createMap(core);
  const objects = new core.ObjectActionPacketListener();
  const npcs = new core.NPCOptionPacketListener();
  const states = new WeakMap();
  const stateOf = (player) => {
    if (!badBanks.has(player)) badBanks.set(player, new Set());
    if (!states.has(player)) states.set(player, { bank: null, travel: null, clickedAt: 0, tries: 0, badStands: 0, avoid: badBanks.get(player) });
    return states.get(player);
  };
  const bankKey = (bank) => `${bank.kind}:${bank.x},${bank.y},${bank.z}`;
  const clicked = new WeakMap();

  function click(player, bank) {
    if (bank.kind === "npc") {
      // The banker in front of the bot (a counter has several with the same id), as a player
      // clicks the one across from them.
      const here = tileOf(player.getLocation());
      let target = null;
      let best = Infinity;
      core.World.getNpcs().forEach((npc) => {
        if (npc?.getId?.() !== bank.id) return;
        const at = tileOf(npc.getLocation());
        if (at.z !== here.z || chebyshev(at, bank) > 3) return;
        const distance = chebyshev(at, here) * 10 + chebyshev(at, bank);
        if (distance < best) best = distance, target = npc;
      });
      const option = Banks.bankerOption(core, bank.id);
      if (!target || option < 0) return false;
      npcs.executeOption(player, target.getIndex(), option + 1);
      clicked.set(player, { npc: target.getIndex(), npcId: target.getId(), npcAt: tileOf(target.getLocation()), clickType: option + 1, busy: player.busy?.() });
      return true;
    }
    const object = map.objectsAt(bank.x, bank.y, bank.z).find((candidate) => candidate.getId() === bank.id);
    if (!object) return false;
    if (!Banks.reachesBankObject(core, player, object)) return "unreachable";
    const options = (core.ObjectDefinition.forPlayer(object.getId(), player)?.getInteractions?.() ?? []).map((option) => String(option ?? "").toLowerCase());
    const option = options.includes("bank") ? "bank" : "use";
    objects.executeAction(player, object.getId(), bank.x, bank.y, 0, options[options.indexOf(option)]);
    return true;
  }

  return {
    id: "bankVisit",
    update(ctx) {
      const player = ctx.player;
      const state = stateOf(player);
      // A bot's bank has no client interface: the BANKING status is what Bank.open sets.
      const open = core.Bank.isOpen(player) || (state.clickedAt && player.getStatus?.() === core.PlayerStatus?.BANKING);
      if (open) {
        if (depositAll) Banks.deposit(core, player);
        if (depositWorn) Banks.depositWorn(core, player);
        else if (depositIds?.length) Banks.deposit(core, player, depositIds);
        if (withdraw.length) Banks.withdraw(core, player, withdraw);
        player.getPacketSender().sendInterfaceRemoval();
        if (player.getStatus?.() === core.PlayerStatus?.BANKING) player.setStatus(core.PlayerStatus.NONE);
        states.delete(player);
        return "success";
      }
      if (!state.bank) {
        // One search outward for the nearest stand of a bank this bot hasn't given up on: the
        // first found is the nearest bank it can get to (not a guild it isn't in).
        const usable = (x, y, z) => Banks.banksAt(core, map.getFlag, x, y, z).some((bank) => !state.avoid.has(bankKey(bank)));
        if (!state.travel) state.travel = createTravelAction({ api, isGoal: usable, exact: true, log, plain: !teleports, fetch: false });
        const result = state.travel.update(ctx);
        if (result === "running") return "running";
        state.travel.stop(ctx);
        state.travel = null;
        if (result === "failed") {
          log("spp_bots_bank_failed", { name: player.getUsername(), bank: null, why: "no bank near", at: tileOf(player.getLocation()) });
          if (state.far) return "failed";
          // None in walking distance (Corsair Cove): as a player would, teleport or travel to the
          // nearest bank as the crow flies, with what the bot carries (fetching needs a bank).
          state.far = Banks.nearestBank(core, map.getFlag, tileOf(player.getLocation()), state.avoid);
          if (!state.far) return "failed";
          state.travel = createTravelAction({ api, goal: state.far.stands[0], exact: true, log, fetch: false });
          return "running";
        }
        const here = tileOf(player.getLocation());
        state.bank = Banks.banksAt(core, map.getFlag, here.x, here.y, here.z).find((bank) => !state.avoid.has(bankKey(bank))) ?? null;
        if (!state.bank) return "running";
      }
      if (player.busy?.()) return "running";
      if (!state.clickedAt) {
        const clickedBank = click(player, state.bank);
        if (clickedBank === "unreachable") {
          // Not usable from this side (the end of a row of booths): for nobody, so never again;
          // the search finds the nearest good stand.
          const here = tileOf(player.getLocation());
          Banks.markBadStand(here.x, here.y, here.z);
          log("spp_bots_bank_bad_stand", { name: player.getUsername(), bank: bankKey(state.bank), stand: here });
          if (++state.badStands >= 3) return this.next(player, state, "unreachable");
          state.bank = null;
          return "running";
        }
        if (!clickedBank) return this.next(player, state, "not there");
        Teleports.listen(player);
        state.clickedAt = Date.now();
        state.clickedFrom = tileOf(player.getLocation());
        return "running";
      }
      // The server's own verdict on the stand (a banker against the back wall, not a counter):
      // nobody is sent to stand here again.
      if (Teleports.messagesSince(player, state.clickedAt).some((text) => CANT_REACH.test(text))) {
        // Where it clicked from: the server may have walked it on before answering.
        const from = state.clickedFrom ?? tileOf(player.getLocation());
        Banks.markBadStand(from.x, from.y, from.z);
        log("spp_bots_bank_bad_stand", { name: player.getUsername(), bank: bankKey(state.bank), stand: from, at: tileOf(player.getLocation()), said: "can't reach" });
        state.clickedAt = 0;
        if (++state.badStands >= 3) return this.next(player, state, "can't reach");
        state.bank = null;
        return "running";
      }
      if (Date.now() - state.clickedAt < Banks.OPEN_MS) return "running";
      return this.next(player, state, "didn't open");
    },
    describe(player) {
      const state = states.get(player);
      if (!state) return null;
      return { bank: state.bank ? bankKey(state.bank) : null, stand: state.stand ?? null, clicked: Boolean(state.clickedAt), tries: state.tries, travel: state.travel?.describe?.(player) ?? null };
    },
    /** This bank didn't work: the next nearest, a few times. */
    next(player, state, why) {
      log("spp_bots_bank_failed", {
        name: player.getUsername(), bank: bankKey(state.bank), why, at: tileOf(player.getLocation()),
        status: String(player.getStatus?.()), interfaceId: player.getInterfaceId?.(), click: clicked.get(player) ?? null,
      });
      state.avoid.add(bankKey(state.bank));
      state.bank = null;
      state.clickedAt = 0;
      return ++state.tries >= 3 ? "failed" : "running";
    },
    madeProgress: () => true,
    stop(ctx) {
      states.get(ctx.player)?.travel?.stop?.(ctx);
      states.delete(ctx.player);
    },
  };
}

/**
 * The trip as a one-off brain activity (BotBrain.replaceRoot): when it ends, the brain picks
 * its next activity as usual. `onDone(result, report)` hears "success" or "failed" once.
 */
function createTravelActivity({ api, goal, exact = false, log, onDone = () => {} }) {
  const travel = createTravelAction({ api, goal, exact, log });
  let finished = false;
  let lastReport = null;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    onDone(result, lastReport);
  };
  const action = {
    id: "travel",
    update(ctx) {
      const result = travel.update(ctx);
      lastReport = travel.report(ctx.player) ?? lastReport;
      if (result === "success" || result === "failed") finish(result);
      return result;
    },
    madeProgress: (ctx) => travel.madeProgress(ctx),
    describe: (player) => travel.describe(player),
    stop(ctx) {
      lastReport = travel.report(ctx.player) ?? lastReport;
      travel.stop(ctx);
      // Stopped before arriving: the brain gave up on it (a stall) or something replaced it.
      finish("failed");
    },
  };
  return {
    id: `travel:${goal.x},${goal.y},${goal.z}`,
    skill: null,
    resolver: false,
    resolves: null,
    mode: "travel",
    capacity: 1,
    repeat: false,
    ephemeral: false,
    manual: false,
    failureCooldownMs: 0,
    requires: [],
    setup: [],
    actions: [action],
    /** Where the trip is now (::sppbots trip). */
    describe: (player) => travel.describe(player),
    produces: [],
    site: null,
  };
}

/**
 * A bank visit as a one-off brain activity (a session's end: bank everything, then log out there).
 * `onDone(result)` hears "success" or "failed" once.
 */
function createBankActivity({ api, log, depositAll = true, onDone = () => {} }) {
  const visit = createBankVisit({ api, depositAll, log });
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    onDone(result);
  };
  const action = {
    id: "bankVisit",
    update(ctx) {
      const result = visit.update(ctx);
      if (result === "success" || result === "failed") finish(result);
      return result;
    },
    madeProgress: () => true,
    describe: (player) => visit.describe(player),
    stop(ctx) {
      visit.stop(ctx);
      finish("failed");
    },
  };
  return {
    id: "bank", skill: null, resolver: false, resolves: null, mode: "bank", capacity: 1, repeat: false,
    ephemeral: false, manual: false, failureCooldownMs: 0, requires: [], setup: [], actions: [action],
    describe: (player) => ({ bank: visit.describe(player) }), produces: [], site: null,
  };
}

/** Every bank stand as { x, y, z } (for tours between banks). */
function bankStandTiles(core) {
  return [...bankStandsOf(core, createMap(core))].map((key) => ({ z: Math.floor(key / 268435456), x: Math.floor(key / 16384) % 16384, y: key % 16384 }));
}

module.exports = { plannerStatus, plannerLoad, createBankVisit, createBankActivity, bankStandTiles, createTravelAction, createTravelActivity, startPlan, advancePlan, tickPlanner, createMap };
