"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { nearestClusters, npcClustersFor } = require("../NpcClusterIndex.PlayerBots");
const { canReachSpot } = require("../../behaviours/navigation/LongRoutes.PlayerBots");
const { requestMovement, clearMovementRequest, peekMovementRequest, randomInRange } =
  require("../../behaviours/navigation/Navigation.PlayerBots");

/** A slot to empty (the shield, under a two-handed weapon). */
const EMPTY = Symbol("empty");
const TARGET_RETRY_MS = 1800;
const TARGET_SPREAD = 4;
const ATTACK_DISTANCE = 20;
const RESERVATION_MS = 10000;
const TARGET_STALL_MS = 45000;
const SITE_STALL_MS = 120000;
// Targets must be this close (Chebyshev) to the chosen cluster's centre.
const SITE_RADIUS = 24;
// Within this of the centre a trainer stops walking and waits for targets there.
const SITE_ARRIVE = 8;
// A cluster this bot could not reach or train at is skipped for this long.
const SITE_AVOID_MS = 10 * 60 * 1000;
// Settled at a cluster with nothing it can attack (caged jail NPCs, all claimed):
// move on after this long instead of idling out SITE_STALL_MS.
const EMPTY_SITE_MS = 45000;
// A pending movement request with no tile change this long is a dead dispatch
// (blocked route); drop the target/site and let the next tick re-route.
const MOVEMENT_STALL_MS = 8000;
// ...and at least this many brain ticks without moving: far-from-players bots tick
// every ~7-18 s (LOD + task budget), so time alone would call every fresh walk frozen
// before its dispatch had a chance to move the bot.
const MOVEMENT_STALL_TICKS = 3;
// A combat target that lands no hit this long is being blocked (fence/gate):
// fall back to a walked brain route so doors get opened.
const ATTACK_STUCK_MS = 6000;
const RANGED_AMMO_AMOUNT = 1000;
// Shared across action instances: two trainers must not claim the same idle NPC.
const CLAIMS = new WeakMap();
// Shared across action instances: cluster key -> trainers there, so trainers fill
// the nearest NPC clusters up to capacity and fan out from there.
const SITE_OCCUPANTS = new Map();

function occupants(siteId) {
  let players = SITE_OCCUPANTS.get(siteId);
  if (!players) SITE_OCCUPANTS.set(siteId, (players = new Set()));
  for (const player of players) if (player.isRegistered?.() === false) players.delete(player);
  return players;
}

/** Stable per-bot seed so each trainer keeps its random low-gear outfit. */
function hashSeed(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function createTrainCombatAction(spec, world) {
  const core = world?.core;
  if (!core) throw new Error("[bot activities] trainCombat requires api.core");
  const { Skill, Equipment, Item, ItemIdentifiers, Flag, FightStyle,
    WeaponInterfaceManager, CombatFactory, CanAttackResponse,
    RsmodRouteFinding } = core;
  const skills = [Skill.ATTACK, Skill.STRENGTH, Skill.DEFENCE];
  const styles = [FightStyle.ACCURATE, FightStyle.AGGRESSIVE, FightStyle.DEFENSIVE];
  const skillByIndex = new Map(Skill.values().map((skill) => [skill.getIndex(), skill]));
  const stages = [...(spec.stages ?? [])].sort((a, b) => a.minLevel - b.minLevel);
  if (!stages.length || stages[0].minLevel !== 1 || stages.some((stage) => !stage.id ||
      !(stage.npcLevels?.min >= 1) || !(stage.npcLevels.max >= stage.npcLevels.min))) {
    throw new Error("[bot activities] trainCombat requires stages starting at level 1 with npcLevels { min, max }");
  }
  // Opponents are attackable NPCs in the stage's combat-level band; excludeNames drops
  // ones that cannot be fought where they stand (ducks on water).
  const excludedNames = new Set((spec.excludeNames ?? []).map((name) => String(name).toLowerCase()));
  const opponentLevel = (definition) => {
    const level = definition?.getCombatLevel?.() ?? 0;
    return definition?.isAttackable?.() === true && level > 0 &&
      !excludedNames.has(String(definition.getName?.() ?? "").toLowerCase()) ? level : null;
  };
  const levelKeys = (stage) => Array.from(
    { length: stage.npcLevels.max - stage.npcLevels.min + 1 }, (_, index) => stage.npcLevels.min + index);
  // Tiles of extra walking worth one more trainer per NPC at a cluster: lower keeps
  // trainers close and crowded, higher spreads them further out.
  const spreadDistance = Math.max(1, Number(spec.spreadDistance ?? 150));
  const routeExists = world.routes?.canReachSpot ?? canReachSpot;
  const resolveItem = (key) => {
    const id = ItemIdentifiers[key];
    if (!Number.isInteger(id)) throw new Error(`[bot activities] unknown training item '${key}'`);
    return id;
  };
  const buildTiers = (tiers) => (tiers ?? []).map((tier) => ({
    minLevel: tier.minLevel,
    weapons: (tier.weapons ?? []).map(resolveItem),
    ammo: (tier.ammo ?? []).map(resolveItem),
    spells: (tier.spells ?? []).map((key) => {
      const spell = core.CombatSpells?.[key];
      if (!spell) throw new Error(`[bot activities] unknown training spell '${key}'`);
      return spell;
    }),
    armour: Object.entries(tier.armour ?? {}).map(([slot, keys]) => {
      if (!Number.isInteger(Equipment[slot])) throw new Error(`[bot activities] unknown equipment slot '${slot}'`);
      return [Equipment[slot], (Array.isArray(keys) ? keys : [keys])
        .map((key) => (key === null ? null : resolveItem(key)))];
    }),
  })).sort((a, b) => a.minLevel - b.minLevel);
  const meleeTiers = buildTiers(spec.gearTiers);
  const rangedTiers = buildTiers(spec.rangedTiers);
  const magicTiers = buildTiers(spec.magicTiers);
  const combatStyles = (spec.styles ?? ["melee"]).filter((style) =>
    style === "ranged" ? rangedTiers.length > 0
      : style === "magic" ? magicTiers.length > 0
        : meleeTiers.length > 0);
  // This many targets (or frozen routes) in a row without landing damage fails the
  // site; crowded sites lose targets to other trainers, so keep it generous.
  const maxFailedTargets = Math.max(1, Math.floor(Number(spec.maxFailedTargets ?? 6)));
  const foodId = resolveItem(spec.food ?? "TROUT");
  const foodAmount = Math.max(1, Math.min(28, Number(spec.foodAmount ?? 16)));
  const minSeconds = Math.max(1, Number(spec.durationSeconds?.min ?? 300));
  const maxSeconds = Math.max(minSeconds, Number(spec.durationSeconds?.max ?? 720));
  const stateFor = (player) => playerState(action, player, () => ({
    target: null, site: null, stageId: null, previousSiteId: null,
    endsAt: 0, retryAt: 0, lastProgressAt: 0, position: null, targetHp: null,
    claimedAt: 0, failedTargets: 0, progressFlag: false, avoided: new WeakMap(), avoidedSites: new Map(),
  }));
  const styleFor = (player, state) => {
    if (!state.combatStyle) {
      const index = combatStyles.length
        ? hashSeed(`${player.getUsername?.() ?? "bot"}:style`) % combatStyles.length
        : 0;
      state.combatStyle = combatStyles[index] ?? "melee";
    }
    return state.combatStyle;
  };
  const tiersFor = (style) =>
    style === "ranged" ? rangedTiers : style === "magic" ? magicTiers : meleeTiers;
  const offenseSkillFor = (style) =>
    style === "ranged" ? Skill.RANGED : style === "magic" ? Skill.MAGIC : Skill.ATTACK;
  const levelFor = (player, state) => {
    const style = styleFor(player, state);
    if (style === "ranged") return player.getSkillManager().getMaxLevel(Skill.RANGED);
    if (style === "magic") return player.getSkillManager().getMaxLevel(Skill.MAGIC);
    return Math.min(...skills.map((skill) => player.getSkillManager().getMaxLevel(skill)));
  };
  const stageFor = (player, state) => stages.filter((stage) => levelFor(player, state) >= stage.minLevel).pop();
  const routeFinder = new RsmodRouteFinding();
  // Wall-aware reach (entity strategy, no moveNear): a tile touching the NPC across
  // a fence or closed gate does not count. Unreachable NPCs are walked towards
  // instead, which lets the brain open the gate.
  const reachable = (player, npc) => {
    const from = player.getLocation();
    const to = npc.getLocation();
    if (from.getZ() !== to.getZ()) return false;
    const size = Math.max(1, Math.floor(npc.getSize?.() ?? 1));
    const route = routeFinder.findRoute({
      level: from.getZ(), srcX: from.getX(), srcY: from.getY(),
      srcSize: Math.max(1, Math.floor(player.getSize?.() ?? 1)),
      destX: to.getX(), destY: to.getY(),
      destWidth: size, destLength: size, locAngle: 0, locShape: -2,
      moveNear: false, blockAccessFlags: 0, maxWaypoints: 25,
      privateArea: player.getPrivateArea?.() ?? null,
    });
    return route.success === true;
  };
  const live = (npc) => !!npc && npc.isNpc?.() === true && npc.isRegistered?.() === true &&
    npc.getHitpoints() > 0 && npc.isDyingFunction?.() !== true;

  function release(player, bot) {
    if (bot.target && CLAIMS.get(bot.target)?.player === player) CLAIMS.delete(bot.target);
    bot.target = null;
    bot.targetHp = null;
  }

  function prepare(player, state) {
    let changed = false;
    const equipment = player.getEquipment();
    const manager = player.getSkillManager();
    const inventory = player.getInventory();
    const style = styleFor(player, state);
    const tiers = tiersFor(style);
    const offenseTier = tiers.filter((entry) =>
      manager.getCurrentLevel(offenseSkillFor(style)) >= entry.minLevel).pop();
    // Melee armour follows Defence like the old loadout; ranged/magic armour follows its skill.
    const armourTier = style === "melee"
      ? tiers.filter((entry) => manager.getCurrentLevel(Skill.DEFENCE) >= entry.minLevel).pop()
      : offenseTier;
    const seedBase = player.getUsername?.() ?? "bot";
    const carries = (id) => inventory.getAmount(id) > 0 || equipment.getItems().some((item) => item?.getId?.() === id);
    const pick = (pool, seed) => {
      if (!pool?.length) return null;
      const start = hashSeed(`${seedBase}:${seed}`) % pool.length;
      for (let index = 0; index < pool.length; index += 1) {
        const id = pool[(start + index) % pool.length];
        if (id === null) return null;
        const requirements = new Item(id, 1).getDefinition().getRequirements() ?? [];
        if (requirements.some((required, i) => required > manager.getCurrentLevel(skillByIndex.get(i)))) continue;
        // Only gear the character owns and carries: it progresses like a player.
        if (!carries(id)) continue;
        return id;
      }
      return null;
    };
    const items = [];
    const weapon = offenseTier ? pick(offenseTier.weapons, `weapon:${offenseTier.minLevel}`) : null;
    if (offenseTier) {
      items.push([Equipment.WEAPON_SLOT, weapon]);
      if (style === "ranged") {
        const ammo = pick(offenseTier.ammo, `ammo:${offenseTier.minLevel}`);
        if (Number.isInteger(ammo)) items.push([Equipment.AMMUNITION_SLOT, ammo, RANGED_AMMO_AMOUNT]);
        // No bow or no arrows of its own: fight with what it has instead.
        else if (!Number.isInteger(weapon)) state.combatStyle = "melee";
      }
    }
    for (const [slot, keys] of armourTier?.armour ?? []) {
      items.push([slot, pick(keys, `slot:${slot}:${armourTier.minLevel}`)]);
    }
    // Last write wins: a two-handed weapon vacates the shield the armour roll chose.
    if (Number.isInteger(weapon) && new Item(weapon, 1).getDefinition().isDoubleHanded?.() === true) {
      items.push([Equipment.SHIELD_SLOT, EMPTY]);
    }
    for (const [slot, id, amount] of items) {
      const existing = equipment.getItems()[slot];
      if (id === EMPTY) {
        // A two-handed weapon: the shield goes back into the inventory.
        if (existing?.getId() > 0) {
          inventory.adds(existing.getId(), existing.getAmount());
          equipment.set(slot, new Item(-1, 1));
          changed = true;
        }
        continue;
      }
      // Nothing better owned for the slot: keep what is worn.
      if (!Number.isInteger(id)) continue;
      if (existing?.getId() === id) continue;
      // `spec.keepWorn(player)`: ids it must keep on (a Slayer task's earmuffs, mirror shield).
      if (existing?.getId() > 0 && spec.keepWorn?.(player)?.includes?.(existing.getId())) continue;
      // Put it on as a player does: out of the inventory, with what it replaces put back there.
      const carried = Math.min(inventory.getAmount(id), amount ?? 1);
      if (carried <= 0) continue;
      inventory.deleteNumber(id, carried);
      if (existing?.getId() > 0) inventory.adds(existing.getId(), existing.getAmount());
      equipment.set(slot, new Item(id, carried));
      changed = true;
    }
    if (changed) {
      equipment.refreshItems();
      WeaponInterfaceManager.assign(player);
      world.refreshEquipment(player);
      player.getUpdateFlag().flag(Flag.APPEARANCE);
    }
    if (style === "magic" && offenseTier) {
      const level = manager.getCurrentLevel(Skill.MAGIC);
      const available = offenseTier.spells.filter((spell) => level >= (spell.levelRequired?.() ?? 1));
      const spell = available.length
        ? available[hashSeed(`${seedBase}:spell:${offenseTier.minLevel}`) % available.length]
        : null;
      // Only with the runes for it carried: they are the character's own.
      const castable = spell && (spell.itemsRequired?.(player) ?? [])
        .every((rune) => inventory.getAmount(rune.getId()) >= rune.getAmount());
      if (castable) {
        core.Autocasting?.setAutocast(player, spell);
        for (const rune of spell.itemsRequired?.(player) ?? []) (stateFor(player).runeIds ??= new Set()).add(rune.getId());
      } else {
        // No runes for it: fight with what it has instead.
        state.combatStyle = "melee";
      }
    }
    if (style === "melee") {
      const levels = skills.map((skill) => manager.getMaxLevel(skill));
      const fightStyle = styles[levels.indexOf(Math.min(...levels))];
      const fightType = Object.values(player.getWeapon()?.getFightType?.() ?? {})
        .find((type) => type?.getStyle?.() === fightStyle);
      if (fightType) WeaponInterfaceManager.changeCombatStyle(player, fightType.getChildId());
    }
    // Food is the character's own too: what it carries is what it can eat.
    state.virtualFoodChargesRemaining = inventory.getAmount(foodId);
  }

  /**
   * Picks an NPC cluster from the index (no hand-drawn areas) by the lowest
   * trainers-per-NPC + distance / spreadDistance, so trainers fill near, roomy
   * clusters first and spill outward in proportion. Skips the last visit and
   * clusters this bot failed at.
   */
  function selectSite(player, bot, stage, nowMs) {
    const loc = player.getLocation();
    // `spec.targets(player)`: { key, counts(definition) } (a Slayer task's monsters) in place of the
    // stage's level band; null when there's nothing to fight.
    const targets = spec.targets ? spec.targets(player) : null;
    if (spec.targets && !targets) return false;
    const index = targets
      ? npcClustersFor(world, `trainCombat:targets:${targets.key}`, (definition) => (opponentLevel(definition) !== null && targets.counts(definition) ? "target" : null))
      : npcClustersFor(world, `trainCombat:${[...excludedNames]}`, opponentLevel);
    const clusters = nearestClusters(index, targets ? ["target"] : levelKeys(stage), { x: loc.getX(), y: loc.getY(), z: loc.getZ() })
      .filter((cluster) => (bot.avoidedSites.get(cluster.key) ?? 0) <= nowMs);
    const fresh = clusters.filter((cluster) => cluster.key !== bot.previousSiteId);
    const pool = fresh.length ? fresh : clusters;
    if (!pool.length) return false;
    const score = (cluster) => occupants(cluster.key).size / cluster.count + cluster.distance / spreadDistance;
    // Best-scoring cluster the route planner can reach (jail, desert pass, island are
    // skipped by this bot). null: still planning, try again next tick.
    let cluster = null;
    for (const entry of [...pool].sort((a, b) => score(a) - score(b))) {
      const reachable = routeExists(player, entry, nowMs);
      // Not planned yet (planning budget spent): pick next tick, never walk blind.
      if (reachable === undefined) return null;
      if (reachable === true) {
        cluster = entry;
        break;
      }
      bot.avoidedSites.set(entry.key, nowMs + SITE_AVOID_MS);
    }
    if (!cluster) return false;
    occupants(cluster.key).add(player);
    bot.site = { id: cluster.key, npcLevels: stage.npcLevels, targets, anchor: { x: cluster.x, y: cluster.y, z: cluster.z } };
    bot.previousSiteId = cluster.key;
    bot.stageId = stage.id;
    bot.endsAt = nowMs + randomInRange(minSeconds, maxSeconds) * 1000;
    bot.lastProgressAt = nowMs;
    bot.settled = false;
    world.regionManager.loadMapFiles?.(cluster.x, cluster.y);
    world.log?.("bot_combat_training_site", {
      username: player.getUsername(), stage: stage.id, site: cluster.key, x: cluster.x, y: cluster.y,
    });
    return true;
  }

  /** Leaves the current cluster; `avoidMs` keeps this bot from picking it again soon. */
  function leaveSite(player, bot, nowMs = 0, avoidMs = 0) {
    if (!bot.site) return;
    if (avoidMs) bot.avoidedSites.set(bot.site.id, nowMs + avoidMs);
    occupants(bot.site.id).delete(player);
    bot.previousSiteId = bot.site.id;
    bot.site = null;
    bot.approachNpc = null;
  }

  /** Stops fighting/claiming the current target; `avoidMs` bars re-picking it. */
  function dropTarget(player, bot, nowMs, avoidMs = 0) {
    if (bot.target) {
      if (avoidMs) bot.avoided.set(bot.target, nowMs + avoidMs);
      if (player.getCombat().getTarget() === bot.target) player.getCombat().reset();
    }
    player.setCombatFollowing?.(null);
    release(player, bot);
  }

  function available(player, npc, bot, nowMs) {
    if (!live(npc) || npc.getPrivateArea?.() !== player.getPrivateArea?.()) return false;
    const at = npc.getLocation();
    const anchor = bot.site.anchor;
    if (at.getZ() !== anchor.z ||
        Math.max(Math.abs(at.getX() - anchor.x), Math.abs(at.getY() - anchor.y)) > SITE_RADIUS) return false;
    const definition = npc.getCurrentDefinition(player);
    const level = opponentLevel(definition);
    if (level === null) return false;
    if (bot.site.targets ? !bot.site.targets.counts(definition) : level < bot.site.npcLevels.min || level > bot.site.npcLevels.max) return false;
    if ((bot.avoided.get(npc) ?? 0) > nowMs) return false;
    const combat = npc.getCombat();
    if ((combat.getTarget() && combat.getTarget() !== player) ||
        (combat.getAttacker() && combat.getAttacker() !== player)) return false;
    const claim = CLAIMS.get(npc);
    return !claim || claim.player === player || claim.until <= nowMs || claim.player.isRegistered?.() === false;
  }

  const action = {
    id: spec.id ?? "trainCombat",
    update(ctx) {
      const { player, state, nowMs } = ctx;
      if (!player || !state) return "failed";
      const bot = stateFor(player);
      if (player.getHitpoints() <= 0 || player.isDyingReturn?.()) {
        release(player, bot);
        leaveSite(player, bot);
        return "running";
      }
      if (player.isTeleportingReturn?.() || player.getForceMovement?.() || player.busy?.()) return "running";
      // Its targets are done with (a Slayer task finished): this fight is over, the last kill made.
      const targets = spec.targets ? spec.targets(player) : null;
      if (spec.targets && (!targets || (bot.site?.targets && bot.site.targets.key !== targets.key)) && !player.getCombat().getTarget()) {
        release(player, bot);
        leaveSite(player, bot);
        return "success";
      }
      const location = player.getLocation();
      const position = `${location.getX()},${location.getY()},${location.getZ()}`;
      bot.stillTicks = position === bot.position ? (bot.stillTicks ?? 0) + 1 : 0;
      if (position !== bot.position) {
        bot.position = position;
        bot.lastProgressAt = nowMs;
        bot.progressFlag = true;
      }
      const hp = bot.target?.getHitpoints();
      if (bot.target && Number.isFinite(bot.targetHp) && hp < bot.targetHp) {
        // Damage landed: this target is not a failure, keep it fresh.
        bot.lastProgressAt = nowMs;
        bot.progressFlag = true;
        bot.claimedAt = nowMs;
        bot.failedTargets = 0;
      }
      bot.targetHp = hp ?? null;
      const combat = player.getCombat();
      // Reactive player-combat overlays own PvP; this activity only attacks NPCs.
      if (combat.getTarget()?.isPlayer?.() || combat.getAttacker()?.isPlayer?.()) return "running";
      // A dispatch that cannot resolve (no route, no door that helps) leaves its
      // request pending forever; after a short frozen window drop the target and
      // site and count the failure, so repeated stalls fail the activity instead
      // of hopping sites forever.
      if (peekMovementRequest(player) && nowMs - bot.lastProgressAt >= MOVEMENT_STALL_MS &&
          bot.stillTicks >= MOVEMENT_STALL_TICKS) {
        clearMovementRequest(player);
        bot.retryAt = nowMs;
        bot.failedTargets += 1;
        const blockedNpc = bot.target ?? bot.approachNpc;
        const anchor = bot.site?.anchor;
        const fromAnchor = anchor
          ? Math.max(Math.abs(location.getX() - anchor.x), Math.abs(location.getY() - anchor.y)) : 0;
        if (blockedNpc) {
          // Could not get to this NPC (fence without a gate, water): skip it, keep the cluster.
          bot.avoided.set(blockedNpc, nowMs + SITE_STALL_MS);
          dropTarget(player, bot, nowMs);
          bot.approachNpc = null;
        } else if (anchor && fromAnchor <= SITE_RADIUS) {
          // As close to the centre as the map allows (centre on water/a fence): train from here.
          bot.settled = true;
        } else if (anchor) {
          // Never got near: this bot skips the cluster for a while. Not shared: a slow
          // or blocked walk says nothing about the cluster (the planner knows islands).
          leaveSite(player, bot, nowMs, SITE_AVOID_MS);
        }
      }
      if (bot.target && !live(bot.target)) {
        dropTarget(player, bot, nowMs);
        bot.failedTargets = 0;
        bot.retryAt = nowMs + randomInRange(600, TARGET_RETRY_MS);
      }
      if (bot.target) {
        const stalled = nowMs - bot.claimedAt >= TARGET_STALL_MS;
        if (stalled || !available(player, bot.target, bot, nowMs)) {
          if (stalled) bot.failedTargets += 1;
          dropTarget(player, bot, nowMs, SITE_STALL_MS);
          clearMovementRequest(player);
        } else {
          CLAIMS.set(bot.target, { player, until: nowMs + RESERVATION_MS });
          if (combat.getTarget() === bot.target) {
            // Combat pathing cannot open doors; when a held fight lands no hit
            // (fence between us), keep a walked route alive so the brain's
            // dispatch opens the blocking gate.
            if (nowMs - bot.claimedAt >= ATTACK_STUCK_MS) {
              const destination = bot.target.getLocation();
              requestMovement(player, destination.getX?.() ?? destination.x, destination.getY?.() ?? destination.y,
                { state, nowMs, z: destination.getZ?.() ?? destination.z ?? 0, reason: "brain_combat_training", basicPather: true });
            }
            return "running";
          }
        }
      }
      if (!bot.target) {
        const stage = stageFor(player, state);
        if (bot.site && (bot.stageId !== stage.id || nowMs >= bot.endsAt)) return "success";
        if (bot.failedTargets >= maxFailedTargets) {
          world.log?.("bot_combat_training_stalled", {
            username: player.getUsername?.() ?? null, site: bot.site?.id ?? null,
            failures: bot.failedTargets, x: location.getX(), y: location.getY(),
          });
          leaveSite(player, bot, nowMs, SITE_AVOID_MS);
          return "failed";
        }
        const home = state.home;
        if (!bot.site && home && Number.isFinite(home.z) && location.getZ() !== home.z) {
          // Left upstairs (a bank floor): NPC clusters are found per floor, go back down first.
          if (!peekMovementRequest(player)) {
            requestMovement(player, home.x, home.y, { state, nowMs, z: home.z, reason: "brain_combat_training", basicPather: true });
          }
          return "running";
        }
        if (!bot.site) {
          const selected = selectSite(player, bot, stage, nowMs);
          if (selected === null) return "running";
          if (!selected) return "failed";
        }
        if (nowMs - bot.lastProgressAt >= SITE_STALL_MS) {
          leaveSite(player, bot, nowMs, SITE_AVOID_MS);
          return "failed";
        }
        if (nowMs < bot.retryAt) return "running";
        bot.retryAt = nowMs + TARGET_RETRY_MS;
        prepare(player, state);
        // Every NPC near the cluster, not just those in regions active around real players.
        const candidates = world.core.World.getNpcsNear(location, SITE_RADIUS + ATTACK_DISTANCE, player.getPrivateArea?.() ?? null)
          .filter((npc) => available(player, npc, bot, nowMs))
          .sort((a, b) => location.getDistance(a.getLocation()) - location.getDistance(b.getLocation()))
          .slice(0, TARGET_SPREAD);
        const offset = randomInRange(0, Math.max(0, candidates.length - 1));
        bot.approachNpc = null;
        for (let index = 0; index < candidates.length; index += 1) {
          const npc = candidates[(index + offset) % candidates.length];
          if (CombatFactory.canAttackPermission(player, npc, false, CombatFactory.getMethod(player)) !==
              CanAttackResponse.CAN_ATTACK) continue;
          if (!reachable(player, npc)) {
            // Behind a fence/gate: walk at it so the dispatch opens the way in.
            bot.approachNpc ??= npc;
            continue;
          }
          bot.target = npc;
          bot.targetHp = npc.getHitpoints();
          bot.claimedAt = nowMs;
          CLAIMS.set(npc, { player, until: nowMs + RESERVATION_MS });
          break;
        }
        if (bot.target || bot.approachNpc || !bot.settled) {
          bot.emptySince = null;
        } else if (nowMs - (bot.emptySince ??= nowMs) >= EMPTY_SITE_MS) {
          bot.emptySince = null;
          leaveSite(player, bot, nowMs, SITE_AVOID_MS);
          return "running";
        }
      }
      if (bot.target && location.getDistance(bot.target.getLocation()) <= ATTACK_DISTANCE) {
        clearMovementRequest(player);
        if (styleFor(player, state) !== "magic") {
          combat.setAutocastSpell?.(null);
          combat.setCastSpell?.(null);
        }
        combat.attack(bot.target);
        return "running";
      }
      if (player.getMovementQueue().size() > 0 || peekMovementRequest(player)) return "running";
      const anchor = bot.site.anchor;
      if (!bot.target && !bot.approachNpc &&
          (bot.settled || Math.max(Math.abs(location.getX() - anchor.x), Math.abs(location.getY() - anchor.y)) <= SITE_ARRIVE)) {
        // At the cluster: wait for a target here instead of re-walking onto the centre
        // (a walk to where we stand never completes and would read as a stall).
        bot.settled = true;
        return "running";
      }
      const destination = bot.target?.getLocation() ?? bot.approachNpc?.getLocation() ?? anchor;
      requestMovement(player, destination.getX?.() ?? destination.x, destination.getY?.() ?? destination.y,
        { state, nowMs, z: destination.getZ?.() ?? destination.z ?? 0, reason: "brain_combat_training", basicPather: true });
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      // Food and runes are the character's own, so they stay in its inventory.
      bot.runeIds = null;
      dropTarget(ctx.player, bot, ctx.nowMs);
      clearMovementRequest(ctx.player);
      leaveSite(ctx.player, bot);
      bot.position = null;
      bot.retryAt = 0;
      bot.failedTargets = 0;
      if (ctx.state) ctx.state.doorAttempt = null;
    },
    describe(ctx) {
      const bot = stateFor(ctx.player);
      const at = (loc) => (loc ? `${loc.getX?.() ?? loc.x},${loc.getY?.() ?? loc.y}` : "none");
      return `train site=${bot.site ? `${bot.site.id}@${at(bot.site.anchor)}` : "none"} ` +
        `target=${bot.target ? `${bot.target.getDefinition?.()?.getName?.()}@${at(bot.target.getLocation())}` : "none"} ` +
        `approach=${at(bot.approachNpc?.getLocation())} settled=${!!bot.settled} failed=${bot.failedTargets} idle=${Math.round((ctx.nowMs - bot.lastProgressAt) / 1000)}s`;
    },
    madeProgress(ctx) {
      const bot = stateFor(ctx.player);
      if (!bot.progressFlag) return false;
      bot.progressFlag = false;
      return true;
    },
  };
  return action;
}

module.exports = { createTrainCombatAction };
