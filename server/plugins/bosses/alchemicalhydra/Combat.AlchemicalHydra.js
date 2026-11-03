/**
 * The Alchemical Hydra's combat method (Wiki: Alchemical Hydra/Strategies; stats from
 * monsters-complete): ranged and magic, switching every three basic attacks (every attack once
 * enraged) after its heads sway back, 35 at most (52 empowered by a wrong vent) and every 6
 * ticks, 55 and every 4 ticks enraged; the phase's special in
 * place of an attack when the count says so (Fight.AlchemicalHydra.js). Protection prayers block
 * its attacks entirely, as for any NPC.
 */
const Common = require("./Common.AlchemicalHydra");

/** The heads sway once the 2-tick attack animation (seqs 8235/8236 ...) has run. */
const SWAY_AFTER_TICKS = 2;

/** OSRS hit delays: magic 1 + (1 + d) / 3, ranged 1 + (3 + d) / 6 ticks. */
function hitDelay(style, distance) {
  if (style === "magic") return 1 + Math.floor((1 + distance) / 3);
  return 1 + Math.floor((3 + distance) / 6);
}

function combatClass() {
  const { CombatMethod, CombatType, PendingHit, Animation, Projectile } = Common.core;
  const { combat } = Common.data;

  class HydraCombat extends CombatMethod {
    hits(character, target) {
      if (!character || !target || !this.style) return [];
      const fight = character.getAsNpc?.()?.__hydraFight;
      const max = fight ? fight.maxHit() : combat.maxHit;
      const hit = new PendingHit(character, target, this, this.delay);
      hit.setTotalDamage(Math.min(max, hit.getTotalDamage()));
      return [hit];
    }

    start(character, target) {
      this.style = null;
      const npc = character?.getAsNpc?.();
      const fight = npc?.__hydraFight;
      if (!npc || !fight || fight.stopped || !target) return;
      if (fight.transitioning()) {
        character.getCombat().setAttackDelay(1);
        return;
      }
      const kind = fight.nextAttack();
      fight.counted(kind);
      const { ids } = Common;
      if (kind === "special") {
        const special = Common.data.phases[fight.phase].special;
        // The flame special animates when it reaches the centre (Fight.breatheFire).
        if (special === "fire") {
          fight.startFire(target);
          return;
        }
        npc.performAnimation(new Animation(ids.seqs.special[fight.phase]));
        if (special === "poison") fight.spitPoison(target);
        else if (special === "lightning") fight.castLightning();
        return;
      }
      this.style = kind;
      npc.performAnimation(new Animation((kind === "magic" ? ids.seqs.magic : ids.seqs.ranged)[fight.phase]));
      if (fight.switchesNext()) fight.swayLater(SWAY_AFTER_TICKS);
      const distance = Common.distanceToFootprint(target.getLocation(), npc);
      this.delay = hitDelay(kind, distance);
      const projectile = kind === "magic" ? ids.spotanims.magic : ids.spotanims.ranged;
      new Projectile(Projectile.centreOf(npc), target.getLocation(), target, projectile, 30, this.delay * 30, 80, 31, npc.getPrivateArea?.() ?? null).sendProjectile();
    }

    attackDistance() {
      return combat.attackDistance;
    }

    attackSpeed(character) {
      return character?.getAsNpc?.()?.__hydraFight?.enraged ? combat.enragedAttackSpeed : combat.attackSpeed;
    }

    type() {
      return this.style === "magic" ? CombatType.MAGIC : CombatType.RANGED;
    }
  }
  return HydraCombat;
}

function attach(api) {
  api.registerNpcCombatMethodProvider(Common.phaseForms(), combatClass(), { singleton: false });
}

module.exports = { attach, combatClass, hitDelay };
