"use strict";

/**
 * Learning aid (not OSRS): with ::autopray on, attacks on you are prayed against for you - a
 * monster's, or in PvP another player's.
 *
 * Content announces each attack on a player with `combat:incoming-attack`
 * ({ attacker, target, type, protects, cycle }): the style to protect against (a CombatType, or
 * "melee" / "ranged" / "magic"), or for fights where that is not the attack's own style (a curse
 * swapping prayers round) `protects(style)`, the share of the hit that protection lets through
 * (`protects(null)` with none up); and the cycle its protection prayer is checked on. The hit
 * queue announces every ordinary hit on a player as it is queued, an NPC's or another player's;
 * bosses that judge prayer themselves
 * (raid style helpers, the Hunllef, Jad's delayed impacts) announce their own.
 *
 * The protection kept up is for the attack judged next, so it only moves on once the one before
 * has been checked, and - unless ::autoprayoff has turned that off (OFFENSIVE_ATTRIBUTE) - the
 * best offensive prayer the player can use for their own weapon's style goes up with it. Once out of combat - no attack judged for OUT_OF_COMBAT_TICKS and the player
 * attacking nothing - the prayers it turned on that are still up are turned off again. Prayers the
 * player turned on themselves are left alone.
 */

const AUTOPRAY_ATTRIBUTE = "combat:autopray";
/** Whether auto-prayer also keeps an offensive prayer up; on unless ::autoprayoff turns it off. */
const OFFENSIVE_ATTRIBUTE = "combat:autopray-offensive";
const STYLES = ["melee", "ranged", "magic"];
// Estimate: about the 6 seconds a boss's slowest ordinary attacks take, so prayers stay up
// between them and through short phase changes.
const OUT_OF_COMBAT_TICKS = 10;

let core;
/**
 * player -> { attacks: still to be judged, [{ style, cycle }]; last: the latest cycle one was
 * judged on; prayed: the prayers auto-prayer turned on; task: the task watching them }.
 */
const incoming = new Map();

function initialize(api) {
  core = api.core;
}

function enabled(player) {
  return player?.isPlayer?.() === true && player.getAttribute?.(AUTOPRAY_ATTRIBUTE) === true;
}

function styleOf(type) {
  if (typeof type === "string") return STYLES.includes(type.toLowerCase()) ? type.toLowerCase() : null;
  const { CombatType } = core;
  if (type === CombatType.MELEE) return "melee";
  if (type === CombatType.RANGED) return "ranged";
  if (type === CombatType.MAGIC) return "magic";
  return null;
}

function protectionFor(style) {
  const P = core.PrayerHandler;
  return style === "magic" ? P.PROTECT_FROM_MAGIC : style === "ranged" ? P.PROTECT_FROM_MISSILES : P.PROTECT_FROM_MELEE;
}

/** Best first: one prayer, or a pair that together make the tier. */
function offensivePrayers(style) {
  const P = core.PrayerHandler;
  switch (style) {
    case "ranged": return [[P.RIGOUR], [P.EAGLE_EYE], [P.HAWK_EYE], [P.SHARP_EYE]];
    case "magic": return [[P.AUGURY], [P.MYSTIC_MIGHT], [P.MYSTIC_LORE], [P.MYSTIC_WILL]];
    case "melee": return [[P.PIETY], [P.CHIVALRY], [P.ULTIMATE_STRENGTH, P.INCREDIBLE_REFLEXES], [P.SUPERHUMAN_STRENGTH, P.IMPROVED_REFLEXES]];
    default: return [];
  }
}

function usable(player, prayer) {
  const { PrayerHandler, PrayerData, Skill } = core;
  const data = PrayerData.prayerData.get(prayer);
  return Boolean(data) && player.getSkillManager().getCurrentLevel(Skill.PRAYER) > 0
    && PrayerHandler.canUse(player, data, false);
}

/**
 * Turns a prayer on when it is off and can be used (quietly: no refusal messages each tick), and
 * notes it as auto-prayer's to turn off.
 */
function pray(player, prayer, entry) {
  const { PrayerHandler } = core;
  if (PrayerHandler.isActivated(player, prayer) || !usable(player, prayer)) return;
  PrayerHandler.activatePrayerPrayerId(player, prayer);
  if (PrayerHandler.isActivated(player, prayer)) entry.prayed.add(prayer);
}

/** Whether the player is still fighting something themselves. */
function attacking(player) {
  const target = player.getCombat?.()?.getTarget?.();
  return Boolean(target) && target.isRegistered?.() !== false && target.getHitpoints?.() > 0;
}

/** Out of combat: the prayers auto-prayer turned on, and that are still up, go off. */
function standDown(player, entry) {
  const { PrayerHandler } = core;
  for (const prayer of entry.prayed) {
    if (PrayerHandler.isActivated(player, prayer)) PrayerHandler.deactivatePrayer(player, prayer);
  }
  entry.prayed.clear();
}

/** The style of the player's own attacks, or null without one. */
function ownStyle(player) {
  try {
    return styleOf(core.CombatFactory.getMethod(player)?.type?.());
  } catch {
    return null;
  }
}

/**
 * Prays for the attack judged soonest; with none left and the fight over, stands down. False once
 * there is nothing more to watch.
 */
function update(player) {
  const entry = incoming.get(player);
  if (!entry) return false;
  const now = core.World.getProcessCycle();
  entry.attacks = entry.attacks.filter((attack) => attack.cycle >= now);
  if (!enabled(player) || player.isRegistered?.() === false || player.getHitpoints?.() <= 0) {
    incoming.delete(player);
    return false;
  }
  if (entry.attacks.length === 0) {
    if (now - entry.last < OUT_OF_COMBAT_TICKS || attacking(player)) return true;
    standDown(player, entry);
    incoming.delete(player);
    return false;
  }
  const next = entry.attacks.reduce((soonest, attack) => (attack.cycle < soonest.cycle ? attack : soonest));
  pray(player, protectionFor(next.style), entry);
  if (player.getAttribute?.(OFFENSIVE_ATTRIBUTE) === false) return true;
  for (const prayers of offensivePrayers(ownStyle(player))) {
    if (prayers.every((prayer) => usable(player, prayer))) {
      for (const prayer of prayers) pray(player, prayer, entry);
      break;
    }
  }
  return true;
}

function watch(player) {
  const { Task, TaskManager } = core;
  const task = new (class extends Task {
    constructor() {
      super(1, player, false);
    }
    execute() {
      if (!update(player)) this.stop();
    }
  })();
  TaskManager.submit(task);
  return task;
}

/** The protection that lets least of a hit through, by `protects`; null when none helps. */
function bestProtection(protects) {
  if (typeof protects !== "function") return null;
  let best = null;
  let lowest = protects(null);
  for (const style of STYLES) {
    const through = protects(style);
    if (through < lowest) {
      lowest = through;
      best = style;
    }
  }
  return best;
}

/** An attack on its way: prayed against at once if it is the next to be judged. */
function incomingAttack({ attacker, target, type, protects, cycle }) {
  if (!enabled(target) || attacker === target) return;
  const style = styleOf(type) ?? bestProtection(protects);
  if (!style) return;
  let entry = incoming.get(target);
  if (!entry) {
    entry = { attacks: [], last: -Infinity, prayed: new Set() };
    incoming.set(target, entry);
    entry.task = watch(target);
  }
  const now = core.World.getProcessCycle();
  const judged = Number.isFinite(cycle) ? Math.max(now, cycle) : now;
  entry.attacks.push({ style, cycle: judged });
  entry.last = Math.max(entry.last, judged);
  update(target);
}

/** `on`/`off` as given, else the opposite of `current`. */
function toggled(parts, current) {
  const arg = (parts?.[1] ?? "").toLowerCase();
  return arg === "on" ? true : arg === "off" ? false : !current;
}

/** ::autopray [on|off] - attacks on you are prayed against for you while you learn a fight. */
function toggleAutoPray({ player, parts }) {
  const on = toggled(parts, player.getAttribute(AUTOPRAY_ATTRIBUTE) === true);
  player.setAttribute(AUTOPRAY_ATTRIBUTE, on);
  const offensive = player.getAttribute(OFFENSIVE_ATTRIBUTE) !== false;
  player.sendMessage(on
    ? `Auto-prayer is <col=00aa00>on</col>: your protection ${offensive ? "and offensive prayers are" : "prayers are"} switched for you against monsters' and players' attacks.`
    : "Auto-prayer is <col=ff0000>off</col>.");
  return true;
}

/** ::autoprayoff [on|off] - whether auto-prayer also keeps up an offensive prayer for your weapon. */
function toggleOffensive({ player, parts }) {
  const on = toggled(parts, player.getAttribute(OFFENSIVE_ATTRIBUTE) !== false);
  player.setAttribute(OFFENSIVE_ATTRIBUTE, on);
  player.sendMessage(on
    ? "Auto-prayer's offensive prayers are <col=00aa00>on</col>: it keeps up the best one for your weapon."
    : "Auto-prayer's offensive prayers are <col=ff0000>off</col>: it only switches your protection prayers.");
  return true;
}

module.exports = {
  name: "AutoPrayer",
  AUTOPRAY_ATTRIBUTE,
  OFFENSIVE_ATTRIBUTE,
  register(api) {
    initialize(api);
    api.persistAttribute(AUTOPRAY_ATTRIBUTE, false);
    api.persistAttribute(OFFENSIVE_ATTRIBUTE, true);
    api.onCustomEvent("combat:incoming-attack", incomingAttack);
    api.registerCommand("autopray", toggleAutoPray, api.core.PlayerRights.NONE, "Toggle auto-prayer against monsters' and players' attacks (learning aid)");
    api.registerCommand("autoprayoff", toggleOffensive, api.core.PlayerRights.NONE, "Toggle whether auto-prayer also keeps up offensive prayers");
  },
};
