"use strict";

const { MapObjects } = require("../../../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects");
const { Bank } = require("../../../../src/main/typescript/elvarg/game/model/container/impl/Bank");
const { ItemDefinition } = require("../../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
const { BANK_BOOTH_IDS, isUsableBankBooth } = require("../../lib/BankBooths.PlayerBots");
const { playerState } = require("../ActionState.PlayerBots");
const { createObjectReachChecker } = require("../../behaviours/navigation/ObjectReach.PlayerBots");
const {
  approachBlockedObject,
  approachObject,
  requestMovement,
} = require("../../behaviours/navigation/Navigation.PlayerBots");

const BANK_SEARCH_REGION_RADIUS = 2;
const MAX_DIRECT_ROUTE_TILES = 20;
const INTERACT_COOLDOWN_MS = 1500;
const DEPOSIT_DELAY_MS = 600;
// Same unreachable-target guard as InteractObject: a booth whose route keeps
// failing is avoided for a while so another booth gets picked.
const UNREACHABLE_CLICKS = 2;
const UNREACHABLE_AVOID_MS = 60000;
// A walk to a bank that leaves the bot standing this long: that bot alone uses
// another bank for a while (not shared: a stuck walk says nothing about the bank).
const APPROACH_STUCK_MS = 20000;
const SKIP_BANK_MS = 10 * 60 * 1000;
const bankArea = (x, y, z) => `${x >> 5},${y >> 5},${z}`;
// Booths upstairs (Lumbridge castle's top floor) count as this many tiles further
// per floor: the bot climbs to them (brain/Climbing) when they are still nearest.
const FLOOR_PENALTY_TILES = 15;
const MAX_PLANE = 3;
const NO_BOOTH_TICKS = 10;

/**
 * Deposits the inventory at the nearest usable bank booth, then reports success.
 * Segmented approach and the interact cooldown mirror the woodcutting action:
 * re-issuing walkToObject every tick cancels the arrival callback.
 */
function createBankAction(spec, world) {
  const withdrawSpecs = Array.isArray(spec.withdraw) ? spec.withdraw : [];
  const isWithdraw = withdrawSpecs.length > 0;
  // `itemIds` banks only those items (an activity's end products); otherwise everything.
  const depositIds = Array.isArray(spec.itemIds) && spec.itemIds.length ? new Set(spec.itemIds) : null;
  const requireFull = !isWithdraw && !depositIds && spec.until?.inventoryFull !== false;
  const canReach = createObjectReachChecker(world.core);
  const stateFor = (player) =>
    playerState(action, player, () => ({
      booth: null,
      lastClickAt: 0,
      depositAt: 0,
      suppressedAutoRetaliate: null,
      lastTargetKey: null,
      lastClickX: null,
      lastClickY: null,
      failedClicks: 0,
      noBooth: 0,
      avoid: new Map(),
      skipAreas: new Map(),
    }));

  // Already holding some of every input (ores mined on the way): use those first
  // instead of a bank trip; the bank tops up once they run out.
  // `noted: true` takes an entry out as banknotes (Phials unnotes them).
  const heldId = (entry) => (entry.noted ? ItemDefinition.forId(entry.item)?.getNoteId?.() ?? entry.item : entry.item);

  // `topUp: true`: some already held isn't enough; it takes the inventory back up to each
  // entry's amount (or full), as after essence went into the pouches.
  const topUp = spec.topUp === true;
  function withdrawSatisfied(player) {
    const inventory = player.getInventory();
    if (topUp) return inventory.isFull() || withdrawSpecs.every((entry) => inventory.getAmount(heldId(entry)) >= entry.amount);
    return withdrawSpecs.every((entry) => inventory.getAmount(heldId(entry)) > 0);
  }

  function performWithdraw(player) {
    const inventory = player.getInventory();
    const noting = player.withdrawAsNote?.() === true;
    for (const entry of withdrawSpecs) {
      player.setNoteWithdrawal?.(entry.noted === true);
      let remaining = entry.amount - inventory.getAmount(heldId(entry));
      let guard = 0;
      while (remaining > 0 && guard++ < 40) {
        let withdrew = false;
        for (let tab = 0; tab < Bank.TOTAL_BANK_TABS - 1; tab++) {
          const bank = player.getBank(tab);
          if (!bank) {
            continue;
          }
          const slot = bank.getSlotForItemId?.(entry.item) ?? -1;
          if (slot < 0) {
            continue;
          }
          const stack = bank.getItems()[slot];
          if (!stack || stack.getId() !== entry.item) {
            continue;
          }
          const take = Math.min(remaining, stack.getAmount());
          Bank.withdraw(player, entry.item, slot, take, tab);
          remaining -= take;
          withdrew = true;
          if (remaining <= 0) {
            break;
          }
        }
        if (!withdrew) {
          break;
        }
      }
    }
    player.setNoteWithdrawal?.(noting);
  }

  function findBooth(player, nowMs) {
    const bot = stateFor(player);
    const loc = player.getLocation();
    const candidates = [];
    for (let z = 0; z <= (player.getPrivateArea?.() ? -1 : MAX_PLANE); z++) {
      candidates.push(...(world.objectSearch?.findCandidatesByIds?.(player, [...BANK_BOOTH_IDS], {
        regionRadius: BANK_SEARCH_REGION_RADIUS,
        z,
        privateArea: null,
      }) ?? []));
    }
    if (player.getPrivateArea?.()) {
      candidates.push(...(world.objectSearch?.findCandidatesByIds?.(player, [...BANK_BOOTH_IDS], {
        regionRadius: BANK_SEARCH_REGION_RADIUS, z: loc.getZ(), privateArea: player.getPrivateArea(),
      }) ?? []));
    }
    let best = null;
    let bestDistSq = Number.MAX_SAFE_INTEGER;
    let fallback = null;
    let fallbackDistSq = Number.MAX_SAFE_INTEGER;
    for (const object of candidates) {
      if (!object || !isUsableBankBooth(object.getId())) {
        continue;
      }
      const objectLoc = object.getLocation();
      if (!objectLoc) {
        continue;
      }
      if ((bot.skipAreas.get(bankArea(objectLoc.getX(), objectLoc.getY(), objectLoc.getZ())) ?? 0) > nowMs) {
        continue;
      }
      const dx = objectLoc.getX() - loc.getX();
      const dy = objectLoc.getY() - loc.getY();
      const floors = Math.abs(objectLoc.getZ() - loc.getZ()) * FLOOR_PENALTY_TILES;
      const distSq = dx * dx + dy * dy + floors * floors;
      if (distSq < fallbackDistSq) {
        fallbackDistSq = distSq;
        fallback = object;
      }
      const key = `${object.getId()}:${objectLoc.getX()}:${objectLoc.getY()}`;
      const avoidedUntil = bot.avoid.get(key);
      if (avoidedUntil !== undefined && avoidedUntil > nowMs) {
        continue;
      }
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = object;
      }
    }
    // If every booth is avoided, ignore the list: better a retry than a stall.
    return best ?? fallback;
  }

  function resolveBooth(player) {
    const booth = stateFor(player).booth;
    if (!booth) {
      return null;
    }
    const loc = player.getLocation().clone();
    loc.set(booth.x, booth.y, booth.z);
    return MapObjects.get(booth.objectId, loc, player.getPrivateArea());
  }

  /**
   * A bank upstairs (Lumbridge castle) is left the way the bot came: the step only
   * ends back on the floor it started from, or the next step (trees, rocks, NPCs,
   * all found on the bot's own floor) would search the bank floor forever.
   */
  function update(ctx) {
    const { player, nowMs } = ctx;
    const bot = stateFor(player);
    const loc = player.getLocation();
    bot.origin ??= { x: loc.getX(), y: loc.getY(), z: loc.getZ() };
    if (!bot.outcome) {
      const result = bankStep(ctx);
      if ((result !== "success" && result !== "failed") || loc.getZ() === bot.origin.z) return result;
      bot.outcome = result;
    }
    if (loc.getZ() === bot.origin.z) return bot.outcome;
    requestMovement(player, bot.origin.x, bot.origin.y, { nowMs, z: bot.origin.z, reason: "brain_bank_return", basicPather: true });
    return "running";
  }

  function bankStep(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (
        spec.suppressAutoRetaliate === true &&
        bot.suppressedAutoRetaliate === null
      ) {
        bot.suppressedAutoRetaliate =
          typeof player.autoRetaliateReturn === "function"
            ? player.autoRetaliateReturn()
            : true;
        player.setAutoRetaliate?.(false);
      }
      if (bot.depositAt > 0 && nowMs >= bot.depositAt) {
        if (isWithdraw) {
          performWithdraw(player);
          world.log?.("bot_brain_bank_withdrew", {
            username: player.getUsername?.(),
          });
          bot.depositAt = 0;
          // Inputs come from the bank, never from thin air: nothing of an item in
          // the bank fails the step, so the activity backs off and rotates.
          const inventory = player.getInventory();
          return withdrawSpecs.every((entry) => inventory.getAmount(heldId(entry)) > 0) ? "success" : "failed";
        } else if (depositIds) {
          player.getInventory().getItems().forEach((item, slot) => {
            if (item && depositIds.has(item.getId())) Bank.deposit(player, item.getId(), slot, item.getAmount(), true);
          });
          world.log?.("bot_brain_bank_deposited", {
            username: player.getUsername?.(),
          });
        } else {
          Bank.depositItems(player, player.getInventory(), true);
          world.log?.("bot_brain_bank_deposited", {
            username: player.getUsername?.(),
          });
        }
        bot.depositAt = 0;
        return "success";
      }
      if (isWithdraw && withdrawSatisfied(player)) {
        return "success";
      }
      if (depositIds && !player.getInventory().getItems().some((item) => item && depositIds.has(item.getId()))) {
        return "success";
      }
      if (requireFull && !player.getInventory().isFull()) {
        return "success";
      }

      const object = resolveBooth(player) ?? findBooth(player, nowMs);
      if (!object) {
        // The area's objects can still be loading (a character just placed or logged in): a
        // few ticks without a booth in sight before there's none.
        return ++bot.noBooth > NO_BOOTH_TICKS ? "failed" : "running";
      }
      bot.noBooth = 0;
      bot.booth = {
        objectId: object.getId(),
        x: object.getLocation().getX(),
        y: object.getLocation().getY(),
        z: object.getLocation().getZ(),
      };

      const loc = player.getLocation();
      const distance = Math.max(
        Math.abs(loc.getX() - bot.booth.x),
        Math.abs(loc.getY() - bot.booth.y)
      );
      if (distance > MAX_DIRECT_ROUTE_TILES || bot.booth.z !== loc.getZ()) {
        const here = `${loc.getX()},${loc.getY()}`;
        if (here !== bot.approachAt) {
          bot.approachAt = here;
          bot.approachSince = nowMs;
        } else if (nowMs - bot.approachSince >= APPROACH_STUCK_MS) {
          bot.skipAreas.set(bankArea(bot.booth.x, bot.booth.y, bot.booth.z), nowMs + SKIP_BANK_MS);
          bot.booth = null;
          bot.approachAt = null;
          return "running";
        }
        if (bot.booth.z !== loc.getZ()) {
          // Upstairs/downstairs: a walk on the booth's floor climbs there on the way.
          requestMovement(player, bot.booth.x, bot.booth.y, { nowMs, z: bot.booth.z, reason: "brain_bank_approach", basicPather: true });
        } else {
          approachObject(player, object, { nowMs, reason: "brain_bank_approach" });
        }
        return "running";
      }
      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }
      if (nowMs - bot.lastClickAt < INTERACT_COOLDOWN_MS) {
        return "running";
      }

      const objectLoc = object.getLocation();
      const key = `${object.getId()}:${objectLoc.getX()}:${objectLoc.getY()}`;
      const now = player.getLocation();
      const stayedPut =
        bot.lastClickX === now.getX() && bot.lastClickY === now.getY();
      bot.failedClicks =
        bot.lastTargetKey === key && stayedPut ? bot.failedClicks + 1 : 0;
      if (bot.failedClicks >= UNREACHABLE_CLICKS) {
        bot.avoid.set(key, nowMs + UNREACHABLE_AVOID_MS);
        bot.booth = null;
        bot.lastTargetKey = null;
        bot.failedClicks = 0;
        return "running";
      }
      bot.lastTargetKey = key;
      bot.lastClickX = now.getX();
      bot.lastClickY = now.getY();
      bot.lastClickAt = nowMs;
      if (approachBlockedObject(player, object, { nowMs, reason: "brain_bank_approach", canReach })) {
        return "running";
      }
      player.getMovementQueue().walkToObject(object, {
        execute: () => {
          world.emitObjectInteraction?.({
            player,
            object,
            objectId: object.getId(),
            // "Bank" is not always first (Lumbridge castle's booths list it second).
            clickType: Math.max(0, (object.getDefinition?.()?.getInteractions?.() ?? [])
              .findIndex((option) => /^bank$/i.test(String(option ?? "")))) + 1,
            location: {
              x: objectLoc.getX(),
              y: objectLoc.getY(),
              z: objectLoc.getZ(),
            },
            sourceLocation: {
              x: player.getLocation().getX(),
              y: player.getLocation().getY(),
              z: player.getLocation().getZ(),
            },
            handled: false,
          });
          stateFor(player).depositAt = Date.now() + DEPOSIT_DELAY_MS;
        },
      });
      return "running";
  }

  const action = {
    id: "bank",
    update,
    // Walking to a far bank (up Lumbridge castle and back down) is progress: without it
    // the brain's stall check ended the trip upstairs and stranded the bot there.
    madeProgress(ctx) {
      const bot = stateFor(ctx.player);
      const loc = ctx.player.getLocation();
      const position = `${loc.getX()},${loc.getY()},${loc.getZ()}`;
      const moved = position !== bot.lastPosition;
      bot.lastPosition = position;
      return moved;
    },
    stop(ctx) {
      const player = ctx?.player;
      if (!player) {
        return;
      }
      const bot = stateFor(player);
      bot.origin = null;
      bot.outcome = null;
      bot.booth = null;
      bot.lastClickAt = 0;
      bot.depositAt = 0;
      // A click that opened the bank isn't a failed one: the next trip's first click, often
      // from the same tile, starts the count again (it carried over, and every third trip
      // wrote a working booth off as unreachable).
      bot.lastTargetKey = null;
      bot.lastClickX = null;
      bot.lastClickY = null;
      bot.failedClicks = 0;
      bot.noBooth = 0;
      if (bot.suppressedAutoRetaliate !== null) {
        player.setAutoRetaliate?.(bot.suppressedAutoRetaliate);
        bot.suppressedAutoRetaliate = null;
      }
    },
  };
  return action;
}

module.exports = {
  createBankAction,
};
