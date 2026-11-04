/**
 * The Sire's tentacles striking (Wiki: Tentacle (Abyssal Sire)): an awake tentacle hits a player
 * within a tile of its footprint every 4 ticks with abyssal_tentacle_attack, the hit landing a
 * tick later (captured). Up to 30 (Wiki: Strategies), rolled with the tentacle's own stats so about
 * half miss, as in the captures; Protect from Melee takes a little off, assumed a fifth (the Wiki
 * doesn't say how much). Their forms (asleep, awake, stunned) are the Lair's.
 */
const Common = require("./Common.AbyssalSire");

let TentacleMethod = null;

function tentacleMethod() {
  if (!TentacleMethod) {
    const { CombatMethod, CombatType } = Common.core;
    TentacleMethod = new (class extends CombatMethod {
      type() {
        return CombatType.MELEE;
      }
      hits() {
        return [];
      }
    })();
  }
  return TentacleMethod;
}

class Tentacles {
  constructor(fight) {
    this.fight = fight;
    /** Fight tick each tentacle may next strike. */
    this.readyAt = new Map();
  }

  tick() {
    const fight = this.fight;
    if (!fight.playerHere()) return;
    const { anims, tentacles } = Common.data;
    const { Animation } = Common.core;
    const here = fight.player.getLocation();
    for (const tentacle of fight.lair.tentacles) {
      const npc = tentacle.npc;
      if (tentacle.state !== "active" || !npc?.isRegistered()) continue;
      if ((this.readyAt.get(npc) ?? 0) > fight.tick) continue;
      if (Common.distanceToFootprint(here, npc) > tentacles.reach) continue;
      this.readyAt.set(npc, fight.tick + tentacles.attackTicks);
      npc.performAnimation(new Animation(anims.tentacleAttack));
      fight.at(1, () => this.land(npc));
    }
  }

  land(npc) {
    const fight = this.fight;
    if (!fight.playerHere() || !npc.isRegistered()) return;
    const { CombatFactory, PendingHit, PrayerHandler, World } = Common.core;
    const { max, prayedFactor } = Common.data.tentacles;
    const hit = new PendingHit(npc, fight.player, tentacleMethod(), { delay: 0 });
    CombatFactory.applyStyleDamage(hit, max, { bypassProtectionPrayer: true });
    Common.api.emitCustomEvent("combat:incoming-attack", { attacker: npc, target: fight.player, type: "melee", cycle: World.getProcessCycle() });
    if (PrayerHandler.isActivated(fight.player, PrayerHandler.PROTECT_FROM_MELEE)) {
      for (const part of hit.getHits()) part.setDamage(Math.floor(part.getDamage() * prayedFactor));
      hit.updateTotalDamage();
    }
    fight.stats.tentacleDamage += hit.getTotalDamage();
    fight.player.getCombat().getHitQueue().addPendingHit(hit, World.getProcessCycle());
  }
}

module.exports = Tentacles;
