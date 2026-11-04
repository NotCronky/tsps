/**
 * The Phantom Muspah's ways of hurting the player, shared by the fight's units: a styled hit that
 * rolls like any NPC attack and that the protection prayer blocks (all of it, or as much as the
 * fight allows), typeless damage from the arena, its heals and the projectiles its attacks draw.
 */
const Common = require("./Common.PhantomMuspah");

const styleMethods = new Map();

function styleMethod(style) {
  let method = styleMethods.get(style);
  if (!method) {
    const { CombatMethod, CombatType } = Common.core;
    const type = { melee: CombatType.MELEE, ranged: CombatType.RANGED, magic: CombatType.MAGIC }[style];
    method = new (class extends CombatMethod {
      type() {
        return type;
      }

      hits() {
        return [];
      }
    })();
    styleMethods.set(style, method);
  }
  return method;
}

const PRAYER_FOR = { melee: "PROTECT_FROM_MELEE", ranged: "PROTECT_FROM_MISSILES", magic: "PROTECT_FROM_MAGIC" };

function prayerOn(player, name) {
  const { PrayerHandler } = Common.core;
  return PrayerHandler.isActivated(player, PrayerHandler[name]);
}

function protectedFrom(player, style) {
  return Boolean(PRAYER_FOR[style]) && prayerOn(player, PRAYER_FOR[style]);
}

/**
 * A styled hit from `npc`, landing `delay` ticks from now. The protection prayer of its style lets
 * through `throughPrayer` of the damage (0 blocks it all). Returns the pending hit.
 */
function strike(npc, player, style, maxHit, delay, { throughPrayer = 0 } = {}) {
  const { PendingHit, CombatFactory, World } = Common.core;
  const hit = new PendingHit(npc, player, styleMethod(style), { delay, rollAccuracy: true });
  CombatFactory.applyStyleDamage(hit, Math.max(0, Math.floor(maxHit)), { bypassProtectionPrayer: true });
  // Prayer is judged now, outside the hit queue: announced first (for ::autopray).
  Common.api.emitCustomEvent("combat:incoming-attack", { attacker: npc, target: player, type: style, cycle: World.getProcessCycle() });
  if (protectedFrom(player, style)) {
    for (const part of hit.getHits()) part.setDamage(Math.floor(part.getDamage() * throughPrayer));
    hit.updateTotalDamage();
  }
  player.getCombat().getHitQueue().addPendingHit(hit, World.getProcessCycle() + Math.max(0, delay));
  return hit;
}

/** Damage no prayer or armour stops (spikes, clouds, the shockwave), landing now. */
function damage(player, amount) {
  const { HitDamage, HitMask } = Common.core;
  const value = Math.max(0, Math.floor(amount));
  player.getCombat().getHitQueue().addPendingDamage([new HitDamage(value, value > 0 ? HitMask.RED : HitMask.BLUE)]);
  return value;
}

/** The Muspah heals, with the heal hitsplat (capped at its full hitpoints). */
function heal(npc, amount) {
  const value = Math.max(0, Math.floor(amount));
  if (value <= 0 || !npc?.isRegistered?.()) return;
  const max = Common.data.boss.hitpoints;
  npc.setHitpoints(Math.min(max, npc.getHitpoints() + value));
  const splat = Common.data.shield.healSplat;
  npc.showHitsplat(value, { mine: splat, others: splat });
}

function drainPrayer(player, points) {
  const { Skill } = Common.core;
  const skills = player.getSkillManager();
  const now = skills.getCurrentLevel(Skill.PRAYER);
  const drained = Math.min(now, Math.max(0, Math.floor(points)));
  skills.setCurrentLevel(Skill.PRAYER, now - drained, true);
  return drained;
}

/** A projectile from `from` (a mobile or a tile) to `to` (a mobile or a tile), as captured. */
function projectile(area, from, to, spec) {
  const { Projectile, Location } = Common.core;
  const tileOf = (thing) => (thing instanceof Location ? thing : Projectile.centreOf(thing));
  const lockon = to instanceof Location ? null : to;
  new Projectile(tileOf(from), tileOf(to), lockon, spec.id, spec.start, spec.end, spec.startHeight, spec.endHeight, area)
    .withAngle(spec.angle)
    .withProgress(spec.progress)
    .sendProjectile();
}

module.exports = { strike, damage, heal, drainPrayer, projectile, protectedFrom, prayerOn };
