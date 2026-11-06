"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { requestMovement } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { ItemOnGroundManager } = require("../../../../src/main/typescript/elvarg/game/entity/impl/grounditem/ItemOnGroundManager");

/**
 * Hunts with laid traps as a player does (bird snares, box traps): keeps as many laid near where it
 * started as its Hunter level allows, each on a free tile; a catch is Checked, a failed trap
 * Dismantled, a fallen one (lying on the floor) picked up, and the catch's leftovers (`junk`:
 * bones, raw meat) dropped as the pack fills. The Hunter plugin does the laying, luring, rolls and
 * XP. Runs until the task's time is up; fails when it has no trap to lay and none out.
 *
 * Spec: { item: trapItemId, kind: "bird" | "box", junk: [itemIds] }
 */
const CLICK_MS = 1800;
const SPREAD_TILES = 3;
const PICKUP_TILES = 12;

const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));

function createHuntTrapsAction(spec, world) {
  const { core } = world;
  const { item, kind, junk = [] } = spec;
  // The plugin's live traps (Context.Hunter's H.traps): { player, kind, state, objects, location }.
  const H = () => require("../../../skills/hunter/Context.Hunter").H;
  const stateFor = (player) => playerState(action, player, () => ({ clickedAt: 0, centre: null, misses: 0 }));

  function limit(player) {
    const level = player.getSkillManager().getMaxLevel(core.Skill.HUNTER);
    return Math.min(5, 1 + Math.floor(level / 20));
  }

  function clickObject(player, object, option) {
    const definition = core.ObjectDefinition?.forId?.(object.getId());
    const clickType = (definition?.getActions?.() ?? definition?.getInteractions?.() ?? []).indexOf(option) + 1;
    if (clickType <= 0) return false;
    const at = object.getLocation();
    player.getMovementQueue().walkToObject(object, {
      execute: () => world.emitObjectInteraction?.({
        player, object, objectId: object.getId(), clickType, definition,
        location: { x: at.getX(), y: at.getY(), z: at.getZ() },
        sourceLocation: { x: player.getLocation().getX(), y: player.getLocation().getY(), z: player.getLocation().getZ() },
        handled: false,
      }),
    }, clickType);
    return true;
  }

  function lay(player) {
    const slot = player.getInventory().getItems().findIndex((entry) => entry?.getId?.() === item);
    if (slot < 0) return false;
    const options = core.CacheDefinitions?.getItem?.(item)?.inventoryActions ?? [];
    const clickType = options.indexOf("Lay") + 1;
    if (clickType <= 0) return false;
    core.ItemActionPacketListener.handleAction(player, core.Inventory.INTERFACE_ID, item, slot, clickType, "Lay");
    return true;
  }

  /** A tile near the centre a trap can go on: walkable, empty, no trap on it. */
  function freeTile(player, centre, traps) {
    const z = centre.getZ();
    const area = player.getPrivateArea?.() ?? null;
    // Not on a trap, nor where a creature stands (it would block the one lured onto it).
    const occupied = new Set((core.World.getNpcsNear?.(centre, SPREAD_TILES + 2, null) ?? [])
      .map((npc) => `${npc.getLocation().getX()},${npc.getLocation().getY()}`));
    const taken = (x, y) => occupied.has(`${x},${y}`) || traps.some((trap) => trap.location.getX() === x && trap.location.getY() === y);
    const tiles = [];
    for (let dx = -SPREAD_TILES; dx <= SPREAD_TILES; dx++) {
      for (let dy = -SPREAD_TILES; dy <= SPREAD_TILES; dy++) {
        const x = centre.getX() + dx;
        const y = centre.getY() + dy;
        if (taken(x, y)) continue;
        const at = new core.Location(x, y, z);
        if (core.MapObjects.getType(at, 10, area) || core.MapObjects.getType(at, 22, area) || core.RegionManager.blocked(at, area)) continue;
        tiles.push(at);
      }
    }
    const here = player.getLocation();
    return tiles.sort((a, b) => chebyshev(a, here) - chebyshev(b, here))[0] ?? null;
  }

  const action = {
    id: "huntTraps",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      bot.centre ??= player.getLocation().clone();
      if (player.getMovementQueue().size() > 0) return "running";
      if (nowMs - bot.clickedAt < CLICK_MS) return "running";
      const inventory = player.getInventory();
      // The catches' leftovers go before the pack is full (the plugin won't hand over a catch then).
      if (inventory.getFreeSlots() <= 2) {
        for (const id of junk) if (inventory.getAmount(id) > 0) inventory.deleteNumber(id, inventory.getAmount(id));
      }
      const traps = [...(H()?.traps ?? [])].filter((trap) => trap.player === player && trap.kind === kind);
      const here = player.getLocation();
      // Caught first, then failed, nearest of each.
      const near = (list) => list.sort((a, b) => chebyshev(a.location, here) - chebyshev(b.location, here))[0];
      const caught = near(traps.filter((trap) => trap.state === "caught"));
      const failed = near(traps.filter((trap) => trap.state === "failed"));
      const target = caught ?? failed;
      if (target?.objects?.length) {
        bot.clickedAt = nowMs;
        clickObject(player, target.objects.at(-1), caught ? "Check" : "Dismantle");
        return "running";
      }
      // A trap that fell over lies on the floor: picked up.
      const fallen = ItemOnGroundManager.ownedBy(player.getUsername())
        .filter((ground) => ground.getItem().getId() === item && ground.getPosition().getZ() === here.getZ()
          && chebyshev(ground.getPosition(), here) <= PICKUP_TILES)
        .sort((a, b) => chebyshev(a.getPosition(), here) - chebyshev(b.getPosition(), here))[0];
      if (fallen && inventory.getFreeSlots() > 0) {
        bot.clickedAt = nowMs;
        if (fallen.getPosition().getX() === here.getX() && fallen.getPosition().getY() === here.getY()) ItemOnGroundManager.pickup(player, fallen);
        else player.getMovementQueue().walkToGroundItem(fallen.getPosition(), () => ItemOnGroundManager.pickup(player, fallen));
        return "running";
      }
      if (traps.length < limit(player) && inventory.getAmount(item) > 0) {
        const tile = freeTile(player, bot.centre, traps);
        if (!tile) return "running";
        bot.clickedAt = nowMs;
        if (tile.getX() === here.getX() && tile.getY() === here.getY()) {
          lay(player);
        } else {
          requestMovement(player, tile.getX(), tile.getY(), { nowMs, z: tile.getZ(), reason: "brain_hunter_trap" });
          bot.clickedAt = nowMs - CLICK_MS + 600;
        }
        return "running";
      }
      if (traps.length === 0 && inventory.getAmount(item) === 0 && !fallen) {
        return ++bot.misses > 10 ? "failed" : "running";
      }
      bot.misses = 0;
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.clickedAt = 0;
      bot.centre = null;
      bot.misses = 0;
    },
    madeProgress() {
      return true;
    },
    describe() {
      return `hunting (${kind} traps)`;
    },
  };
  return action;
}

module.exports = { createHuntTrapsAction };
