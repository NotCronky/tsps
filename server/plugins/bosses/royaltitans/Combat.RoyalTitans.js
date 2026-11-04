/**
 * The titans' combat method: the crush stomp with its shared 5x3 telegraph, the 7-tick
 * attack cycle, and the teleport trip at 210 HP. Specials (rows, minions, blast) and the
 * walk-between-attacks belong to Specials; this method only picks melee vs special.
 *
 * As captured: each titan attacks every 7 ticks, interleaved with the other's cycle, but
 * 12-16 ticks after a row. Mobile mix 41% stomp, 39% rows, 20% elementals at any range
 * (02283, 03398, 03402). The stomp telegraphs a 5-wide by 3-deep block centred on the target's tile
 * at cast, graphic 3211 from either caster, per-tile delay +2 per tile from the caster; the
 * hit is fully blocked by Protect from Melee (Wiki), crush, max 26. Post-teleport there are
 * no rows: melee, minions and the blast. When one titan is down first, the survivor's melee
 * pierces protection prayers (Wiki; unwitnessed, docs assumption).
 */
const Shared = require("./Shared.RoyalTitans");
const Specials = require("./Specials.RoyalTitans");
const CombatAchievements = require("./CombatAchievements.RoyalTitans");

let api = null;
let core = null;
let PrayerHandler = null;

const { alive, tileOf, later } = Shared;

function protectedMelee(target) {
  if (!target.isPlayer()) return false;
  return PrayerHandler.isActivated(target.getAsPlayer(), PrayerHandler.PROTECT_FROM_MELEE);
}

/**
 * The captured stomp: face the target, telegraph the 5x3 block around its tile with the
 * caster-distance delays, then roll once a tick later. Leaving the block dodges; Protect
 * from Melee blocks it fully (Wiki) unless the partner titan is down (pierce, Wiki).
 */
function startMelee(npc, target) {
  const anims = Shared.animationsFor(npc.getId());
  Specials.faceAcross(npc);
  npc.performAnimation(new core.Animation(anims.melee));
  const blocks = Specials.telegraphMelee(npc);
  const session = Shared.sessionOfNpc(npc);
  const pierce = session ? Specials.survivorEnraged(session, npc) : false;
  later(1, () => {
    if (!Shared.fighting(npc) || !alive(target)) return;
    const pos = tileOf(target);
    const inside = pos && blocks.some(([x, y]) => x === pos.x && y === pos.y);
    if (inside) api.emitCustomEvent("combat:incoming-attack", { attacker: npc, target, type: "melee", cycle: core.World.getProcessCycle() });
    const protect = protectedMelee(target);
    let damage = 0;
    if (inside && (!protect || pierce)) {
      damage = core.Misc.getRandom(Shared.MELEE_MAX);
    }
    if (damage > 0) {
      target.getCombat().getHitQueue().addPendingDamage([new core.HitDamage(damage, core.HitMask.RED)]);
      if (target.isPlayer()) {
        if (!protect || pierce) CombatAchievements.avoidableDamage(target.getAsPlayer(), damage, "melee");
      }
    }
  });
}

/**
 * The captured mix: mobile by the titan's spot (stomps from the lane edge, never from the
 * back); static, no rows, stomps 2:1 over elementals between blasts. A titan never summons
 * while its own elementals are still about (captured).
 */
function pickSpecial(npc, spot, ownMinionsUp) {
  const roll = Math.random();
  if (npc.getAttribute(Shared.TELEPORTED_ATTRIBUTE) === true) {
    return ownMinionsUp || roll < Shared.STATIC_MELEE_CHANCE ? "melee" : "minions";
  }
  const [melee, row] = Shared.MOBILE_MIX[spot];
  if (roll < melee) return "melee";
  if (roll < melee + row || ownMinionsUp) return "row";
  return "minions";
}

function combatClass() {
  const { CombatMethod, CombatType } = core;

  return class RoyalTitansCombat extends CombatMethod {
    start(character, target) {
      const npc = character.getAsNpc();
      if (!Shared.fighting(npc)) {
        character.getCombat().setAttackDelay(1);
        return;
      }
      if (core.World.getProcessCycle() < npc.getAttribute(Shared.ARMED_AT_ATTRIBUTE)) {
        character.getCombat().setAttackDelay(1);
        return;
      }
      const attacks = npc.getAttribute(Shared.ATTACKS_ATTRIBUTE) + 1;
      npc.setAttribute(Shared.ATTACKS_ATTRIBUTE, attacks);
      if (Specials.takeBlastTurn(npc, target)) return;
      const session = Shared.sessionOfNpc(npc);
      const spot = Specials.spotOf(npc);
      const choice = pickSpecial(npc, spot, Specials.hasOwnMinions(session, npc));
      if (choice === "melee") startMelee(npc, target);
      else if (choice === "row") Specials.startRow(npc, target);
      else Specials.startMinions(npc, target);
      // Mobile, the titan may then walk to its other spot or along its side; the next attack
      // waits on the walk.
      const steps = Specials.planWalk(npc, spot, choice);
      if (steps > 0) character.getCombat().setAttackDelay(Shared.WALK_DELAY_TICKS + 1 + steps);
    }

    hits() {
      return [];
    }

    /** Every attack is a cast or a telegraphed stomp (hits() lands nothing itself), so the
     * titans attack from where they stand: their own side of the lane while mobile
     * (Specials.planWalk), their static tiles after the teleport. */
    type() {
      return CombatType.MAGIC;
    }

    attackDistance() {
      return 12;
    }

    attackSpeed() {
      return Shared.ATTACK_SPEED_TICKS;
    }
  };
}

/**
 * Damage rules for everything hitting a live titan: poison/venom immunity (Wiki), hits
 * during the death sequence are discarded, and crossing 210 HP teleports both titans
 * (Specials.teleportTitans) unless the hit is lethal.
 */
function modifyHit(event) {
  const { npc, hit } = event;
  if (!Shared.isLiveTitan(npc.getId())) return;
  if (npc.isVenomed() || npc.isPoisoned()) {
    npc.setVenomed(false);
    npc.setPoisonDamage(0);
  }
  if (npc.getAttribute(Shared.DYING_ATTRIBUTE) === true) {
    for (const part of hit.getHits()) part.setDamage(0);
    hit.updateTotalDamage();
    return;
  }
  const incoming = hit.getHits().reduce((sum, part) => sum + part.getDamage(), 0);
  const projected = npc.getHitpoints() - incoming;
  if (projected <= 0) return;
  if (projected <= Shared.TELEPORT_THRESHOLD) Specials.teleportTitans(npc);
}

/**
 * The player's x6 ranged accuracy while the titan is out of melee distance (Wiki): the
 * engine's own roll, six times as likely to land.
 */
function rangedAccuracy(roll) {
  const { attacker, target } = roll;
  if (!attacker.isPlayer() || !target.isNpc() || !Shared.isLiveTitan(target.getId())) return;
  const style = roll.combatType;
  if (style !== core.CombatType.RANGED) return;
  const base = tileOf(target);
  const pos = tileOf(attacker);
  if (!base || !pos) return;
  if (Shared.edgeDistance(Shared.SIZE, base.x, base.y, pos.x, pos.y) <= 1) return;
  const { AccuracyFormulasDpsCalc, CombatType } = core;
  if (AccuracyFormulasDpsCalc.rollFixedAccuracy(attacker, target, CombatType.RANGED, Shared.RANGED_ACCURACY_MULTIPLIER, CombatType.RANGED)) {
    roll.forceAccurate = true;
  }
}

/** A titan taking a hit sounds for the player who landed it (captured on every hit). */
function hitSound({ attacker, target }) {
  if (!attacker?.isPlayer() || !target?.isNpc() || !Shared.isLiveTitan(target.getId())) return;
  attacker.getAsPlayer().getPacketSender().sendSoundEffect(Shared.TITAN_HIT_SOUND, 1, 0);
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  PrayerHandler = pluginApi.getPrayerHandler();
  pluginApi.onNpcHitModify(modifyHit);
  pluginApi.onCombatHitRoll(rangedAccuracy);
  pluginApi.onCombatHitResolved(hitSound);
  pluginApi.registerNpcCombatMethodProvider(
    [core.NpcIdentifiers.BRANDA_THE_FIRE_QUEEN, core.NpcIdentifiers.ELDRIC_THE_ICE_KING],
    combatClass(),
    { singleton: false },
  );
}

module.exports = {
  attach, modifyHit, rangedAccuracy, combatClass, startMelee,
  _test: { pickSpecial },
};
