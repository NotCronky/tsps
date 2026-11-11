"use strict";

/**
 * A bot attacked by a monster, as a player at a tree would be (docs/playerbots.md, Phase 1 step 2).
 * It decides first whether this is a fight it wants: a fighter (not a skiller) takes on a monster
 * no higher level than itself; anything else, it walks away from (auto retaliate off while it
 * goes) and its activity picks somewhere else. In a fight it chose, auto retaliate (the game's
 * own) does the hitting and the activity waits; Supplies.SppBots.js eats (a karambwan combo when
 * it's low), drinks and prays; with nothing left that heals it runs. PvP isn't handled here.
 */

const INVENTORY_INTERFACE = 3214;
const Supplies = require("./Supplies.SppBots");
const Tactics = require("./Tactics.SppBots");
const Hazards = require("./Hazards.SppBots");
// Each bot runs below somewhere in this band of its hitpoints, once it has nothing left to heal.
const FLEE_AT = [0.25, 0.4];
const FLEE_TILES = 18;
// After running, the bot keeps away from the spot this long before its activity picks again.
const FLEE_MS = 20 * 1000;

function between([low, high]) {
  return low + Math.random() * (high - low);
}

/**
 * The monster attacking the bot, or null (nothing, or a player). Only an attacker: a fight the bot
 * started itself (a combat activity) is that activity's business.
 */
function npcAttacker(core, player) {
  const npc = player.getCombat().getAttacker?.() ?? null;
  if (!npc || !npc.isNpc?.() || !(npc.getHitpoints?.() > 0)) return null;
  return core.CombatFactory.inCombat(player) ? npc : null;
}

/**
 * Before the bot's brain thinks: true while the bot is busy with a fight (the brain waits).
 * `entry` keeps the bot's own thresholds and its flight.
 */
function defend(api, entry, nowMs, log = () => {}) {
  const core = api.core;
  const player = entry.player;
  if (entry.died) {
    // Dead until it's back on its feet; then its kept gear goes back on and it starts afresh.
    if (player.isDyingReturn?.() === true || player.getHitpoints() <= 0) return true;
    entry.died = false;
    entry.fight = null;
    entry.fleeingUntil = null;
    if (entry.retaliate !== undefined) {
      player.setAutoRetaliate?.(entry.retaliate);
      entry.retaliate = undefined;
    }
    const worn = rearm(core, player);
    entry.brain?.reset?.();
    log("spp_bots_rearmed", { name: player.getUsername(), worn });
    return true;
  }
  // A task that plays its fights itself (the Gauntlet's run: GauntletPlay.SppBots.js) gets the
  // tick, every tick; the brain waits.
  if (entry.combatTask?.play?.(player, nowMs)) return true;
  if (entry.fleeingUntil && nowMs < entry.fleeingUntil) {
    // Keep running until clear of it; the walk was asked for when it set off.
    return player.getMovementQueue().size?.() > 0 || nowMs < entry.fleeingUntil - FLEE_MS / 2;
  }
  entry.fleeingUntil = null;
  // Clear of it: auto retaliate back as the bot had it.
  if (entry.retaliate !== undefined) {
    player.setAutoRetaliate?.(entry.retaliate);
    entry.retaliate = undefined;
  }
  // The monster of a fight in progress, even between its hits while the bot switches weapons
  // (a wield resets the bot's own attack until it attacks again).
  const fought = entry.fight?.npc;
  // A monster whose hits the game scripts (the Hunllef: damage with no attacker) never shows as
  // the attacker, so its task names it (`engaged`); without this no prayer or food came on.
  const engaged = entry.combatTask?.engaged?.(player) ?? null;
  const npc = npcAttacker(core, player) ?? (engaged?.getHitpoints?.() > 0 ? engaged : null) ?? (entry.fight?.spec && fought?.getHitpoints?.() > 0 ? fought : null);
  if (!npc) {
    // Over: prayers off, as a player saving points; a special weapon still in hand goes back.
    if (entry.fight?.supplies) Supplies.prayersOff(core, player);
    if (entry.fight?.spec) {
      entry.fight.spec = { ...entry.fight.spec, phase: "back" };
      Tactics.specialTick(core, player, entry.fight, null, nowMs);
      if (entry.fight.spec) return true;
    }
    entry.fight = null;
    return false;
  }
  if (!entry.fight) {
    const wants = wantsToFight(entry, npc);
    entry.fight = { fleeAt: between(FLEE_AT), since: nowMs, wants, supplies: Supplies.newFight(Math.random, (entry.refusedPrayers ??= new Set())), npc };
    log("spp_bots_attacked", {
      name: player.getUsername(), by: npc.getCurrentDefinition?.(player)?.getName?.() ?? npc.getId(),
      npcLevel: npcLevel(npc), combat: player.getSkillManager().getCombatLevel(), fights: wants, at: tileOf(player.getLocation()),
    });
    if (!wants) {
      leave(core, entry, npc, nowMs);
      log("spp_bots_fled", { name: player.getUsername(), why: "not worth fighting", at: tileOf(player.getLocation()) });
      return true;
    }
  }
  // Off a tile something is about to land on (a boulder, a cloud), or onto the form's safespot;
  // eating and praying go on (a player does both while stepping), the rest waits for the walk.
  entry.dodgeLog ??= (data) => log("spp_bots_dodge", { name: player.getUsername(), ...data });
  const dodging = Hazards.dodgeTick(core, entry, npc, nowMs);
  // Supplies: food and karambwan, brews and restores, prayers and prayer potions, energy.
  const did = Supplies.supplyTick(core, player, entry.fight.supplies, npc);
  if (did) entry.fight.used = (entry.fight.used ?? 0) + 1;
  // The style that hurts this monster most (once, then after any weapon switch), and specials.
  if (!entry.fight.styled || entry.fight.styledWeapon !== player.getWeapon?.()) {
    // A training task trains one skill: its XP style; otherwise the most damage.
    Tactics.chooseStyle(core, player, npc, entry.combatTask?.task?.xpStyle ?? null);
    entry.fight.styled = true;
    entry.fight.styledWeapon = player.getWeapon?.();
  }
  // A style the monster prays against, or a new form: switch to a carried set (combat tasks).
  // Out of everything that heals and low: run, even mid-dodge (the dodge step returning first
  // kept sppdev among the gorillas until it died at 0).
  {
    const skills = player.getSkillManager();
    const hp = skills.getCurrentLevel(core.Skill.HITPOINTS) / Math.max(1, skills.getMaxLevel(core.Skill.HITPOINTS));
    if (hp < entry.fight.fleeAt && !Supplies.canHeal(core, player) && !entry.combatTask?.stays) {
      Supplies.prayersOff(core, player);
      leave(core, entry, npc, nowMs);
      log("spp_bots_fled", { name: player.getUsername(), why: "low hitpoints", hitpoints: Math.round(hp * 100), at: tileOf(player.getLocation()) });
      return true;
    }
  }
  if (dodging) return true;
  entry.fight.switchLog ??= (data) => log("spp_bots_switch", { name: player.getUsername(), ...data });
  const switched = !did && Tactics.switchTick(core, player, entry.fight, npc, entry.combatTask?.sets, nowMs);
  if (!did && !switched) Tactics.specialTick(core, player, entry.fight, npc, nowMs);
  const skills = player.getSkillManager();
  const hitpoints = core.Skill.HITPOINTS;
  const share = skills.getCurrentLevel(hitpoints) / Math.max(1, skills.getMaxLevel(hitpoints));
  // Runs only with nothing left that heals (not from a fight there's no way out of: `stays`).
  if (share < entry.fight.fleeAt && !Supplies.canHeal(core, player) && !entry.combatTask?.stays) {
    Supplies.prayersOff(core, player);
    leave(core, entry, npc, nowMs);
    log("spp_bots_fled", { name: player.getUsername(), why: "low hitpoints", hitpoints: Math.round(share * 100), at: tileOf(player.getLocation()) });
    return true;
  }
  // Fighting: auto retaliate does the hitting; the activity would only click away from it. Not
  // hitting back (auto retaliate off, as a real player's in bot mode can be, after a dodge or a
  // wield reset the attack): click the monster again, as a player does, at most every 2 s.
  // (sppdev stood among the gorillas being cast at, not hitting back.)
  if (entry.fight.wants && player.getCombat().getTarget?.() !== npc && !player.getMovementQueue().size?.() && nowMs >= (entry.fight.reattackAt ?? 0)) {
    Tactics.reattack(player, npc);
    entry.fight.reattackAt = nowMs + 2000;
  }
  return true;
}

/** Puts on everything in the inventory that's worn (Wear/Wield), as a player after dying. */
function rearm(core, player) {
  const worn = [];
  const items = player.getInventory().getItems();
  for (let slot = 0; slot < items.length; slot++) {
    const item = items[slot];
    if (!item || item.getAmount() <= 0) continue;
    const actions = (core.CacheDefinitions.getItem(item.getId())?.inventoryActions ?? []).map((a) => String(a ?? "").toLowerCase());
    if (!actions.some((action) => action === "wear" || action === "wield")) continue;
    // Wield/Wear is its own packet (EquipPacketListener), not an item action.
    core.EquipPacketListener.equip(player, item.getId(), slot, INVENTORY_INTERFACE);
    worn.push(item.getId());
  }
  return worn;
}

function npcLevel(npc) {
  return Number(npc.getCurrentDefinition?.()?.getCombatLevel?.() ?? 0) || 0;
}

/** A fight the bot wants: it's a fighter and the monster is no higher level than it is. */
function wantsToFight(entry, npc) {
  // A combat task's monster is what the bot came for.
  if (entry.combatTask?.wants?.(npc)) return true;
  if (entry.bot?.profile?.archetype === "skiller") return false;
  return npcLevel(npc) <= entry.player.getSkillManager().getCombatLevel();
}

/**
 * Off, out of the monster's reach: auto retaliate off until it's clear (or it would turn round
 * and fight), and whatever it was doing there it does somewhere else (that spot isn't safe).
 */
function leave(core, entry, npc, nowMs) {
  const player = entry.player;
  if (entry.retaliate === undefined) entry.retaliate = player.autoRetaliateReturn?.() ?? true;
  player.setAutoRetaliate?.(false);
  flee(core, player, npc);
  entry.fleeingUntil = nowMs + FLEE_MS;
  entry.fight = null;
  // On a combat task it banks and comes back; anything else, it does somewhere else.
  if (entry.combatTask) entry.combatTask.fled();
  else entry.brain?.reset?.();
}

/** Away from the monster, as a player clicking the ground behind them. */
function flee(core, player, npc) {
  const here = player.getLocation();
  const from = npc.getLocation();
  const dx = Math.sign(here.getX() - from.getX()) || (Math.random() < 0.5 ? -1 : 1);
  const dy = Math.sign(here.getY() - from.getY()) || (Math.random() < 0.5 ? -1 : 1);
  player.getCombat().reset?.();
  player.setRunning?.(player.getRunEnergy() > 1);
  player.getMovementQueue().requestWalk(new core.Location(here.getX() + dx * FLEE_TILES, here.getY() + dy * FLEE_TILES, here.getZ()), null);
}

function tileOf(location) {
  return { x: location.getX(), y: location.getY(), z: location.getZ() };
}

module.exports = { defend };
