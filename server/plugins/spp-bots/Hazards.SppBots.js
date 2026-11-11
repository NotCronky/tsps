"use strict";

/**
 * Tiles to get off (docs/playerbots.md, Boss tasks): a projectile fired at a tile rather than at
 * someone is something landing there (a demonic gorilla's boulder, Zulrah's venom clouds), and a
 * player in view sees it coming and steps aside. Core tells us of each one
 * (`Projectile.onGroundTarget`); `data/monsters.json` `hazards` says, per projectile id, how wide
 * it hits (`radius`: 1 is 3x3) and how long it stays (`lastsTicks` after landing: a cloud lingers).
 * Unknown ground projectiles count as their own tile until they land.
 *
 * And places to stand: a monster's form can name tiles to fight from (`forms.<id>.standAt`, the
 * Wiki's safespots, such as Zulrah's pillars against the red form's tail).
 *
 * A dodge keeps the fight going, as the Gauntlet bot's does (GauntletPlay.SppBots.js, from tsps):
 * the monster stays targeted and the walk is the combat's own "manual movement"
 * (`preserveMovementForTicks`), so an attack goes from wherever the bot stands as soon as it's
 * ready and in reach, and the combat doesn't walk it back onto the tile; with the attack ready
 * and the landing more than SWING_FIRST_TICKS off, it swings first and steps after. A plain walk
 * dropped the target and the hold returned before the re-attack: sppdev stopped hitting the
 * demonic gorillas from each boulder till it had landed.
 */

const path = require("path");

const DATA = require(path.join(__dirname, "data", "monsters.json"));
const TICK_MS = 600;
// Look this far for a safe tile.
const DODGE_RANGE = 3;
// A dodge walk is given this long before another is asked for.
const DODGE_MS = 1200;
// With the attack ready, a landing at least this many ticks off leaves time to swing first.
const SWING_FIRST_TICKS = 2;

const hazards = [];

function hazardSpec(projectileId) {
  return DATA.hazards?.[String(projectileId)] ?? { radius: 0, lastsTicks: 1 };
}

/** Core's ground-target listener: remember where it lands, how wide, and for how long. */
function onShot({ projectileId, end, privateArea, landsInTicks }) {
  const spec = hazardSpec(projectileId);
  const now = Date.now();
  // Prune what's over (cheap: the list holds a handful).
  for (let index = hazards.length - 1; index >= 0; index--) if (hazards[index].until < now) hazards.splice(index, 1);
  hazards.push({
    x: end.getX(), y: end.getY(), z: end.getZ(), area: privateArea ?? null, radius: spec.radius ?? 0,
    from: now, lands: now + landsInTicks * TICK_MS, until: now + (landsInTicks + (spec.lastsTicks ?? 1)) * TICK_MS, id: projectileId,
  });
}

// The style of the last projectile each player saw coming (data/monsters.json `projectiles`).
const incoming = new WeakMap();

function onFiredAt({ projectileId, target }) {
  const style = DATA.projectiles?.[String(projectileId)];
  // Any player: a real one in bot mode sees them coming too (playsAsPlayer is bots only, and
  // sppdev prayed against ranged a whole Hunllef fight while it threw magic).
  if (style && target?.isPlayer?.()) incoming.set(target, { style, at: Date.now() });
}

function attach(core) {
  core.Projectile?.onGroundTarget?.(onShot);
  core.Projectile?.onFiredAtPlayer?.(onFiredAt);
}

/** What was last thrown at `player` (within 20 s): { style, at } (its Date.now), or null. */
function lastIncomingOf(player) {
  const seen = incoming.get(player);
  return seen && Date.now() - seen.at < 20000 ? seen : null;
}

/** The style of what was last thrown at `player` (within 20 s), or null. */
function lastIncoming(player) {
  const seen = incoming.get(player);
  return seen && Date.now() - seen.at < 20000 ? seen.style : null;
}

/**
 * Tiles made dangerous by what stands on them in the bot's instance: NPCs (`npcHazards`: a
 * tornado and the tiles around it) and objects (`objectHazards`: the Hunllef's lit floor).
 */
function localHazards(core, player) {
  const area = player.getPrivateArea?.() ?? null;
  if (!area) return [];
  const here = player.getLocation();
  const out = [];
  const npcRadius = DATA.npcHazards ?? {};
  if (Object.keys(npcRadius).length) {
    core.World.getNpcs().forEach((npc) => {
      if (!npc || npc.getPrivateArea?.() !== area) return;
      const radius = npcRadius[String(npc.getId())];
      if (radius === undefined) return;
      const at = npc.getLocation();
      if (Math.max(Math.abs(at.getX() - here.getX()), Math.abs(at.getY() - here.getY())) <= 8) out.push({ x: at.getX(), y: at.getY(), z: at.getZ(), radius });
    });
  }
  const objectIds = new Set((DATA.objectHazards ?? []).map(Number));
  if (objectIds.size && typeof area.getObjects === "function") {
    for (const object of area.getObjects()) {
      if (!objectIds.has(object.getId())) continue;
      const at = object.getLocation();
      if (Math.max(Math.abs(at.getX() - here.getX()), Math.abs(at.getY() - here.getY())) <= 6) out.push({ x: at.getX(), y: at.getY(), z: at.getZ(), radius: 0 });
    }
  }
  return out;
}

/** Whether (x, y, z) in `area` is under something landing or lying there (or one of `extra`). */
function dangerous(x, y, z, area, now = Date.now(), extra = []) {
  for (const hazard of extra) {
    if (hazard.z === z && Math.max(Math.abs(hazard.x - x), Math.abs(hazard.y - y)) <= hazard.radius) return true;
  }
  for (const hazard of hazards) {
    if (hazard.until < now || hazard.z !== z || hazard.area !== area) continue;
    if (Math.max(Math.abs(hazard.x - x), Math.abs(hazard.y - y)) <= hazard.radius) return true;
  }
  return false;
}

function walkable(core, x, y, z, area) {
  // The region's own full-block mask (as Zulrah's shrine checks its tiles).
  const BLOCKED = core.RegionManager.BLOCKED_MASK ?? require("./Imports.SppBots").BLOCKED;
  try {
    return !(core.RegionManager.getClipping(x, y, z, area) & BLOCKED);
  } catch {
    return false;
  }
}

/** The form rule of a monster (data/monsters.json `forms`), by its NPC id, or null. */
function formOf(npc) {
  const name = String(npc?.getCurrentDefinition?.()?.getName?.() ?? "").toLowerCase();
  const rule = (DATA.rules ?? []).find((r) => r.names.some((n) => n.toLowerCase() === name));
  return rule?.forms?.[String(npc?.getId?.())] ?? null;
}

/**
 * Off a dangerous tile, or onto the form's stand tile: a walk, and true while it's on its way
 * (the fight's other steps wait). Called every tick of a fight before anything else.
 */
/**
 * To a tile with the fight kept: the monster targeted first (a new target clears the manual
 * movement), the route, then the combat told the walk is the bot's own for `ticks`. Without the
 * combat's hooks (a test's player), a plain walk.
 */
function stepTo(core, player, npc, goal, z, ticks) {
  const combat = player.getCombat?.();
  if (combat?.attack && combat.preserveMovementForTicks && core.PathFinder?.calculateWalkRoute && npc?.getHitpoints?.() > 0) {
    if (combat.getTarget?.() !== npc) combat.attack(npc);
    player.getMovementQueue().reset();
    core.PathFinder.calculateWalkRoute(player, goal.x, goal.y);
    combat.preserveMovementForTicks(ticks);
    return;
  }
  player.getMovementQueue().requestWalk(new core.Location(goal.x, goal.y, z), null);
}

/** While held off a tile: the monster still targeted, and the combat kept from walking it back. */
function holdTarget(entry, npc, nowMs) {
  const combat = entry.player.getCombat?.();
  if (!combat?.attack || !combat.preserveMovementForTicks || !(npc?.getHitpoints?.() > 0)) return;
  if (combat.getTarget?.() !== npc) combat.attack(npc);
  combat.preserveMovementForTicks(Math.max(1, Math.ceil((entry.dodgeUntil - nowMs) / TICK_MS)));
}

function dodgeTick(core, entry, npc, nowMs = Date.now()) {
  const player = entry.player;
  if (nowMs < (entry.dodgeUntil ?? 0)) {
    holdTarget(entry, npc, nowMs);
    return true;
  }
  const here = player.getLocation();
  const area = player.getPrivateArea?.() ?? null;
  const [x, y, z] = [here.getX(), here.getY(), here.getZ()];
  const stand = formOf(npc)?.standAt;
  const extra = localHazards(core, player);
  // Under the monster itself (a big one's footprint): the Hunllef stomps whoever stands there,
  // and the dodge used to step sppdev right under its 5x5 body.
  const body = npc?.getLocation?.();
  const size = Math.max(1, Number(npc?.size?.() ?? 1) || 1);
  const under = (tx, ty) => body && size > 1 && tx >= body.getX() && tx < body.getX() + size && ty >= body.getY() && ty < body.getY() + size;
  let goal = null;
  if (under(x, y) || dangerous(x, y, z, area, nowMs, extra)) {
    // The nearest tile that's open and clear, nearer the monster on a tie (to keep hitting it).
    const at = npc?.getLocation?.();
    let best = null;
    for (let dx = -DODGE_RANGE; dx <= DODGE_RANGE; dx++) {
      for (let dy = -DODGE_RANGE; dy <= DODGE_RANGE; dy++) {
        if (!dx && !dy) continue;
        const [tx, ty] = [x + dx, y + dy];
        if (under(tx, ty) || dangerous(tx, ty, z, area, nowMs, extra) || !walkable(core, tx, ty, z, area)) continue;
        const score = Math.max(Math.abs(dx), Math.abs(dy)) * 10 + (at ? Math.max(Math.abs(at.getX() - tx), Math.abs(at.getY() - ty)) : 0);
        if (!best || score < best.score) best = { x: tx, y: ty, score };
      }
    }
    goal = best;
    // Held off the tile until what's landing there has landed: a 1.2 s hold let the bot's next
    // attack walk it back under a boulder (sppdev, 85 -> 57 hitpoints, a third: a boulder).
    const landing = hazards.filter((h) => h.area === area && h.z === z && Math.max(Math.abs(h.x - x), Math.abs(h.y - y)) <= h.radius);
    // The attack ready and the landing still a while off: swing first, step after.
    const combat = player.getCombat?.();
    const lands = Math.min(...landing.map((h) => h.lands ?? h.until), Infinity);
    if (goal && !under(x, y) && combat?.getTarget?.() === npc && combat.getAttackDelay?.() <= 0 && lands - nowMs > SWING_FIRST_TICKS * TICK_MS) return false;
    if (goal) {
      const until = Math.max(...landing.map((h) => h.until), 0);
      entry.hazardUntil = Math.max(entry.hazardUntil ?? 0, until);
      entry.dodgeLog?.({ from: { x, y }, to: { x: goal.x, y: goal.y }, until: Math.max(0, until - nowMs) });
    }
  } else if (Array.isArray(stand) && stand.length && !stand.some(([sx, sy]) => sx === x && sy === y)) {
    const [sx, sy] = stand.reduce((a, b) => (Math.max(Math.abs(a[0] - x), Math.abs(a[1] - y)) <= Math.max(Math.abs(b[0] - x), Math.abs(b[1] - y)) ? a : b));
    if (!dangerous(sx, sy, z, area, nowMs, extra)) goal = { x: sx, y: sy };
  }
  if (!goal) return false;
  entry.dodgeUntil = Math.max(nowMs + DODGE_MS, entry.hazardUntil ?? 0);
  stepTo(core, player, npc, goal, z, Math.max(1, Math.ceil((entry.dodgeUntil - nowMs) / TICK_MS)));
  entry.dodged = (entry.dodged ?? 0) + 1;
  return true;
}

/** The style to pray against for a monster's form, if the data names one. */
function protectFor(npc, player = null) {
  const form = formOf(npc);
  if (form?.protect) return form.protect;
  // A monster whose rule says so: what it last threw at the bot (the Hunllef switches every 4).
  const name = String(npc?.getCurrentDefinition?.()?.getName?.() ?? "").toLowerCase();
  const rule = (DATA.rules ?? []).find((r) => r.names.some((n) => n.toLowerCase() === name));
  // Before anything's been thrown: the style it opens with (`firstStyle`).
  return rule?.protectBy === "projectile" && player ? lastIncoming(player) ?? rule.firstStyle ?? null : null;
}

module.exports = { attach, onShot, onFiredAt, lastIncoming, lastIncomingOf, localHazards, dangerous, dodgeTick, protectFor, formOf, hazards };
