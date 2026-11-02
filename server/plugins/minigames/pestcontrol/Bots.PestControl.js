"use strict";

/**
 * Pest Control bots. A match hands every bot a role when it starts (assignRoles), and this
 * unit turns the role into behaviour for as long as the bot is on the island:
 *
 *   defender - holds a spread-out post beside the Void Knight and kills whatever is hitting
 *              or closing in on him (shifters, torchers, defilers, brawlers);
 *   attacker - one of four squads, one per portal in the match's shield order. The squad
 *              opens the nearest gate, waits spread out beside its portal while the shield
 *              is up (killing spinners and nearby pests meanwhile), hits the portal once the
 *              shield drops, and moves on to the next live portal when its own dies;
 *   repairer - carries a hammer and logs, goes out through a gate like an attacker, repairs
 *              the nearest damaged barricade or gate on its side of the wall, and otherwise
 *              fights pests from the gate. Out of logs it is an attacker.
 *
 * Bots that go out close the gate behind them when nobody else is about to pass, as the Wiki
 * asks ("ensure the gates stay closed"): an open gate lets the ground pests walk in to the
 * knight. Routes are plain pather walks (the island has no floors); a bot that makes no
 * progress for STUCK_TIMEOUT_MS takes a detour (another gate, another staging tile).
 *
 * The OSRS Wiki's Pest Control pages give the shape of a competent team: two to four players
 * defend the knight, everyone else attacks portals in shield order, spinners first.
 */

const { ActionNode, BotController, SelectorNode } = require("../../../src/main/typescript/elvarg/game/bot/BehaviorTree");
const { Boundary } = require("../../../src/main/typescript/elvarg/game/model/Boundary");
const { PathFinder } = require("../../../src/main/typescript/elvarg/game/model/movement/path/PathFinder");
const { CombatFactory, CanAttackResponse } = require("../../../src/main/typescript/elvarg/game/content/combat/CombatFactory");
const { CombatType } = require("../../../src/main/typescript/elvarg/game/content/combat/CombatType");
const { ItemIdentifiers } = require("../../../src/main/typescript/elvarg/util/ItemIdentifiers");
const { buildRoamingPvpMetadata } = require("../../bots/behaviours/pvp/PvpAssignment.PlayerBots");
const { applyGeneratedPvpLoadout } = require("../../bots/behaviours/policies/PvpLoadoutPolicy.PlayerBots");
const { initPvpTierLoadouts, pickTierChoice, TIER_PROFILE_IDS } = require("../../bots/behaviours/pvp/PvpTierLoadouts.PlayerBots");
const { isFoodItem } = require("../../items/Food.plugin");

const ROLES = Object.freeze({ DEFENDER: "defender", ATTACKER: "attacker", REPAIRER: "repairer" });
const BOT_ROLE_ATTRIBUTE = "pest-control:bot-role";
const BOT_SQUAD_ATTRIBUTE = "pest-control:bot-squad";

// Team shape. The Wiki's strategy page: "only 2-3 players need to defend the Void Knight
// directly"; everyone else attacks portals. One squad per portal in the shield order.
const SQUADS = 4;
const DEFENDER_SHARE = 1 / 6;
const MIN_DEFENDERS = 1;
const MAX_DEFENDERS = 4;
// One repairer from eight bots, a second from twelve. Repairs are "rarely worthwhile" per
// the Wiki, so the team never spends more than two bots on them.
const REPAIRER_THRESHOLDS = [8, 12];
const REPAIR_LOGS = 12;

// Cadences (milliseconds): how often a bot re-asks the pather, re-clicks an object, and how
// long it may show no progress before it is declared stuck and takes a detour.
const WALK_RETRY_MS = 600;
const OBJECT_CLICK_COOLDOWN_MS = 1200;
const STUCK_TIMEOUT_MS = 8000;

// A bot eats from its kit below this share of its hitpoints, at most once per EAT_COOLDOWN_MS
// (food's own three-tick delay still applies).
const EAT_HP_RATIO = 0.5;
const EAT_COOLDOWN_MS = 1800;

// Engagement ranges (tiles).
const ATTACKER_ENGAGE_RANGE = 6;
const SPINNER_ENGAGE_RANGE = 10;
const DEFENDER_ENGAGE_RANGE = 6;
const DEFENDER_LEASH = 12;
const REPAIRER_ENGAGE_RANGE = 8;
// A gate is closed behind a bot only when no other player is this close to it.
const GATE_CLEAR_RADIUS = 2;
const GATE_LEAVE_RADIUS = 4;
// How long the last bot out waits at a gate for its close click to take.
const GATE_CLOSE_PATIENCE_MS = 4000;
// Option slots the gates and barricades use when the cache names are not found.
const OPEN_OPTION = 1;
const REPAIR_OPTION = 3;

// The inner fort. Its west (x 2643), east (x 2670) and south (y 2585) walls hold the three
// gates; the landing stage and the Void Knight are inside, the barricades and portals outside.
const FORT_BOUNDS = new Boundary(2643, 2670, 2585, 2624, 0);
const GATES = Object.freeze({
  west: { inside: [2644, 2592], outside: [2642, 2592], away: [-1, 0] },
  east: { inside: [2669, 2592], outside: [2671, 2592], away: [1, 0] },
  south: { inside: [2656, 2586], outside: [2656, 2584], away: [0, -1] },
});
const GATE_ORDER = ["west", "south", "east"];
// The gate nearest each portal.
const PORTAL_GATES = Object.freeze({ purple: "west", blue: "east", yellow: "south", red: "south" });
// Where a squad waits for its portal's shield to drop, spread around the portal's spawn tile.
const STAGING_OFFSETS = [
  [-2, -2], [2, -2], [-2, 2], [2, 2], [0, -3], [0, 3], [-3, 0], [3, 0],
  [-3, -3], [3, -3], [-3, 3], [3, 3], [-1, -3], [1, 3],
];
// Defenders' posts around the knight's tile.
const KNIGHT_POST_OFFSETS = [
  [-2, 1], [-1, 1], [0, 1], [1, 1], [2, 1],
  [-2, 0], [-1, 0], [1, 0], [2, 0],
  [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1],
];
// Repairers wait a few tiles out from their gate, spread along the wall, clear of the gateway
// so passing bots still count it as free to close.
const REPAIRER_POST_DISTANCE = 3;
const REPAIRER_POST_LATERALS = [0, 2, -2, 4, -4];

// --- Pure helpers ------------------------------------------------------------------------

function chebyshev(location, x, y) {
  return Math.max(Math.abs(location.getX() - x), Math.abs(location.getY() - y));
}

function tileKey(location) {
  return `${location.getX()},${location.getY()},${location.getZ()}`;
}

function insideFort(location) {
  return FORT_BOUNDS.inside(location);
}

/**
 * Roles for `count` bots: a handful of defenders, up to two repairers once the team is big
 * enough, and attackers dealt round-robin into the four squads. A lone bot attacks.
 */
function assignRoles(count) {
  const roles = [];
  if (count <= 0) return roles;
  const defenders = count >= 2
    ? Math.min(MAX_DEFENDERS, Math.max(MIN_DEFENDERS, Math.ceil(count * DEFENDER_SHARE)))
    : 0;
  const repairers = REPAIRER_THRESHOLDS.filter((threshold) => count >= threshold).length;
  const attackers = count - defenders - repairers;
  for (let index = 0; index < defenders; index++) {
    roles.push({ role: ROLES.DEFENDER, squad: null, post: index });
  }
  for (let index = 0; index < attackers; index++) {
    roles.push({ role: ROLES.ATTACKER, squad: index % SQUADS, post: Math.floor(index / SQUADS) });
  }
  for (let index = 0; index < repairers; index++) {
    roles.push({ role: ROLES.REPAIRER, squad: index % SQUADS, post: index });
  }
  return roles;
}

/**
 * Bots in the order assignRoles deals them out: the defender posts go first, so bots that
 * fight at range take them. A melee defender cannot reach the torchers and defilers that
 * shoot the knight from beyond the wall (chooseDefenderTarget). The sort is stable.
 */
function orderForRoles(bots) {
  return [...bots].sort((a, b) => Number(reachesOverWalls(b)) - Number(reachesOverWalls(a)));
}

/** The squad's portal: its own in the shield order while alive, else the live ones shared out. */
function squadPortal(portals, shieldOrder, squad) {
  const alive = shieldOrder.map((key) => portals.get(key)).filter((portal) => portal && !portal.dead);
  if (alive.length === 0) return null;
  return alive[squad % alive.length];
}

function livePest(npc, area) {
  return Boolean(npc?.__pcType)
    && npc.getHitpoints() > 0
    && npc.isRegistered?.() !== false
    && npc.getPrivateArea?.() === area;
}

function nearestOf(location, candidates, maxDistance) {
  let best = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const at = candidate.getLocation();
    const distance = chebyshev(location, at.getX(), at.getY());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The pests hitting the knight right now (his attacker, or anything with a hit queued on
 * him), one at random so a whole squad does not pile onto the same shifter.
 */
function chooseDefenceTarget(knight, npcs, random = Math.random) {
  const combat = knight.getCombat();
  const attacker = combat.getAttacker?.();
  const hitQueue = combat.getHitQueue();
  const engaged = [];
  for (const npc of npcs) {
    if (!npc.__pcType
      || npc.getHitpoints() <= 0
      || npc.isRegistered?.() === false
      || npc.getPrivateArea?.() !== knight.getPrivateArea?.()
      || npc.getCombat?.().getTarget?.() !== knight
      || (npc !== attacker && !hitQueue.hasPendingHitFrom(npc))) continue;
    engaged.push(npc);
  }
  return engaged[Math.floor(random() * engaged.length)] ?? null;
}

/**
 * A defender's target: a pest already hitting the knight, else the nearest pest inside the
 * fort within DEFENDER_ENGAGE_RANGE of him. Only pests qualify (`__pcType`), so the knight,
 * the squire, portals and other players are never chosen. `canReach` drops pests the
 * defender cannot get at: a melee defender ignores a torcher shooting the knight from outside
 * the wall (it would stand at the wall for the rest of the match), a ranger or mage takes it.
 */
function chooseDefenderTarget(knight, npcs, random = Math.random, canReach = () => true) {
  const reachable = [...npcs].filter(canReach);
  const engaged = chooseDefenceTarget(knight, reachable, random);
  if (engaged) return engaged;
  const area = knight.getPrivateArea?.();
  const approaching = reachable.filter((npc) => livePest(npc, area) && insideFort(npc.getLocation()));
  return nearestOf(knight.getLocation(), approaching, DEFENDER_ENGAGE_RANGE);
}

/** A melee fighter cannot hit across the fort wall; rangers and mages can. */
function reachesOverWalls(player) {
  const type = CombatFactory.getMethod(player)?.type?.();
  return type === CombatType.RANGED || type === CombatType.MAGIC;
}

/**
 * An attacker's target, outside the fort only (inside, it heads for the gate and leaves the
 * knight's pests to the defenders): a spinner healing the squad's portal, then the portal
 * itself once its shield is down, then the nearest pest within `engageRange`, then whatever
 * pest is hitting the bot from farther off (a torcher's spell reaches ten tiles; dropping
 * the retaliation every tick would leave the bot standing there being burnt). A repairer
 * passes no portal and only picks up the last two of these.
 */
function chooseAttackTarget(player, portal, npcs, area, engageRange = ATTACKER_ENGAGE_RANGE) {
  const location = player.getLocation();
  if (insideFort(location)) return null;
  const pests = [...npcs].filter((npc) => livePest(npc, area) && !insideFort(npc.getLocation()));
  if (portal && !portal.dead) {
    const spinner = nearestOf(
      location,
      pests.filter((npc) => npc.__pcType === "spinner" && npc.__pcPortal === portal.key),
      SPINNER_ENGAGE_RANGE
    );
    if (spinner) return spinner;
    if (!portal.shielded && portal.npc.getHitpoints() > 0) return portal.npc;
  }
  const nearby = nearestOf(location, pests, engageRange);
  if (nearby) return nearby;
  const attacker = player.getCombat?.()?.getAttacker?.();
  return attacker && pests.includes(attacker) ? attacker : null;
}

/** 1-based index of `action` in an object's option list, or `fallback` when the cache lacks it. */
function optionIndex(object, action, fallback) {
  const options = object.getDefinition?.()?.getInteractions?.() ?? [];
  const index = options.findIndex((option) => String(option ?? "").toLowerCase() === action);
  return index >= 0 ? index + 1 : fallback;
}

/**
 * The nearest damaged structure a bot can get to: a gate (mended from either side) or a
 * barricade on its own side of the wall.
 */
function nearestDamagedStructure(location, structures) {
  const inside = insideFort(location);
  const candidates = [];
  for (const state of structures.values()) {
    if (state.damage <= 0) continue;
    const at = state.baseLocation;
    if (state.kind !== "gate" && insideFort(at) !== inside) continue;
    candidates.push({ state, getLocation: () => at });
  }
  return nearestOf(location, candidates, Number.MAX_SAFE_INTEGER)?.state ?? null;
}

function gateParts(structures, name) {
  return [...structures.values()].filter((state) => state.kind === "gate" && state.group === name);
}

/** A gate blocks the way while any leaf stands closed and unbroken; a wrecked gate is passable. */
function gateClosed(parts) {
  return parts.length > 0 && parts.some((part) => !part.open && part.damage < part.maxDamage);
}

function gateOpen(parts) {
  return parts.length > 0 && parts.every((part) => part.open || part.damage >= part.maxDamage)
    && parts.some((part) => part.open && part.damage < part.maxDamage);
}

/** The gate a bot takes on its way out: the portal's nearest gate, rotated by its detours. */
function gateFor(portalKey, detours = 0) {
  const base = GATE_ORDER.indexOf(PORTAL_GATES[portalKey] ?? GATE_ORDER[0]);
  return GATE_ORDER[(Math.max(0, base) + detours) % GATE_ORDER.length];
}

/** A repairer's waiting tile: out from the gate along its `away` vector, spread along the wall. */
function repairerPost(gateName, index) {
  const gate = GATES[gateName];
  const lateral = REPAIRER_POST_LATERALS[index % REPAIRER_POST_LATERALS.length];
  const [awayX, awayY] = gate.away;
  return [
    gate.outside[0] + awayX * REPAIRER_POST_DISTANCE + awayY * lateral,
    gate.outside[1] + awayY * REPAIRER_POST_DISTANCE + awayX * lateral,
  ];
}

/** Walk progress bookkeeping: true when the bot has stood still long enough to be stuck. */
function trackProgress(state, location, destinationKey, nowMs, moving) {
  const tile = tileKey(location);
  if (state.destinationKey !== destinationKey) {
    state.destinationKey = destinationKey;
    state.lastTile = tile;
    state.lastMovedAt = nowMs;
    return false;
  }
  if (tile !== state.lastTile) {
    state.lastTile = tile;
    state.lastMovedAt = nowMs;
    return false;
  }
  if (!moving && nowMs - state.lastMovedAt > STUCK_TIMEOUT_MS) {
    state.lastMovedAt = nowMs;
    return true;
  }
  return false;
}

// --- The bot -----------------------------------------------------------------------------

class PestControlBot {
  constructor(match, api, player, assignment) {
    this.match = match;
    this.api = api;
    this.player = player;
    this.state = {
      role: assignment.role,
      squad: assignment.squad,
      post: assignment.post,
      detours: 0,
      nextWalkAt: 0,
      nextClickAt: 0,
      destinationKey: null,
      lastTile: null,
      lastMovedAt: 0,
      gateToClose: null,
      closeGateUntil: null,
    };
    const [x, y] = match.knightLocation();
    this.controller = new BotController(player, x, y, 0, this.tree(assignment.role));
  }

  tick(nowMs) {
    this.eat(nowMs);
    return this.controller.tick(nowMs);
  }

  /** Eat the kit's food when hurt, as a player would; the Food plugin applies its rules. */
  eat(nowMs) {
    const { player, state, api } = this;
    const core = api?.core;
    if (!core?.ItemActionPacketListener || nowMs < (state.nextEatAt ?? 0)) return false;
    const hitpoints = player.getHitpoints();
    const max = player.getSkillManager().getMaxLevel(core.Skill.HITPOINTS);
    if (hitpoints <= 0 || hitpoints >= max * EAT_HP_RATIO) return false;
    const items = player.getInventory().getItems();
    const slot = items.findIndex((item) => isFoodItem(item?.getId?.()));
    if (slot < 0) return false;
    state.nextEatAt = nowMs + EAT_COOLDOWN_MS;
    core.ItemActionPacketListener.handleAction(player, core.Inventory.INTERFACE_ID, items[slot].getId(), slot, 1);
    return true;
  }

  tree(role) {
    if (role === ROLES.DEFENDER) {
      return new SelectorNode([
        new ActionNode((ctx) => this.defend(ctx)),
        new ActionNode((ctx) => this.holdPost(ctx)),
      ]);
    }
    if (role === ROLES.REPAIRER) {
      return new SelectorNode([
        new ActionNode((ctx) => this.repair(ctx)),
        new ActionNode((ctx) => this.fight(ctx, null, REPAIRER_ENGAGE_RANGE)),
        new ActionNode((ctx) => this.goOut(ctx, this.repairerPost())),
      ]);
    }
    return new SelectorNode([
      new ActionNode((ctx) => this.fight(ctx, this.portal(), ATTACKER_ENGAGE_RANGE)),
      new ActionNode((ctx) => this.goOut(ctx, this.stagingTile())),
    ]);
  }

  /** false when the bot cannot act this tick (dead, or no longer on the island). */
  active() {
    const { player, match } = this;
    if (player.getHitpoints() <= 0 || player.getPrivateArea?.() !== match.area) {
      // A death respawns at the landing stage: start the walk out afresh.
      this.state.destinationKey = null;
      this.state.gateToClose = null;
      this.state.closeGateUntil = null;
      return false;
    }
    return true;
  }

  portal() {
    return squadPortal(this.match.portals, this.match.shieldOrder, this.state.squad ?? 0);
  }

  // --- Walking -----------------------------------------------------------------------------

  /** Ask the pather for a route at most every WALK_RETRY_MS; "stuck" after STUCK_TIMEOUT_MS still. */
  walkTowards(ctx, x, y) {
    const { player, state } = this;
    // A teleport (the landing, a respawn) drops any route queued before it lands.
    if (player.isNeedsPlacement?.() === true) return "running";
    const movement = player.getMovementQueue();
    const moving = movement.size() > 0;
    if (trackProgress(state, player.getLocation(), `${x},${y}`, ctx.nowMs, moving)) {
      state.detours += 1;
      return "stuck";
    }
    if (!moving && ctx.nowMs >= state.nextWalkAt) {
      PathFinder.calculateWalkRoute(player, x, y);
      state.nextWalkAt = ctx.nowMs + WALK_RETRY_MS;
    }
    return "running";
  }

  clickStructure(ctx, structure, clickType) {
    const { player, state } = this;
    if (ctx.nowMs < state.nextClickAt) return;
    state.nextClickAt = ctx.nowMs + OBJECT_CLICK_COOLDOWN_MS;
    const object = structure.object;
    const at = object.getLocation();
    const from = player.getLocation();
    this.api.emitObjectInteraction({
      player,
      object,
      objectId: object.getId(),
      clickType,
      location: { x: at.getX(), y: at.getY(), z: at.getZ() },
      sourceLocation: { x: from.getX(), y: from.getY(), z: from.getZ() },
      handled: false,
    });
  }

  nearestGatePart(parts) {
    const location = this.player.getLocation();
    return nearestOf(location, parts.map((part) => ({ part, getLocation: () => part.baseLocation })), 1)?.part ?? null;
  }

  /**
   * Leave the fort through the squad's gate, then walk to `destination` ([x, y]) outside.
   * A closed gate is opened from its inside tile; the gate is closed again from outside when
   * nobody else is about to pass. A stuck walk rotates to another gate / staging tile.
   */
  goOut(ctx, destination) {
    if (!this.active()) return "failure";
    const { player, state } = this;
    const location = player.getLocation();
    const portal = this.portal();
    const gateName = gateFor(portal?.key, state.detours);
    const parts = gateParts(this.match.structures, gateName);
    if (insideFort(location)) {
      const gate = GATES[gateName];
      if (gateClosed(parts)) {
        const part = this.nearestGatePart(parts);
        if (part) {
          this.clickStructure(ctx, part, optionIndex(part.object, "open", OPEN_OPTION));
          state.gateToClose = gateName;
          return "running";
        }
        return this.walkTowards(ctx, gate.inside[0], gate.inside[1]);
      }
      state.gateToClose = gateName;
      return this.walkTowards(ctx, destination[0], destination[1]);
    }
    if (this.closeGateBehind(ctx)) return "running";
    if (chebyshev(location, destination[0], destination[1]) <= 1) return "running";
    return this.walkTowards(ctx, destination[0], destination[1]);
  }

  /**
   * The last bot out closes the gate behind it. A bot that still has a teammate inside heading
   * for the same gate leaves the job to that teammate; the last one stays at the gate until
   * its click has closed it. Returns true while the bot is holding there to close it.
   */
  closeGateBehind(ctx) {
    const { player, state, match } = this;
    const name = state.gateToClose;
    if (!name) {
      state.closeGateUntil = null;
      return false;
    }
    const gate = GATES[name];
    const parts = gateParts(match.structures, name);
    const location = player.getLocation();
    const nearGate = Math.min(
      chebyshev(location, gate.inside[0], gate.inside[1]),
      chebyshev(location, gate.outside[0], gate.outside[1])
    );
    if (nearGate > GATE_LEAVE_RADIUS || !gateOpen(parts)) {
      state.gateToClose = null;
      return false;
    }
    for (const other of match.bots?.values?.() ?? []) {
      if (other !== this && other.exitGate() === name) {
        state.gateToClose = null;
        return false;
      }
    }
    // Anyone else just inside the gateway is about to pass: let them through. Those already
    // outside are through; one who wants back in opens it again.
    for (const other of match.players.keys()) {
      if (other === player || other.getHitpoints() <= 0) continue;
      const at = other.getLocation();
      if (insideFort(at) && chebyshev(at, gate.inside[0], gate.inside[1]) <= GATE_CLEAR_RADIUS) return false;
    }
    // Holding is bounded: a gate that will not close (a click that never lands) is left open.
    state.closeGateUntil ??= ctx.nowMs + GATE_CLOSE_PATIENCE_MS;
    if (ctx.nowMs > state.closeGateUntil) {
      state.gateToClose = null;
      return false;
    }
    const part = this.nearestGatePart(parts);
    if (!part) {
      this.walkTowards(ctx, gate.outside[0], gate.outside[1]);
      return true;
    }
    // Stop here: steps already queued towards the portal would carry the bot past the gate.
    player.getMovementQueue().reset();
    this.clickStructure(ctx, part, optionIndex(part.object, "close", OPEN_OPTION));
    return true;
  }

  /** The gate this bot is on its way out through, or null (outside, a defender, or dead). */
  exitGate() {
    const { player, state, match } = this;
    if (state.role === ROLES.DEFENDER || player.getHitpoints() <= 0
      || player.getPrivateArea?.() !== match.area || !insideFort(player.getLocation())) return null;
    return gateFor(this.portal()?.key, state.detours);
  }

  stagingTile() {
    const portal = this.portal();
    const spawn = portal ? [portal.spawnX, portal.spawnY] : this.match.knightLocation();
    const [dx, dy] = STAGING_OFFSETS[(this.state.post + this.state.detours) % STAGING_OFFSETS.length];
    return [spawn[0] + dx, spawn[1] + dy];
  }

  repairerPost() {
    return repairerPost(gateFor(this.portal()?.key, this.state.detours), this.state.post + this.state.detours);
  }

  // --- Fighting ----------------------------------------------------------------------------

  attack(target) {
    const { player } = this;
    const combat = player.getCombat();
    if (combat.getTarget?.() === target) return "running";
    const permission = CombatFactory.canAttackPermission(player, target, false, CombatFactory.getMethod(player));
    if (permission !== CanAttackResponse.CAN_ATTACK) return "failure";
    combat.attack(target);
    return "running";
  }

  /** Drop a match target that no longer qualifies, so the bot can walk on. */
  disengage() {
    const combat = this.player.getCombat();
    const current = combat.getTarget?.();
    if (current && (current.__pcType || this.match.portalByNpc.has(current))) combat.reset();
    return "failure";
  }

  fight(ctx, portal, engageRange) {
    if (!this.active()) return "failure";
    const { player, match } = this;
    const target = chooseAttackTarget(player, portal, match.npcs, match.area, engageRange);
    if (!target) return this.disengage();
    const result = this.attack(target);
    return result === "failure" ? this.disengage() : result;
  }

  defend(ctx) {
    if (!this.active()) return "failure";
    const { player, match } = this;
    const knight = match.knight;
    const combat = player.getCombat();
    const current = combat.getTarget?.();
    const knightAt = knight.getLocation();
    const nearKnight = (npc, range) => chebyshev(npc.getLocation(), knightAt.getX(), knightAt.getY()) <= range;
    const overWalls = reachesOverWalls(player);
    const canReach = (npc) => overWalls || insideFort(npc.getLocation());
    // Keep the current fight while it is still worth having: the pest is alive, reachable,
    // and either hitting the knight or close to him. Switching every tick would never land a hit.
    if (current && livePest(current, match.area) && canReach(current) && nearKnight(current, DEFENDER_LEASH)
      && (chooseDefenceTarget(knight, [current]) || nearKnight(current, DEFENDER_ENGAGE_RANGE))) {
      return "running";
    }
    const target = chooseDefenderTarget(knight, match.npcs, Math.random, canReach);
    if (!target || !nearKnight(target, DEFENDER_LEASH)) return this.disengage();
    const result = this.attack(target);
    return result === "failure" ? this.disengage() : result;
  }

  holdPost(ctx) {
    if (!this.active()) return "failure";
    const { player } = this;
    const post = this.match.knightLocation();
    const [dx, dy] = KNIGHT_POST_OFFSETS[this.state.post % KNIGHT_POST_OFFSETS.length];
    const x = post[0] + dx;
    const y = post[1] + dy;
    if (chebyshev(player.getLocation(), x, y) <= 1) return "running";
    return this.walkTowards(ctx, x, y);
  }

  // --- Repairing ---------------------------------------------------------------------------

  canRepair() {
    const inventory = this.player.getInventory();
    return inventory.contains(ItemIdentifiers.HAMMER) && inventory.contains(ItemIdentifiers.LOGS);
  }

  repair(ctx) {
    if (!this.active() || !this.canRepair()) return "failure";
    const { player, match } = this;
    const location = player.getLocation();
    const structure = nearestDamagedStructure(location, match.structures);
    if (!structure) return "failure";
    const at = structure.baseLocation;
    if (chebyshev(location, at.getX(), at.getY()) <= 1) {
      if (player.getCombat().getTarget?.()) player.getCombat().reset();
      this.clickStructure(ctx, structure, optionIndex(structure.object, "repair", REPAIR_OPTION));
      return "running";
    }
    const result = this.walkTowards(ctx, at.getX(), at.getY());
    return result === "stuck" ? "failure" : result;
  }
}

/** A hammer and as many logs as the bot has room for, so a repairer can mend the walls. */
function equipRepairer(player) {
  const inventory = player.getInventory();
  if (!inventory.contains(ItemIdentifiers.HAMMER) && inventory.getFreeSlots() > 0) {
    inventory.adds(ItemIdentifiers.HAMMER, 1);
  }
  const logs = Math.min(REPAIR_LOGS, inventory.getFreeSlots());
  if (logs > 0) inventory.adds(ItemIdentifiers.LOGS, logs);
  return logs;
}

/** The shared tier helpers read combat levels through api.core. */
function initBots(api) {
  initPvpTierLoadouts(api);
}

/**
 * The tier choice for a lander bot: a members kit whose combat level is inside the boat's
 * `botLevels`, under the boat's PvP behaviour profile. `index` spreads bots across the pool.
 */
function boatTierChoice(boat, index) {
  return pickTierChoice(boat.key, { index, band: boat.botLevels, excludeF2p: true });
}

/**
 * Stats and gear for a bot boarding `boat`, pinned to its level band (Castle Wars and Bounty
 * Hunter crew their tiers the same way). Falls back to a roaming kit only if the band has no
 * kit at all, which the tests rule out for every boat.
 */
function equipForBoat(player, boat, index, api) {
  const choice = boatTierChoice(boat, index);
  const config = choice
    ? {
        pvp: {
          loadoutWeights: [{ value: choice.loadoutId, weight: 1 }],
          profileWeights: [{ value: TIER_PROFILE_IDS[boat.key], weight: 1 }],
        },
      }
    : {};
  return applyGeneratedPvpLoadout(
    player,
    {
      pvp: {
        ...buildRoamingPvpMetadata({ excludeF2p: true, config }),
        ...(choice ? { combatLevelRange: boat.botLevels, generatedArchetypeId: choice.archetypeId } : {}),
      },
    },
    { api }
  );
}

/** One bot's brain; `match` supplies knight, portals, structures, npcs and players. */
function createBot(match, api, player, assignment) {
  player.setAttribute(BOT_ROLE_ATTRIBUTE, assignment.role);
  player.setAttribute(BOT_SQUAD_ATTRIBUTE, assignment.squad);
  return new PestControlBot(match, api, player, assignment);
}

module.exports = {
  ROLES,
  BOT_ROLE_ATTRIBUTE,
  BOT_SQUAD_ATTRIBUTE,
  assignRoles,
  orderForRoles,
  chooseDefenceTarget,
  equipRepairer,
  equipForBoat,
  initBots,
  createBot,
  _test: {
    FORT_BOUNDS,
    GATES,
    PORTAL_GATES,
    STUCK_TIMEOUT_MS,
    REPAIR_LOGS,
    EAT_HP_RATIO,
    PestControlBot,
    boatTierChoice,
    insideFort,
    squadPortal,
    chooseDefenderTarget,
    reachesOverWalls,
    chooseAttackTarget,
    nearestDamagedStructure,
    gateFor,
    gateClosed,
    gateOpen,
    gateParts,
    repairerPost,
    optionIndex,
    trackProgress,
  },
};
