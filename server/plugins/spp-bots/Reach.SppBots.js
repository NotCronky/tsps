"use strict";

/**
 * Can a bot get there, and back? (docs/playerbots.md, "Travel everywhere".)
 *
 * Floods the world graph the travel planner walks (TravelRoutes.AgentMcp.js: tile collision on
 * every floor, closed doors on the map, and the transport table: doors, ladders, stairs,
 * shortcuts, boats ...) from one tile, forwards (where can it get to) and backwards (where can
 * get back to it). Requirements are ignored: this finds holes in the map, the transport data and
 * the server's handlers, not what one account may use. Every transport's ends and every NPC
 * spawn are then checked against both floods.
 *
 * It runs in slices between game ticks, so a full world flood never stalls the server.
 */

const fs = require("fs");
const path = require("path");
const { indexTransports, BLOCKED } = require("./Imports.SppBots");
const { transportData } = require("./Transports.SppBots");
const { SAVE_DIRECTORY, ensureSaveDirectory } = require("./Roster.SppBots");

const WALL_NORTH_WEST = 0x1;
const WALL_NORTH = 0x2;
const WALL_NORTH_EAST = 0x4;
const WALL_EAST = 0x8;
const WALL_SOUTH_EAST = 0x10;
const WALL_SOUTH = 0x20;
const WALL_SOUTH_WEST = 0x40;
const WALL_WEST = 0x80;

// The same steps as the planner (TravelRoutes.AgentMcp.js).
const STRAIGHT = [
  { dx: 0, dy: 1, wall: WALL_SOUTH },
  { dx: 1, dy: 0, wall: WALL_WEST },
  { dx: 0, dy: -1, wall: WALL_NORTH },
  { dx: -1, dy: 0, wall: WALL_EAST },
];
const DIAGONAL = [
  { dx: 1, dy: 1, corner: WALL_SOUTH_WEST | WALL_SOUTH | WALL_WEST, x: WALL_WEST, y: WALL_SOUTH },
  { dx: -1, dy: 1, corner: WALL_SOUTH_EAST | WALL_SOUTH | WALL_EAST, x: WALL_EAST, y: WALL_SOUTH },
  { dx: 1, dy: -1, corner: WALL_NORTH_WEST | WALL_NORTH | WALL_WEST, x: WALL_WEST, y: WALL_NORTH },
  { dx: -1, dy: -1, corner: WALL_NORTH_EAST | WALL_NORTH | WALL_EAST, x: WALL_EAST, y: WALL_NORTH },
];

/** Openable things the planner walks through (Doors.plugin.js opens curtains as doors). */
const DOOR_NAME = /door|gate|curtain/i;
const NEIGHBOURS = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
const MAX_X = 8192;
const MAX_Y = 16384;
const SLICE_MS = 40;
const REPORT_FILE = path.join(SAVE_DIRECTORY, "reach-report.json");
const NPC_SPAWNS_FILE = path.join(process.cwd(), "data", "definitions", "npc-spawns.json");

/** The last finished run's floods, for probing single tiles. */
let lastRun = null;

const index = (x, y, z) => (z * MAX_X + x) * MAX_Y + y;
const tileOf = (i) => ({ y: i % MAX_Y, x: Math.floor(i / MAX_Y) % MAX_X, z: Math.floor(i / (MAX_Y * MAX_X)) });
const regionOf = (x, y) => (x >> 6) * 256 + (y >> 6);

class Bitmap {
  constructor() {
    this.bits = new Uint8Array((4 * MAX_X * MAX_Y) / 8);
    this.count = 0;
  }
  has(i) {
    return (this.bits[i >>> 3] & (1 << (i & 7))) !== 0;
  }
  add(i) {
    if (this.has(i)) return false;
    this.bits[i >>> 3] |= 1 << (i & 7);
    this.count += 1;
    return true;
  }
}

function createWorldView(core) {
  const { RegionManager, MapObjects, ObjectDefinition } = core;
  const regions = new Map();
  const getFlag = (x, y, z) => {
    if (x < 0 || y < 0 || x >= MAX_X || y >= MAX_Y) return BLOCKED;
    const region = regionOf(x, y);
    if (!regions.has(region)) regions.set(region, RegionManager.getRegion(x, y) !== undefined);
    return regions.get(region) ? RegionManager.getClipping(x, y, z, null) : BLOCKED;
  };
  // A closed door or gate (Open / Pay-toll) on that tile, as the planner's doorAt finds them.
  const doorAt = (x, y, z) => {
    for (const object of MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? []) {
      const at = object.getLocation();
      if (at.getX() !== x || at.getY() !== y || at.getZ() !== z) continue;
      const definition = ObjectDefinition.forId(object.getId());
      const name = definition?.getName?.() ?? "";
      const open = definition?.getInteractions?.()?.some((value) => /^(open|release|pay-toll\(\d+gp\))$/i.test(value ?? ""));
      if (open && DOOR_NAME.test(name)) return true;
    }
    return false;
  };
  /** Objects on a tile with their options: what a barrier or a way out is. */
  const objectsAt = (x, y, z) => {
    const found = [];
    for (const object of MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? []) {
      const at = object.getLocation();
      if (at.getX() !== x || at.getY() !== y || at.getZ() !== z) continue;
      const definition = ObjectDefinition.forId(object.getId());
      const options = (definition?.getInteractions?.() ?? []).filter(Boolean);
      if (options.length) found.push({ id: object.getId(), name: definition?.getName?.() ?? "?", options, at: [x, y, z] });
    }
    return found;
  };
  return { getFlag, doorAt, objectsAt };
}

/** One flood, run a slice at a time. `reverse`: tiles that can reach the start instead. */
class Flood {
  constructor({ view, byFrom, byTo, start, reverse, seen = new Bitmap(), fence = null, onVisit = null }) {
    Object.assign(this, { view, byFrom, byTo, reverse, fence, onVisit });
    this.seen = seen;
    this.count = 0;
    this.queue = [index(start.x, start.y, start.z)];
    this.head = 0;
    this.seen.add(this.queue[0]);
    this.count = 1;
  }

  visit(x, y, z) {
    if (x < 0 || y < 0 || x >= MAX_X || y >= MAX_Y) return;
    const i = index(x, y, z);
    if (this.fence?.has(i)) return;
    if (this.seen.add(i)) {
      this.queue.push(i);
      this.count += 1;
    }
  }

  /** One forward step from (x, y) to (x + dx, y + dy), as the planner allows it. */
  canStep(x, y, z, move, straight) {
    const { getFlag, doorAt } = this.view;
    const nx = x + move.dx;
    const ny = y + move.dy;
    // Like the planner, only the tile stepped onto is checked: a ladder or staircase lands the
    // player on its own (blocked) tile, and they walk off it.
    if (straight) {
      const flag = getFlag(nx, ny, z);
      if (flag & BLOCKED) return false;
      if (flag & move.wall) return doorAt(nx, ny, z) || doorAt(x, y, z);
      return true;
    }
    if (getFlag(nx, ny, z) & (BLOCKED | move.corner)) return false;
    if (getFlag(nx, y, z) & (BLOCKED | move.x)) return false;
    if (getFlag(x, ny, z) & (BLOCKED | move.y)) return false;
    return true;
  }

  expand(i) {
    const { x, y, z } = tileOf(i);
    this.onVisit?.(i, x, y, z);
    for (const move of STRAIGHT) {
      if (this.reverse) {
        if (this.canStep(x - move.dx, y - move.dy, z, move, true)) this.visit(x - move.dx, y - move.dy, z);
      } else if (this.canStep(x, y, z, move, true)) this.visit(x + move.dx, y + move.dy, z);
    }
    for (const move of DIAGONAL) {
      if (this.reverse) {
        if (this.canStep(x - move.dx, y - move.dy, z, move, false)) this.visit(x - move.dx, y - move.dy, z);
      } else if (this.canStep(x, y, z, move, false)) this.visit(x + move.dx, y + move.dy, z);
    }
    const key = z * 268435456 + x * 16384 + y;
    const { getFlag } = this.view;
    if (this.reverse) {
      // Transports landing here, back to where they're clicked: that tile, or next to it when
      // it's blocked (a ladder on its own tile is clicked from beside it).
      for (const transport of this.byTo.get(key) ?? []) {
        const [fx, fy, fz] = transport.from;
        this.visit(fx, fy, fz);
        if (!(getFlag(fx, fy, fz) & BLOCKED)) continue;
        for (const [dx, dy] of NEIGHBOURS) {
          if (!(getFlag(fx + dx, fy + dy, fz) & BLOCKED)) this.visit(fx + dx, fy + dy, fz);
        }
      }
      return;
    }
    for (const transport of this.byFrom.get(key) ?? []) {
      const [tx, ty, tz] = transport.to;
      this.visit(tx, ty, tz);
    }
    // The planner's rule: a transport on a blocked tile next to this one is clicked from here.
    for (const [dx, dy] of NEIGHBOURS) {
      if (!(getFlag(x + dx, y + dy, z) & BLOCKED)) continue;
      for (const transport of this.byFrom.get(key + dx * 16384 + dy) ?? []) {
        const [tx, ty, tz] = transport.to;
        this.visit(tx, ty, tz);
      }
    }
  }

  /** Works until `budgetMs` is used; true once the flood is complete. */
  step(budgetMs) {
    const until = performance.now() + budgetMs;
    let n = 0;
    while (this.head < this.queue.length) {
      this.expand(this.queue[this.head++]);
      if ((++n & 1023) === 0 && performance.now() > until) return false;
    }
    this.queue = [];
    return true;
  }
}

/** Reached, or next to a reached tile (a goal may stand on a blocked tile: a counter, a rock). */
function near(bitmap, x, y, z) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (bitmap.has(index(x + dx, y + dy, z))) return true;
    }
  }
  return false;
}

function summarise({ forward, backward, transports, spawns, start, ms }) {
  const regions = new Map();
  const regionEntry = (x, y) => {
    const id = regionOf(x, y);
    if (!regions.has(id)) regions.set(id, { region: id, x: (id >> 8) * 64, y: (id & 255) * 64, npcsCut: 0, npcsOneWay: 0, transportsCut: 0, names: new Set(), menus: new Set() });
    return regions.get(id);
  };
  let transportsCut = 0;
  let transportsOneWay = 0;
  const transportSamples = [];
  for (const transport of transports) {
    const [fx, fy, fz] = transport.from;
    const reachable = near(forward, fx, fy, fz);
    const back = near(backward, fx, fy, fz);
    if (reachable && back) continue;
    if (reachable) transportsOneWay += 1;
    else transportsCut += 1;
    const entry = regionEntry(fx, fy);
    entry.transportsCut += 1;
    entry.menus.add(transport.menu);
    if (transportSamples.length < 400) transportSamples.push({ type: transport.type, menu: transport.menu, id: transport.id, from: transport.from, to: transport.to, reachable, back });
  }
  let npcsCut = 0;
  let npcsOneWay = 0;
  for (const spawn of spawns) {
    const z = spawn.level ?? 0;
    const reachable = near(forward, spawn.x, spawn.y, z);
    const back = near(backward, spawn.x, spawn.y, z);
    if (reachable && back) continue;
    const entry = regionEntry(spawn.x, spawn.y);
    if (reachable) {
      npcsOneWay += 1;
      entry.npcsOneWay += 1;
    } else {
      npcsCut += 1;
      entry.npcsCut += 1;
    }
    if (entry.names.size < 8) entry.names.add(spawn.name);
  }
  const byRegion = [...regions.values()]
    .map((entry) => ({ ...entry, names: [...entry.names], menus: [...entry.menus].slice(0, 8) }))
    .sort((a, b) => (b.npcsCut + b.npcsOneWay + b.transportsCut) - (a.npcsCut + a.npcsOneWay + a.transportsCut));
  return {
    at: new Date().toISOString(),
    start,
    ms: Math.round(ms),
    tiles: { forward: forward.count, backward: backward.count },
    transports: { total: transports.length, cut: transportsCut, oneWay: transportsOneWay },
    npcs: { total: spawns.length, cut: npcsCut, oneWay: npcsOneWay },
    regions: byRegion,
    transportSamples,
  };
}

/** Most tiles one cut-off component is flooded for; a bigger one is reported as truncated. */
const COMPONENT_TILE_CAP = 400000;

/**
 * The places bots can't reach, as connected pieces: each unreached spawn floods what it connects
 * to (without crossing reached ground), and every transport landing inside is an entrance.
 * No entrance: only a teleport or something the transport table lacks gets there.
 */
class Components {
  constructor({ view, byFrom, byTo, forward, spawns }) {
    Object.assign(this, { view, byFrom, byTo, forward, spawns });
    this.assigned = new Bitmap();
    this.list = [];
    this.spawnAt = new Map();
    for (const spawn of spawns) {
      const i = index(spawn.x, spawn.y, spawn.level ?? 0);
      if (!this.spawnAt.has(i)) this.spawnAt.set(i, []);
      this.spawnAt.get(i).push(spawn.name);
    }
    this.pending = spawns.filter((spawn) => !near(forward, spawn.x, spawn.y, spawn.level ?? 0));
    this.cursor = 0;
    this.current = null;
  }

  startNext() {
    while (this.cursor < this.pending.length) {
      const spawn = this.pending[this.cursor++];
      const z = spawn.level ?? 0;
      if (this.assigned.has(index(spawn.x, spawn.y, z))) continue;
      const component = { id: this.list.length, spawns: 0, names: new Map(), tiles: 0, truncated: false,
        box: { minX: spawn.x, maxX: spawn.x, minY: spawn.y, maxY: spawn.y, planes: new Set() }, entrances: [],
        barriers: new Map(), waysOut: new Map() };
      const flood = new Flood({ view: this.view, byFrom: this.byFrom, byTo: this.byTo, start: { x: spawn.x, y: spawn.y, z },
        reverse: false, seen: this.assigned, fence: this.forward,
        onVisit: (i, x, y, tz) => this.note(component, flood, i, x, y, tz) });
      this.list.push(component);
      this.current = { component, flood };
      return true;
    }
    return false;
  }

  note(component, flood, i, x, y, z) {
    component.tiles += 1;
    const box = component.box;
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
    box.planes.add(z);
    for (const name of this.spawnAt.get(i) ?? []) {
      component.spawns += 1;
      component.names.set(name, (component.names.get(name) ?? 0) + 1);
    }
    // A wall between this piece and reachable ground: what stands on it is the barrier.
    for (const move of STRAIGHT) {
      const nx = x + move.dx;
      const ny = y + move.dy;
      if (!this.forward.has(index(nx, ny, z))) continue;
      for (const object of [...this.view.objectsAt(nx, ny, z), ...this.view.objectsAt(x, y, z)]) {
        const label = `${object.name} [${object.options.join("/")}] id ${object.id}`;
        if (!component.barriers.has(label) && component.barriers.size < 10) component.barriers.set(label, object.at);
      }
    }
    // Ladders, stairs and exits inside: the other end of a missing entrance.
    if (component.waysOut.size < 8) {
      for (const object of this.view.objectsAt(x, y, z)) {
        if (!object.options.some((option) => /climb|enter|exit|leave|squeeze|crawl|jump|go-|pass|walk|cross|board|use|open|ascend|descend/i.test(option))) continue;
        const label = `${object.name} [${object.options.join("/")}] id ${object.id}`;
        if (!component.waysOut.has(label)) component.waysOut.set(label, object.at);
      }
    }
    for (const transport of this.byTo.get(z * 268435456 + x * 16384 + y) ?? []) {
      const [fx, fy, fz] = transport.from;
      if (component.entrances.length < 12) {
        component.entrances.push({ type: transport.type, menu: transport.menu, id: transport.id, from: transport.from, fromReached: near(this.forward, fx, fy, fz) });
      }
    }
    if (component.tiles >= COMPONENT_TILE_CAP) {
      component.truncated = true;
      flood.queue = [];
      flood.head = 0;
    }
  }

  /** True when every unreached spawn has its component. */
  step(budgetMs) {
    const until = performance.now() + budgetMs;
    while (performance.now() < until) {
      if (!this.current && !this.startNext()) return true;
      if (this.current.flood.step(Math.max(1, until - performance.now()))) this.current = null;
    }
    return false;
  }

  report() {
    return this.list
      .filter((component) => component.spawns > 0)
      .map((component) => ({
        ...component,
        names: [...component.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name} x${count}`),
        box: { ...component.box, planes: [...component.box.planes] },
        barriers: [...component.barriers.entries()].map(([label, at]) => `${label} @ ${at.join(",")}`),
        waysOut: [...component.waysOut.entries()].map(([label, at]) => `${label} @ ${at.join(",")}`),
        cause: component.entrances.length > 0 ? "entrance-cut-off" : component.barriers.size > 0 ? "barrier" : "no-entrance",
      }))
      .sort((a, b) => b.spawns - a.spawns);
  }
}

/**
 * Starts a reach run from `start`; calls `done(report)` when both floods are finished. Returns
 * a handle with `progress()` for status messages.
 */
function runReach(core, start, done, onError = console.error) {
  const view = createWorldView(core);
  const byFrom = indexTransports(transportData());
  const transports = [...byFrom.values()].flat();
  const byTo = new Map();
  for (const transport of transports) {
    const [x, y, z] = transport.to;
    const key = z * 268435456 + x * 16384 + y;
    if (!byTo.has(key)) byTo.set(key, []);
    byTo.get(key).push(transport);
  }
  const startedAt = performance.now();
  const forward = new Flood({ view, byFrom, byTo, start, reverse: false });
  const backward = new Flood({ view, byFrom, byTo, start, reverse: true });
  const spawns = JSON.parse(fs.readFileSync(NPC_SPAWNS_FILE, "utf8"));
  let components = null;
  let phase = "forward";
  const tick = () => {
    try {
      if (phase === "forward" && forward.step(SLICE_MS)) phase = "backward";
      else if (phase === "backward" && backward.step(SLICE_MS)) {
        phase = "components";
        components = new Components({ view, byFrom, byTo, forward: forward.seen, spawns });
      } else if (phase === "components" && components.step(SLICE_MS)) phase = "done";
      if (phase !== "done") {
        setImmediate(tick);
        return;
      }
      const report = summarise({ forward: forward.seen, backward: backward.seen, transports, spawns, start, ms: performance.now() - startedAt });
      report.components = components.report();
      lastRun = { forward: forward.seen, backward: backward.seen, view, byFrom, start };
      ensureSaveDirectory();
      fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 1));
      done(report, REPORT_FILE);
    } catch (error) {
      onError(error);
    }
  };
  setImmediate(tick);
  return {
    progress: () => `${phase}: ${forward.seen.count} tiles forward, ${backward.seen.count} back${components ? `, ${components.list.length} cut-off pieces` : ""}`,
  };
}

/**
 * Whether the last run reached (x, y, z) and can get back from it, the tile's collision, and
 * the transports clicked from or landing on it.
 */
function probe(x, y, z) {
  if (!lastRun) return null;
  const { forward, backward, view, byFrom } = lastRun;
  const flag = view.getFlag(x, y, z);
  const key = z * 268435456 + x * 16384 + y;
  return {
    reached: forward.has(index(x, y, z)),
    nearReached: near(forward, x, y, z),
    canReturn: backward.has(index(x, y, z)),
    flag: `0x${flag.toString(16)}`,
    blocked: (flag & BLOCKED) !== 0,
    transportsFrom: (byFrom.get(key) ?? []).map((t) => `${t.menu} -> ${t.to.join(",")}`),
    objects: view.objectsAt(x, y, z).map((o) => `${o.name} [${o.options.join("/")}] ${o.id}`),
  };
}

/** The last finished run's floods (Scout.SppBots.js picks candidates beside reached ground). */
function lastReach() {
  return lastRun;
}

/** Whether the last run reached exactly (x, y, z); null without a run. */
function reached(x, y, z) {
  return lastRun ? lastRun.forward.has(index(x, y, z)) : null;
}

module.exports = { runReach, probe, lastReach, near, reached, REPORT_FILE, NPC_SPAWNS_FILE };
