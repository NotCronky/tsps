"use strict";

/**
 * Zulrah's fight played by a bot (docs/playerbots.md, Boss tasks): CombatTask's "zulrah" task
 * hands it every tick of a fight (`play`), from the shrine's start to the kill; the task does the
 * rest (bank, travel, the boat, the loot, the scroll out).
 *
 * Its idea is tsps's Bots.Zulrah.js (prayers by form, the forms' weaknesses, snakelings first,
 * walking to the next spot while Zulrah dives, eating and curing, a teleport out when failing);
 * where it stands is not: tsps picks the cheapest tile every tick and drifts. Here it stands on the
 * Wiki's spot for each phase of each rotation (Zulrah/Strategies' rotation charts), as RuneLite's
 * old Zulrah helper encoded them (OpenOSRS `plugins/zulrah`: `ZulrahPatternA`-`D`, stand tiles
 * from Zulrah's first position by `ZulrahPhase.getStandTile`). Its pillar spots are the server's
 * tail-safe tiles (Fight.TAIL.safe) and its first red spot the server's `firstSwingSafe`, which is
 * how the tiles were checked.
 *
 * The rotation is told as a player tells it: by the places and forms seen since the rotation
 * began (the second phase splits Serp and Tanz from the Crimsons, the fourth the two Crimsons);
 * where the candidates still disagree, the first's spot. The red form's phases are on the
 * tail-safe tile nearest the chart's spot (the tail can't reach it); a spot under a cloud (down,
 * or in the air) gives way to the nearest clean tile still in reach of Zulrah.
 */

const ROTATIONS_PATH = "../bosses/zulrah/Rotations.Zulrah";

// The chart's spots, as tiles: offsets from Zulrah's first (middle) centre, 2268,3075.
const CENTRE = { x: 2268, y: 3075 };
const OFFSETS = {
  WEST: [-5, 0], EAST: [5, -2], SOUTH: [0, -6], SOUTH_WEST: [-4, -4], SOUTH_EAST: [2, -6],
  TOP_EAST: [6, 2], TOP_WEST: [-4, 3],
  PILLAR_WEST_INSIDE: [-4, -3], PILLAR_WEST_OUTSIDE: [-5, -3], PILLAR_EAST_INSIDE: [4, -3], PILLAR_EAST_OUTSIDE: [4, -4],
};
const STAND = Object.fromEntries(Object.entries(OFFSETS).map(([name, [dx, dy]]) => [name, { x: CENTRE.x + dx, y: CENTRE.y + dy }]));

/**
 * Each rotation's spots, phase by phase: the first is its opening (the middle green form, the
 * fight's first or the last rotation's closing), then one per phase of Rotations.Zulrah.js's
 * ROTATIONS[i] (RuneLite's patterns A-D, in the same order: Crimson A, Crimson B, Serp, Tanz).
 */
const PLANS = [
  ["TOP_EAST", "TOP_EAST", "PILLAR_WEST_INSIDE", "PILLAR_WEST_INSIDE", "PILLAR_WEST_INSIDE", "PILLAR_WEST_INSIDE",
    "PILLAR_EAST_OUTSIDE", "SOUTH_WEST", "TOP_WEST", "TOP_WEST"],
  ["TOP_EAST", "TOP_EAST", "PILLAR_WEST_OUTSIDE", "PILLAR_WEST_OUTSIDE", "PILLAR_WEST_INSIDE", "PILLAR_WEST_INSIDE",
    "SOUTH_EAST", "SOUTH_WEST", "TOP_WEST", "TOP_WEST"],
  ["TOP_EAST", "TOP_EAST", "TOP_WEST", "WEST", "SOUTH_EAST", "PILLAR_EAST_OUTSIDE", "PILLAR_WEST_OUTSIDE",
    "PILLAR_WEST_OUTSIDE", "TOP_EAST", "TOP_EAST", "TOP_EAST"],
  ["TOP_EAST", "TOP_EAST", "PILLAR_WEST_INSIDE", "PILLAR_WEST_INSIDE", "PILLAR_EAST_OUTSIDE", "PILLAR_EAST_OUTSIDE",
    "PILLAR_WEST_OUTSIDE", "PILLAR_WEST_OUTSIDE", "TOP_EAST", "TOP_EAST", "TOP_EAST", "TOP_EAST"],
];
// Beside the pillars, where the tail can't reach (Fight.TAIL.safe).
const TAIL_SAFE = [[2273, 3072], [2272, 3072], [2264, 3072], [2263, 3072]];
// Zulrah's body: the south-west tile of each place (Shared.POSITION) and its size.
const BODY = { middle: { x: 2266, y: 3073 }, south: { x: 2266, y: 3062 }, west: { x: 2257, y: 3071 }, east: { x: 2276, y: 3072 } };
const SIZE = 5;
// Weapons' reach to Zulrah's body: a spell 10, a powered staff (the trident) 7, the blowpipe 5, other ranged 7.
const REACH = { spell: 10, staff: 7, blowpipe: 5, ranged: 7 };
const EAT_BELOW = 0.6;
const COMBO_BELOW = 0.45;
const DRINK_PRAYER_BELOW = 25;
const ESCAPE_BELOW = 0.4;
// Ticks a walk's target is anchored for (the combat's chase kept off).
const ANCHOR_TICKS = 2;
// The shrine's tiles (Shared.SHRINE), and a clouded step on the way out of a cloud, in tiles.
const SHRINE = { minX: 2250, maxX: 2285, minY: 3055, maxY: 3085 };
const CROSS_CLOUD = 120;

const chebyshev = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** Each rotation's phases as [{ at, form, steps }], its opening first. */
function phasesOf(r) {
  const { ROTATIONS, OPENING } = require(ROTATIONS_PATH);
  return [OPENING, ...ROTATIONS[r]];
}

/** The rotations (0-3) whose first phases are those seen (`seen`: [{ at, form }], the opening first). */
function candidates(seen) {
  const out = [];
  for (let r = 0; r < PLANS.length; r++) {
    const phases = phasesOf(r);
    if (seen.length <= phases.length && seen.every((p, i) => p.at === phases[i].at && p.form === phases[i].form)) out.push(r);
  }
  return out;
}

/**
 * Where to stand, from the phases seen this rotation: `stand` for the phase up now (the last seen),
 * `next` for the one after (where the candidates agree; null while they don't, or at a rotation's
 * end: the closing is the middle green again, TOP_EAST), `jad` the style the phase's Jad
 * alternation starts with (null for other phases), `ends` whether the phase up is its rotation's last.
 */
function planFor(seen) {
  const found = candidates(seen);
  if (seen.length === 0 || found.length === 0) return { stand: "TOP_EAST", next: null, jad: null, ends: false, rotations: found };
  const i = seen.length - 1;
  const r = found[0];
  const phase = phasesOf(r)[i];
  const jad = phase.steps.find((step) => step[0] === "jad")?.[1] ?? null;
  const ends = found.every((each) => PLANS[each].length === seen.length);
  const nexts = new Set(found.map((each) => (PLANS[each].length > seen.length ? PLANS[each][i + 1] : "TOP_EAST")));
  return { stand: PLANS[r][i], next: nexts.size === 1 ? [...nexts][0] : null, jad, ends, rotations: found };
}

/** Where Zulrah rises next, from the phases seen: the first candidate's next place (the middle at a rotation's end). */
function nextAt(seen) {
  const plan = planFor(seen);
  if (!seen.length || plan.ends || !plan.rotations.length) return "middle";
  return phasesOf(plan.rotations[0])[seen.length]?.at ?? "middle";
}

/**
 * The form Zulrah rises in next, where the candidates agree (green at a rotation's end: its
 * closing and opening), else null. The dive's switch is for it: always green had the bot change to
 * the trident and back between two blue phases.
 */
function nextForm(seen) {
  const plan = planFor(seen);
  if (!seen.length || plan.ends) return "green";
  const forms = new Set(plan.rotations.map((r) => phasesOf(r)[seen.length]?.form ?? "green"));
  return forms.size === 1 ? [...forms][0] : null;
}

/** The tail-safe tile nearest a spot. */
function tailSafeNear(spot) {
  return TAIL_SAFE.map(([x, y]) => ({ x, y })).sort((a, b) => chebyshev(a.x, a.y, spot.x, spot.y) - chebyshev(b.x, b.y, spot.x, spot.y))[0];
}

/** Tiles from a tile to a body (0 under it). */
function gap(x, y, body) {
  return Math.max(Math.max(0, body.x - x, x - (body.x + SIZE - 1)), Math.max(0, body.y - y, y - (body.y + SIZE - 1)));
}

/**
 * The fight's controller for one player. `sets` the task's sets by style (CombatTask's, worn by
 * Tactics.wearSet); `onEscape` when it teleported out (no food, failing).
 */
function createController({ api, player, sets, log = () => {}, onEscape = () => {} }) {
  const core = api.core;
  const Tactics = require("./Tactics.SppBots");
  const Supplies = require("./Supplies.SppBots");
  const Hazards = require("./Hazards.SppBots");
  // The task's sets, read live (a function, or the object).
  const setsNow = () => (typeof sets === "function" ? sets() : sets) ?? {};
  const bot = { fight: null, seen: [], phase: null, wasSurfaced: false, refused: new Set(), lastShot: null, jadSeen: null, goal: null, boosted: false };

  const skills = () => player.getSkillManager();
  const share = (skill) => skills().getCurrentLevel(skill) / Math.max(1, skills().getMaxLevel(skill));

  /** A new phase seen rising: recorded, a new rotation begun after the last one's closing. */
  function observe(fight) {
    if (!fight.surfaced || !fight.phase || fight.phase === bot.phase) return;
    bot.phase = fight.phase;
    const seen = { at: fight.phase.at, form: fight.phase.form };
    // The last rotation over (its every phase seen): this middle green is the next one's opening.
    if (bot.seen.length && planFor(bot.seen).ends) bot.seen = [];
    bot.seen.push(seen);
    bot.jadSeen = null;
    // Only what's thrown from now on counts for this phase's Jad alternation.
    bot.lastShot = Hazards.lastIncomingOf?.(player)?.at ?? null;
    const plan = planFor(bot.seen);
    log({ phase: bot.seen.length, at: seen.at, form: seen.form, rotations: plan.rotations, stand: plan.stand });
  }

  /** The style it attacks the form up with: ranged at the blue form, magic otherwise (each if it has the set). */
  function styleFor(form) {
    if (form === "blue" && setsNow().ranged) return "ranged";
    if (setsNow().magic) return "magic";
    return setsNow().ranged ? "ranged" : Object.keys(setsNow())[0];
  }

  function reach(style) {
    const set = setsNow()[style];
    if (style === "magic") return set?.spell ? REACH.spell : REACH.staff;
    return /blowpipe/i.test(String(set?.weapon ?? "")) ? REACH.blowpipe : REACH.ranged;
  }

  /** Clouded: a cloud down (3x3 round its centre) or landing (Hazards' ground projectiles). */
  function clouded(fight, x, y) {
    if (fight.hazards.clouds.some((cloud) => chebyshev(cloud.centre.x ?? cloud.centre.getX?.(), cloud.centre.y ?? cloud.centre.getY?.(), x, y) <= 1)) return true;
    return Hazards.dangerous(x, y, 0, fight.area, Date.now());
  }

  function walkable(fight, x, y) {
    try {
      return !(core.RegionManager.getClipping(x, y, 0, fight.area) & core.RegionManager.BLOCKED_MASK);
    } catch {
      return false;
    }
  }

  function inReach(fight, x, y, at, range) {
    const body = BODY[at];
    const d = gap(x, y, body);
    if (d === 0 || d > range) return false;
    const c = { x: body.x + 2, y: body.y + 2 };
    return core.RegionManager.canProjectileMove?.(x, y, c.x, c.y, 0, 1, 1, fight.area) ?? true;
  }

  /**
   * The cheapest walks from where it stands over the shrine's tiles (8 ways, as the movement allows,
   * NPCs and all): never onto a clouded tile, or with `through` (its way out of one) each clouded
   * step costing CROSS_CLOUD. "x,y" -> { path: [Location], cost }. The route finder's own way
   * ignores clouds, and stood the bot in one for 13 s beside a snakeling on the tail-safe tile.
   */
  function cleanPaths(fight, through) {
    const here = player.getLocation();
    const queue = player.getMovementQueue();
    const start = `${here.getX()},${here.getY()}`;
    const paths = new Map([[start, { path: [], cost: 0, at: here }]]);
    const open = [start];
    while (open.length) {
      let index = 0;
      for (let k = 1; k < open.length; k++) if (paths.get(open[k]).cost < paths.get(open[index]).cost) index = k;
      const key = open.splice(index, 1)[0];
      const { path, cost, at: from } = paths.get(key);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const [x, y] = [from.getX() + dx, from.getY() + dy];
          if (x < SHRINE.minX || x > SHRINE.maxX || y < SHRINE.minY || y > SHRINE.maxY) continue;
          const next = `${x},${y}`;
          const cloudy = clouded(fight, x, y);
          if (cloudy && !through) continue;
          const value = cost + 1 + (cloudy ? CROSS_CLOUD : 0);
          if (paths.has(next) && paths.get(next).cost <= value) continue;
          const tile = new core.Location(x, y, 0);
          if (queue.canWalkTo && !queue.canWalkTo(tile, from)) continue;
          if (!queue.canWalkTo && !walkable(fight, x, y)) continue;
          if (!paths.has(next)) open.push(next);
          paths.set(next, { path: [...path, tile], cost: value, at: tile });
        }
      }
    }
    return paths;
  }

  /**
   * The tile to stand on, of those it can walk to cleanly: the chart's spot for the phase (for the
   * red form the clean tail-safe tile nearest it), else the nearest clean tile in reach of where
   * Zulrah is (two tiles at least from the tail's aim in the red form). With nowhere clean to walk
   * (standing in a cloud), the cheapest way out.
   */
  function goalTile(fight, spotName, at, form, range) {
    const chart = STAND[spotName];
    const here = player.getLocation();
    let paths = cleanPaths(fight, false);
    if (paths.size <= 1 && clouded(fight, here.getX(), here.getY())) paths = cleanPaths(fight, true);
    const ok = (x, y) => paths.has(`${x},${y}`) && !clouded(fight, x, y);
    const near = (a, b) => chebyshev(a.x, a.y, chart.x, chart.y) - chebyshev(b.x, b.y, chart.x, chart.y);
    if (form === "red") {
      const safe = TAIL_SAFE.map(([x, y]) => ({ x, y })).filter((tile) => ok(tile.x, tile.y)).sort(near)[0];
      if (safe) return { ...safe, paths };
    } else if (ok(chart.x, chart.y)) {
      return { ...chart, paths };
    }
    let best = null;
    for (const [key, { cost }] of paths) {
      const [x, y] = key.split(",").map(Number);
      if (clouded(fight, x, y) || !inReach(fight, x, y, at, range)) continue;
      if (form === "red" && fight.tailTarget && chebyshev(x, y, fight.tailTarget.getX(), fight.tailTarget.getY()) <= 1) continue;
      const score = chebyshev(x, y, chart.x, chart.y) * 2 + cost;
      if (!best || score < best.score) best = { x, y, score };
    }
    if (best) return { x: best.x, y: best.y, paths };
    // Nowhere clean in reach: off the cloud at least, by the cheapest way.
    let out = null;
    for (const [key, { cost }] of paths) {
      const [x, y] = key.split(",").map(Number);
      if (!clouded(fight, x, y) && (!out || cost < out.cost)) out = { x, y, cost };
    }
    return out ? { x: out.x, y: out.y, paths } : { x: here.getX(), y: here.getY(), paths };
  }

  /** Walks its clean path to the tile, the target kept (the walk is the combat's own movement, no chase). */
  function walkTo(tile, target) {
    const here = player.getLocation();
    if (here.getX() === tile.x && here.getY() === tile.y) {
      bot.goal = null;
      return false;
    }
    const combat = player.getCombat();
    const queue = player.getMovementQueue();
    // On its way there, the rest of the way still clean: kept.
    if (bot.goal && bot.goal.x === tile.x && bot.goal.y === tile.y && queue.size?.() > 0
      && bot.goal.path.every((step) => !clouded(bot.fight, step.getX(), step.getY()))) {
      combat.preserveMovementForTicks?.(ANCHOR_TICKS);
      return true;
    }
    const path = tile.paths?.get(`${tile.x},${tile.y}`)?.path;
    if (!path?.length) return false;
    if (target && combat.getTarget?.() !== target) combat.attack(target);
    queue.reset();
    if (queue.addFirstStep) {
      queue.addFirstStep(path[0]);
      for (const step of path.slice(1)) queue.addSteps(step);
    } else {
      core.PathFinder.calculateWalkRoute(player, tile.x, tile.y);
    }
    combat.preserveMovementForTicks?.(Math.ceil(path.length / 2) + 1);
    bot.goal = { x: tile.x, y: tile.y, path };
    return true;
  }

  /** Prayers: protection for the form (the Jad phase alternating), the weapon's offensive one with restores. */
  function prayFor(form, plan, style) {
    let protect = null;
    if (plan.jad) {
      // The Jad phase: the other style from the one last thrown (its next is that), its first before any.
      const shot = Hazards.lastIncomingOf?.(player);
      if (shot && shot.at !== bot.lastShot) {
        bot.lastShot = shot.at;
        bot.jadSeen = shot.style;
      }
      protect = bot.jadSeen ? (bot.jadSeen === "ranged" ? "magic" : "ranged") : plan.jad;
    } else if (form === "green") protect = "ranged";
    else if (form === "blue") protect = "magic";
    const have = Supplies.supplies(core, player);
    const offensive = Boolean(have.prayerPotion?.length || have.superRestore?.length);
    const level = skills().getMaxLevel(core.Skill.PRAYER);
    const points = skills().getCurrentLevel(core.Skill.PRAYER);
    // Each attack thrown at it, against the protection it had up (judged as it's thrown): a miss logged.
    const shot = Hazards.lastIncomingOf?.(player);
    if (shot && shot.at !== bot.judged) {
      bot.judged = shot.at;
      const ok = shot.style === bot.protect;
      bot.prayStats = bot.prayStats ?? { right: 0, wrong: 0 };
      bot.prayStats[ok ? "right" : "wrong"] += 1;
      if (!ok) log({ wrongPrayer: shot.style, prayed: bot.protect ?? null, phase: bot.seen.length, form: bot.phase?.form ?? null, at: bot.phase?.at ?? null, jad: Boolean(plan.jad), surfaced: Boolean(bot.fight?.surfaced) });
    }
    bot.protect = protect && points > 0 ? protect : null;
    const fight = { unavailable: bot.refused };
    const wanted = protect && points > 0 ? Supplies.wantedPrayers(player, fight, protect, style, level, offensive) : [];
    const active = player.getPrayerActive?.() ?? [];
    for (let id = 0; id < active.length; id++) if (active[id] && !wanted.includes(id)) Supplies.setPrayer(core, player, id, false);
    for (const id of wanted) if (!Supplies.setPrayer(core, player, id, true) && points > 0) bot.refused.add(id);
  }

  /** Eats, cures, drinks; true when it ate (an attack waits). */
  function sustain() {
    const have = Supplies.supplies(core, player);
    const hp = share(core.Skill.HITPOINTS);
    if (hp < EAT_BELOW) {
      const ate = Supplies.use(core, player, have.food?.[0]);
      if (hp < COMBO_BELOW) Supplies.use(core, player, have.karambwan?.[0]);
      if (ate) return true;
    }
    const clock = player.getCombat().getPoisonClock?.();
    const venomed = player.isVenomed?.() === true || (player.getPoisonDamage?.() ?? 0) > 0 || (clock && clock.isVenomImmune?.() === false);
    if (venomed && (have.antivenom?.length || have.antipoison?.length)) Supplies.use(core, player, have.antivenom?.[0] ?? have.antipoison[0]);
    if (skills().getCurrentLevel(core.Skill.PRAYER) < DRINK_PRAYER_BELOW) Supplies.use(core, player, have.prayerPotion?.[0] ?? have.superRestore?.[0]);
    // Both styles kept boosted (it switches every phase), each again as its boost wears off.
    Supplies.boostTick(core, player, "magic", have, bot);
    Supplies.boostTick(core, player, "ranged", Supplies.supplies(core, player), bot);
    return false;
  }

  /** No food and failing: a teleport out (the run lost, not the bot). True when it read one. */
  function escape() {
    const have = Supplies.supplies(core, player);
    if (have.food?.length || have.karambwan?.length || share(core.Skill.HITPOINTS) >= ESCAPE_BELOW) return false;
    const items = player.getInventory().getItems();
    for (let slot = 0; slot < items.length; slot++) {
      const id = items[slot]?.getId?.();
      const name = String(core.CacheDefinitions.getItem(id)?.name ?? "").toLowerCase();
      if (name !== "zul-andra teleport" && name !== "teleport to house") continue;
      const actions = (core.CacheDefinitions.getItem(id)?.inventoryActions ?? []).map((a) => String(a ?? "").toLowerCase());
      const index = actions.findIndex((a) => a === "teleport" || a === "break" || a === "read");
      if (index < 0) continue;
      core.ItemActionPacketListener.handleAction(player, 3214, id, slot, index + 1, actions[index]);
      onEscape();
      return true;
    }
    return false;
  }

  /** The nearest live snakeling in reach, or null. */
  function snakeling(fight, range) {
    const here = player.getLocation();
    const away = (npc) => chebyshev(npc.getLocation().getX(), npc.getLocation().getY(), here.getX(), here.getY());
    return [...fight.hazards.snakelings].filter((npc) => npc.getHitpoints() > 0 && npc.isRegistered?.() !== false && away(npc) <= range)
      .sort((a, b) => away(a) - away(b))[0] ?? null;
  }

  /** One tick of the fight (stage "waiting" or "fight"). */
  function tick(fight) {
    if (fight !== bot.fight) {
      bot.fight = fight;
      bot.seen = [];
      bot.phase = null;
      bot.boosted = false;
    }
    if (player.isRunningReturn?.() === false && player.getRunEnergy?.() >= 1) player.setRunning(true);
    observe(fight);
    const plan = planFor(bot.seen);
    // While Zulrah is down (diving, or before it first rises): where the next phase is fought from.
    const up = fight.surfaced && bot.seen.length > 0;
    const form = up ? bot.phase.form : null;
    const spotName = up ? plan.stand : (bot.seen.length ? plan.next : "TOP_EAST");
    // Up: the form it's in. Down: the one it rises in next (kept as it is while that's unknown).
    const coming = up ? form : nextForm(bot.seen);
    const style = coming ? styleFor(coming) : Tactics.currentStyle(core, player);
    if (setsNow()[style] && Tactics.currentStyle(core, player) !== style) Tactics.wearSet(core, player, setsNow()[style]);
    prayFor(form, plan, style);
    if (escape()) return;
    const ate = sustain();
    const range = reach(style);
    const zulrah = fight.zulrah;
    const live = fight.attackable && zulrah && zulrah.getHitpoints() > 0 && zulrah.isRegistered?.() !== false;
    const target = snakeling(fight, range) ?? (live ? zulrah : null);
    if (spotName) {
      const at = up ? bot.phase.at : nextAt(bot.seen);
      const tile = goalTile(fight, spotName, at, form, range);
      if (walkTo(tile, target)) return;
    }
    if (ate) return;
    const combat = player.getCombat();
    if (target) {
      if (combat.getTarget?.() !== target) combat.attack(target);
      // On its spot: the combat attacks from here and doesn't chase.
      combat.preserveMovementForTicks?.(ANCHOR_TICKS);
    }
  }

  /** Prayers off (the fight over), and how its prayers did. */
  function stop() {
    if (bot.prayStats) log({ prayers: bot.prayStats });
    const active = player.getPrayerActive?.() ?? [];
    for (let id = 0; id < active.length; id++) if (active[id]) Supplies.setPrayer(core, player, id, false);
  }

  return { tick, stop, seen: () => bot.seen.slice(), plan: () => planFor(bot.seen) };
}

module.exports = { createController, planFor, candidates, nextAt, nextForm, tailSafeNear, STAND, PLANS };
