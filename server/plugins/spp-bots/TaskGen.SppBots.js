"use strict";

/**
 * Combat tasks from the NPC spawn data (docs/playerbots.md, Combat item 8): the generator, the
 * checker and a picker.
 *
 * - **Generator** (`generateTasks`, pure): every attackable monster in npc-spawns.json, its spawns
 *   clustered into areas (spawns within 15 tiles on one floor), becomes a task per area big enough
 *   to train at: the area, kills by the monster's hitpoints, food by its max hit, the combat levels
 *   it suits, members, its Slayer level. Left out: bosses (the Wiki's "bosses" category, 300+
 *   hitpoints, monsters with a style-switch rule in data/monsters.json: those are tasks of their
 *   own), dragons that breathe fire (no anti-dragon kit yet), instances, the Wilderness, areas of
 *   fewer than MIN_SPAWNS. Deterministic: the same spawns give the same tasks.
 * - **Checker**: `checkTask` says what's wrong with a task itself (its monster doesn't spawn in its
 *   area, the area is out of reach or in the Wilderness, an unknown item key or style);
 *   `canDo` whether one bot can take it now (combat level, members, Slayer, a set for the style,
 *   the task's items).
 * - **Picker** (`pickTask`): of the tasks a bot can do, one that suits its level, nearer ones
 *   first. Until the goals planner exists (Phase 4) it's what `::sppbots task <bot> auto` and bot
 *   mode's "Fight: anything for my level" use.
 *
 * Monster facts come from data/definitions/monsters-complete.json (the Wiki dump the server's NPC
 * definitions are loaded from), so the generator needs no running server.
 */

const path = require("path");
const fs = require("fs");

const DEFINITIONS = path.join(process.cwd(), "data", "definitions");
const SPAWNS_FILE = path.join(DEFINITIONS, "npc-spawns.json");
const MONSTERS_FILE = path.join(DEFINITIONS, "monsters-complete.json");
const MONSTER_RULES = require(path.join(__dirname, "data", "monsters.json")).rules ?? [];
// Area rules for generated tasks (data/combat-tasks.json "generated"): items needed there, or skip.
const AREA_RULES = require(path.join(__dirname, "data", "combat-tasks.json")).generated?.areas ?? [];

// Spawns this close (and on the same floor) are one area.
const CLUSTER_TILES = 15;
// An area's radius: its spread, within these bounds.
const RADIUS = [6, 16];
// An area with fewer spawns than this isn't a place to train (a lone guard).
const MIN_SPAWNS = 3;
// A monster with this many hitpoints is a boss fight, not a task to repeat.
const BOSS_HITPOINTS = 300;
const STYLES = new Set(["auto", "melee", "ranged", "magic"]);

const lower = (value) => String(value ?? "").toLowerCase();
const slug = (value) => lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
// Names compared without case, spaces or punctuation ("Al-Kharid warrior" is "Al Kharid warrior").
const nameKey = (value) => lower(value).replace(/[^a-z0-9]/g, "");
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

let spawnsCache = null;
function loadSpawns() {
  if (!spawnsCache) {
    try {
      spawnsCache = JSON.parse(fs.readFileSync(SPAWNS_FILE, "utf8"));
    } catch (error) {
      console.error("[spp-bots] npc spawns", error);
      spawnsCache = [];
    }
  }
  return spawnsCache;
}

let monstersCache = null;
function loadMonsters() {
  if (!monstersCache) {
    try {
      monstersCache = JSON.parse(fs.readFileSync(MONSTERS_FILE, "utf8"));
    } catch (error) {
      console.error("[spp-bots] monsters", error);
      monstersCache = {};
    }
  }
  return monstersCache;
}

/** What the generator needs to know of an NPC id, from the Wiki dump; null if it isn't a monster. */
function monsterInfo(id, monsters = loadMonsters()) {
  const m = monsters[String(id)];
  if (!m) return null;
  return {
    id, name: m.name, combat: m.combat_level ?? 0, hitpoints: m.hitpoints ?? 0, maxHit: m.max_hit ?? 0,
    members: m.members === true, aggressive: m.aggressive === true, slayer: m.slayer_level ?? 0,
    categories: m.category ?? [], attributes: m.attributes ?? [], attackTypes: m.attack_type ?? [],
  };
}

/** Spawns ({ x, y, z }) grouped into areas: [{ x, y, z, radius, count }]; the centre is a spawn. */
function clusterSpawns(spawns) {
  const group = new Array(spawns.length).fill(-1);
  const areas = [];
  for (let start = 0; start < spawns.length; start++) {
    if (group[start] >= 0) continue;
    const members = [start];
    group[start] = areas.length;
    for (let index = 0; index < members.length; index++) {
      const a = spawns[members[index]];
      for (let other = 0; other < spawns.length; other++) {
        if (group[other] >= 0) continue;
        const b = spawns[other];
        if (a.z === b.z && chebyshev(a, b) <= CLUSTER_TILES) {
          group[other] = areas.length;
          members.push(other);
        }
      }
    }
    const tiles = members.map((index) => spawns[index]);
    const mean = {
      x: Math.round(tiles.reduce((sum, t) => sum + t.x, 0) / tiles.length),
      y: Math.round(tiles.reduce((sum, t) => sum + t.y, 0) / tiles.length),
    };
    // The centre is a spawn (an average can fall in a wall): the one with most spawns within the
    // largest radius, nearest the average on a tie. A chain of spawns longer than that radius is
    // counted by what's inside it, not by the whole chain.
    let centre = tiles[0];
    let around = -1;
    for (const t of tiles) {
      const inside = tiles.filter((o) => chebyshev(o, t) <= RADIUS[1]).length;
      if (inside > around || (inside === around && chebyshev(t, mean) < chebyshev(centre, mean))) {
        centre = t;
        around = inside;
      }
    }
    const inside = tiles.filter((t) => chebyshev(t, centre) <= RADIUS[1]);
    const spread = Math.max(...inside.map((t) => chebyshev(t, centre)));
    const radius = clamp(spread + 2, RADIUS[0], RADIUS[1]);
    areas.push({
      x: centre.x, y: centre.y, z: centre.z, radius, count: inside.length, chain: tiles.length,
      ids: [...new Set(inside.map((t) => t.id).filter((id) => id !== undefined))],
    });
  }
  return areas;
}

let byNameCache = null;
/** Spawns by monster name key: [{ x, y, z, id }]. */
function spawnsByName(spawns = loadSpawns()) {
  if (spawns === spawnsCache && byNameCache) return byNameCache;
  const map = new Map();
  for (const spawn of spawns) {
    const key = nameKey(spawn.name);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ x: spawn.x, y: spawn.y, z: spawn.level ?? 0, id: spawn.id, name: spawn.name });
  }
  if (spawns === spawnsCache) byNameCache = map;
  return map;
}

const areaCache = new Map();
/** A monster's spawns grouped into areas, by its name. */
function areasOf(name) {
  const key = nameKey(name);
  if (!areaCache.has(key)) areaCache.set(key, clusterSpawns(spawnsByName().get(key) ?? []));
  return areaCache.get(key);
}

/** Why a monster isn't made into tasks (a boss, a dragon, ...), or null. */
function excluded(info) {
  if (!info || !info.name || info.name === "null") return "unknown";
  if (!(info.combat > 0) || !(info.hitpoints > 0)) return "not a monster";
  if (info.categories.includes("bosses") || info.hitpoints >= BOSS_HITPOINTS) return "boss";
  if (MONSTER_RULES.some((rule) => (rule.names ?? []).some((n) => nameKey(n) === nameKey(info.name)))) return "boss";
  if (info.attributes.includes("dragon") && !/^baby/i.test(info.name)) return "dragonfire";
  return null;
}

/** The combat levels a monster suits: [min, max]. Below, too dangerous; above, not worth the time. */
function combatRange(info) {
  const level = info.combat;
  return [clamp(Math.round(level * 0.8), 3, 126), clamp(level * 2 + 20, 3, 126)];
}

/** Food to bring: none for monsters that barely hit, more the harder and more often they do. */
function foodFor(info) {
  if (info.maxHit <= 1) return 0;
  return clamp(Math.round(info.maxHit * 1.5 + info.combat / 10), 2, 20);
}

/** Kills: many of a quick monster, fewer of a big one. */
function killsFor(info) {
  return clamp(Math.round(30 - info.hitpoints / 6), 8, 25);
}

/**
 * Tasks from the spawns: { id: task } with `generated: true`, `combat` [min, max], `members`,
 * `slayer` and the area's spawn `count`. `wildernessLevelAt(x, y)` (optional) leaves the Wilderness
 * out; without it only the map's Wilderness square is used.
 */
function generateTasks({ spawns = loadSpawns(), monsters = loadMonsters(), wildernessLevelAt = null } = {}) {
  // Underground (y + 6400) lies under the square above it: the Wilderness's dungeons too.
  const square = (x, y) => x >= 2944 && x < 3392 && y >= 3520 && y < 3968;
  const inWilderness = (x, y) => (wildernessLevelAt ? wildernessLevelAt(x, y) > 0 : false) || square(x, y >= 6400 ? y - 6400 : y);
  // Per name, the strongest of its ids that spawn (one name can be a level-2 and a level-5 goblin).
  const byName = spawnsByName(spawns);
  const tasks = {};
  const skipped = {};
  for (const list of byName.values()) {
    const infos = [...new Set(list.map((s) => s.id))].map((id) => monsterInfo(id, monsters)).filter(Boolean);
    if (infos.length === 0) continue;
    for (const area of clusterSpawns(list)) {
      if (area.count < MIN_SPAWNS || area.x >= 6400) continue;
      if (inWilderness(area.x, area.y)) continue;
      const here = infos.filter((info) => area.ids.includes(info.id));
      const info = (here.length ? here : infos).reduce((a, b) => (b.combat > a.combat ? b : a));
      const why = excluded(info);
      if (why) {
        skipped[why] = (skipped[why] ?? 0) + 1;
        continue;
      }
      // The spawn's name is the game's (the cache's); the Wiki's can differ ("Warrior" for the
      // "Warrior woman" at Ardougne, "Snake" for a "Desert snake").
      const name = list[0].name;
      const rule = AREA_RULES.find((r) => chebyshev(area, { x: r.near[0], y: r.near[1] }) <= (r.radius ?? 20));
      if (rule?.skip) {
        skipped.rule = (skipped.rule ?? 0) + 1;
        continue;
      }
      const id = `${slug(name)}@${area.x}_${area.y}_${area.z}`;
      tasks[id] = {
        monster: name, area: { x: area.x, y: area.y, z: area.z, radius: area.radius },
        style: "auto", kills: killsFor(info), food: foodFor(info),
        combat: combatRange(info), level: info.combat, members: info.members, slayer: info.slayer,
        count: area.count, generated: true,
        ...(rule?.items ? { items: [...rule.items] } : {}),
      };
    }
  }
  return { tasks, skipped };
}

let generated = null;
/** The generated tasks (made once). */
function generatedTasks(core = null) {
  if (!generated) {
    const levelAt = core?.Wilderness?.levelAt ? (x, y) => core.Wilderness.levelAt(x, y) : null;
    generated = generateTasks({ wildernessLevelAt: levelAt }).tasks;
  }
  return generated;
}

/** The hand-written tasks (data/combat-tasks.json) and the generated ones; hand-written win. */
function allTasks(core = null) {
  const { TASKS } = require("./CombatTask.SppBots");
  return { ...generatedTasks(core), ...TASKS };
}

function taskById(core, id) {
  return allTasks(core)[id] ?? null;
}

/** A monster's facts by name: the strongest id of that name in the dump. */
function infoByName(name, monsters = loadMonsters()) {
  const ids = [...new Set((spawnsByName().get(nameKey(name)) ?? []).map((s) => s.id))];
  const infos = ids.map((id) => monsterInfo(id, monsters)).filter(Boolean);
  if (infos.length) return infos.reduce((a, b) => (b.combat > a.combat ? b : a));
  const any = Object.entries(monsters).find(([, m]) => nameKey(m.name) === nameKey(name));
  return any ? monsterInfo(Number(any[0]), monsters) : null;
}

/** Whether a reach run got to the area: any of its monster's spawns there, or a tile beside one. */
function areaReached(task, reach = require("./Reach.SppBots")) {
  const run = reach?.lastReach?.();
  if (!run) return null;
  const spawns = (spawnsByName().get(nameKey(task.monster)) ?? []).filter((s) => s.z === task.area.z && chebyshev(s, task.area) <= task.area.radius);
  return spawns.some((s) => reach.near(run.forward, s.x, s.y, s.z));
}

/**
 * What's wrong with a task itself: [{ level: "error" | "warn", what }]. `core` (optional) checks
 * item keys and the Wilderness by the server's own tables; reach is checked when a reach run is in.
 */
function checkTask(task, { core = null, reach = null } = {}) {
  const problems = [];
  const error = (what) => problems.push({ level: "error", what });
  const warn = (what) => problems.push({ level: "warn", what });
  if (!task || typeof task !== "object") return [{ level: "error", what: "no task" }];
  if (!task.monster) error("no monster");
  const area = task.area;
  if (!area || ![area.x, area.y, area.z, area.radius].every(Number.isFinite)) {
    error("no area");
    return problems;
  }
  const spawns = (spawnsByName().get(nameKey(task.monster)) ?? []);
  // A boss its fight spawns (Zulrah) has no spawns to check: its way in has to be there instead.
  if (task.instanced) {
    if (!task.enter?.object) error("an instanced task needs an 'enter' object");
    if (!Array.isArray(task.travelTo)) error("an instanced task needs 'travelTo'");
  } else if (spawns.length === 0) error(`${task.monster} doesn't spawn anywhere`);
  else {
    const inArea = spawns.filter((s) => s.z === area.z && chebyshev(s, area) <= area.radius).length;
    if (inArea === 0) {
      const nearest = spawns.filter((s) => s.z === area.z).sort((a, b) => chebyshev(a, area) - chebyshev(b, area))[0];
      error(`no ${task.monster} spawns in the area${nearest ? ` (nearest ${chebyshev(nearest, area)} tiles off, ${nearest.x},${nearest.y})` : ""}`);
    } else if (inArea < 2) warn(`only ${inArea} ${task.monster} spawn in the area`);
  }
  const info = infoByName(task.monster);
  if (!info && !task.instanced) warn(`${task.monster} isn't in the monster data`);
  else if (excluded(info) === "not a monster") error(`${task.monster} can't be fought`);
  if (area.x >= 6400) error("the area is in an instance");
  const wildy = core?.Wilderness?.levelAt ? core.Wilderness.levelAt(area.x, area.y) : 0;
  if (wildy > 0) warn(`the area is in the Wilderness (level ${wildy})`);
  if (task.style && !STYLES.has(task.style)) error(`unknown style ${task.style}`);
  for (const style of task.switch ?? []) if (!STYLES.has(style) || style === "auto") error(`unknown switch style ${style}`);
  if (core) for (const key of task.items ?? []) if (!Number.isInteger(core.ItemIds?.[key])) error(`unknown item ${key}`);
  if (!task.until && !(task.kills > 0)) error("no kills and no level to stop at");
  if (task.food !== undefined && !(task.food >= 0 && task.food <= 28)) error(`food ${task.food} out of 0-28`);
  if (reach && task.instanced) {
    const run = reach.lastReach?.();
    const [x, y, z = 0] = task.travelTo ?? [];
    if (run && Number.isFinite(x) && !reach.near(run.forward, x, y, z)) error("the last reach run didn't get to its way in");
  } else if (reach) {
    const got = areaReached(task, reach);
    if (got === false) error("the last reach run didn't get to the area");
  }
  return problems;
}

/** The task's combat levels: its own, else the monster's. */
function rangeOf(task) {
  if (Array.isArray(task.combat)) return task.combat;
  const info = infoByName(task.monster);
  return info ? combatRange(info) : [3, 126];
}

/**
 * Whether `player` can take `task` now: { ok, why }. Levels (combat range, Slayer), members, the
 * task's items and a gear set for its style (auto: any) from what it owns, and reach (once a reach
 * run is in). `reach`: true for the last reach run, a Reach-like module, or false to skip it.
 */
function canDo(core, player, task, { have = null, members = null, reach = true, api = null } = {}) {
  const CombatTask = require("./CombatTask.SppBots");
  const skills = player.getSkillManager();
  const combat = skills.getCombatLevel();
  const [min, max] = rangeOf(task);
  if (combat < min) return { ok: false, why: `combat ${combat} < ${min}` };
  if (combat > max && !task.until) return { ok: false, why: `combat ${combat} > ${max}` };
  const isMembers = members ?? require("./Imports.SppBots").isMembersWorld();
  const info = task.generated ? null : infoByName(task.monster);
  if ((task.members ?? info?.members) && !isMembers) return { ok: false, why: "members" };
  const slayer = task.slayer ?? info?.slayer ?? 0;
  if (slayer > 1 && skills.getMaxLevel(core.Skill.SLAYER) < slayer) return { ok: false, why: `slayer ${slayer}` };
  have ??= CombatTask.owned(core, player);
  for (const key of task.items ?? []) {
    const id = core.ItemIds?.[key];
    if (!(have.get(id) > 0)) return { ok: false, why: `needs ${key}` };
  }
  const styles = task.style && task.style !== "auto" ? [task.style] : ["melee", "ranged", "magic"];
  if (!styles.some((style) => CombatTask.setFor(core, player, style, have))) return { ok: false, why: `no ${styles.length === 1 ? styles[0] : "combat"} set` };
  if (reach && !task.instanced && areaReached(task, reach === true ? undefined : reach) === false) return { ok: false, why: "out of reach" };
  if (api && task.requires) {
    const unmet = CombatTask.unmetRequirement(api, player, task);
    if (unmet) return { ok: false, why: unmet };
  }
  if (core.Wilderness?.levelAt?.(task.area.x, task.area.y) > 0) return { ok: false, why: "wilderness" };
  return { ok: true, why: null };
}

/**
 * A task for `player` from every task it can do: monsters near 70% of its combat level score best,
 * a far area loses a little (a tile is worth less than a level). One of the best few, weighted.
 * Returns { id, task } or null.
 */
function pickTask(core, player, { random = Math.random, members = null, reach = true } = {}) {
  const CombatTask = require("./CombatTask.SppBots");
  const have = CombatTask.owned(core, player);
  const combat = player.getSkillManager().getCombatLevel();
  const here = player.getLocation();
  const at = { x: here.getX(), y: here.getY() >= 6400 ? here.getY() - 6400 : here.getY() };
  const ideal = Math.max(2, combat * 0.7);
  const scored = [];
  for (const [id, task] of Object.entries(allTasks(core))) {
    if (task.wilderness || task.boss) continue;
    const level = task.level ?? infoByName(task.monster)?.combat ?? 1;
    // A quick filter before the full check.
    const [min, max] = rangeOf(task);
    if (combat < min || combat > max) continue;
    const area = { x: task.area.x, y: task.area.y >= 6400 ? task.area.y - 6400 : task.area.y };
    const score = Math.abs(level - ideal) / Math.max(1, ideal) + chebyshev(at, area) / 2000 - Math.min(task.count ?? 5, 15) / 100;
    scored.push({ id, task, score });
  }
  scored.sort((a, b) => a.score - b.score);
  const ok = [];
  for (const entry of scored) {
    if (canDo(core, player, entry.task, { have, members, reach }).ok) ok.push(entry);
    if (ok.length >= 5) break;
  }
  if (ok.length === 0) return null;
  // Weighted towards the best: 5, 4, 3, 2, 1.
  const weights = ok.map((_, index) => ok.length - index);
  let roll = random() * weights.reduce((a, b) => a + b, 0);
  for (let index = 0; index < ok.length; index++) {
    roll -= weights[index];
    if (roll < 0) return { id: ok[index].id, task: ok[index].task };
  }
  return { id: ok[0].id, task: ok[0].task };
}

/**
 * Every task checked, for `::sppbots tasks check`: { tasks, errors, warnings, byTask }. Generated
 * tasks that fail are bugs in the generator; hand-written ones in the data.
 */
function checkAll(core, { reach = null } = {}) {
  const report = { tasks: 0, errors: 0, warnings: 0, byTask: {} };
  for (const [id, task] of Object.entries(allTasks(core))) {
    report.tasks += 1;
    const problems = checkTask(task, { core, reach });
    if (problems.length === 0) continue;
    report.byTask[id] = problems;
    report.errors += problems.filter((p) => p.level === "error").length;
    report.warnings += problems.filter((p) => p.level === "warn").length;
  }
  return report;
}

module.exports = {
  generateTasks, generatedTasks, allTasks, taskById, checkTask, checkAll, canDo, pickTask,
  clusterSpawns, areasOf, monsterInfo, infoByName, combatRange, foodFor, killsFor, excluded, areaReached,
  MIN_SPAWNS,
};
