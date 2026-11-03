/**
 * The Alchemical Hydra's death: its pools, currents and fires go with it, the kill is counted
 * (Combat Achievements counts it from the death, and times the fight for its speed tasks; the
 * message "Your Alchemical Hydra kill count is: N." reads that count a tick later) and a task kill is
 * worth 1,320 Slayer experience (Wiki, monsters-complete). Its loot is the "alchemical_hydra"
 * table (NpcDrops), the Ikkle hydra roll the pets table's; the chamber's door opens again.
 */
const Common = require("./Common.AlchemicalHydra");

/** Combat Achievements' count for the Hydra, or null when it doesn't answer. */
function countedKills(player) {
  const request = { player, monster: Common.data.kill.monster };
  Common.api.emitCustomEvent("combat-achievements:count", request);
  return Number.isInteger(request.total) ? request.total : null;
}

function hydraDeath({ npc, killer }) {
  if (!Common.isHydra(npc)) return;
  npc.__hydraFight?.stop();
  npc.__hydraLair?.respawnLater?.();
  const player = killer?.isPlayer?.() ? killer : null;
  if (!player?.isRegistered?.()) return;
  const own = (Number(player.getAttribute(Common.KILLS_ATTRIBUTE)) || 0) + 1;
  player.setAttribute(Common.KILLS_ATTRIBUTE, own);
  Common.later(1, () => {
    const kills = Math.max(own, countedKills(player) ?? 0);
    player.sendMessage(Common.message("killCount", { kills }));
  });
}

/** "slayer:task-kill": the Hydra's Slayer experience is its own, not its hitpoints. */
function slayerXp(kill) {
  if (Common.isHydra(kill?.npc)) kill.xp = Common.data.kill.slayerXp;
}

/**
 * The kill: the enraged form's last head falls (hydra_stage_4_death, its own skeleton, played by
 * the death task from npc-combat-defs), then it becomes the final form (hydraboss_finaldeath) for
 * hydra_death, the one seq built on that model. The death task waits for both (deathTicks 10).
 */
function beforeDeath(event) {
  if (!Common.isHydra(event.npc) || event.preventDeath) return;
  const fight = event.npc.__hydraFight;
  // Direct damage (such as recoil) can bypass the normal attack modifier.
  if (fight && !fight.enraged) {
    event.preventDeath = true;
    event.npc.setHitpoints(1);
    return;
  }
  const npc = event.npc;
  Common.later(Common.data.combat.headFallTicks, () => {
    if (!npc.isRegistered?.()) return;
    npc.setNpcTransformationId(Common.ids.npcs.dead);
    npc.performAnimation(new Common.core.Animation(Common.ids.seqs.finalDeath));
  });
}

function attach(api) {
  api.persistAttribute(Common.KILLS_ATTRIBUTE, 0);
  api.onNpcBeforeDeath(beforeDeath);
  api.onNpcDeath(hydraDeath);
  api.onCustomEvent("slayer:task-kill", slayerXp);
}

module.exports = { attach, hydraDeath, slayerXp, countedKills };
