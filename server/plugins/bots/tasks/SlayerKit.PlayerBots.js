"use strict";

const { ItemIds } = require("../../../src/main/typescript/elvarg/util/IdEnums");
const Supplies = require("../lib/Supplies.PlayerBots");
const { createObtainAction } = require("../brain/actions/Obtain.PlayerBots");
const GEAR = require("../../skills/data/slayer-gear.json").monsters;
const FINISHERS = require("../../skills/data/slayer-finishers.json").finishers;

/**
 * What a Slayer task needs besides a weapon, from the Slayer plugin's own data: protection worn
 * against its monsters (earmuffs for banshees, a nose peg for aberrant spectres, a facemask for
 * dust devils, a mirror shield for basilisks and cockatrice, a spiny helmet for wall beasts:
 * data/slayer-gear.json), and the item that finishes them (a rock hammer, bags of salt, ice
 * coolers, a fungicide spray: data/slayer-finishers.json). Owned or bought at a Slayer master's
 * shop, as a player would; the protection is worn.
 */
const byName = (name) => ItemIds[String(name).toUpperCase().replace(/'/g, "").replace(/[\s-]+/g, "_")];
// A spare or two beyond the kills for what each kill uses up.
const SPARE = 3;

/** Whether one of a data row's monster names is the task's (the task says "Banshees", the row "Banshee"). */
function forTask(names, task) {
  const shown = String(task?.task?.displayName ?? "").toLowerCase();
  return names.some((name) => shown.includes(String(name).toLowerCase()));
}

/** [{ ids, amount, wear }]: what the task needs carried (and worn). */
function needs(task) {
  if (!task) return [];
  const list = [];
  for (const row of GEAR) {
    if (!forTask(row.names, task)) continue;
    const ids = row.protection.map(byName).filter(Number.isInteger);
    if (ids.length) list.push({ ids, amount: 1, wear: true, name: row.protection[0] });
  }
  for (const row of FINISHERS) {
    if (!forTask(row.names, task)) continue;
    if (row.consumed?.length && !row.items?.length) list.push({ ids: row.consumed, amount: task.count + SPARE, wear: false });
    else list.push({ ids: [...(row.items ?? []), ...(row.sprays ?? [])], amount: 1, wear: false });
  }
  return list;
}

/** The id it has (carried, worn, banked), else one it can buy, else null. */
function pick(player, need) {
  return need.ids.find((id) => Supplies.ownedAmount(player, id) > 0)
    ?? need.ids.find((id) => Supplies.canBuy(id)) ?? null;
}

/** What it can't get for a task (a name for the reason), or null. */
function missing(player, task) {
  const need = needs(task).find((entry) => pick(player, entry) === null);
  return need ? (need.name ?? "its finishing item") : null;
}

/** A finisher for this NPC (by name): { threshold, ids }, or null. */
function finisherFor(npc) {
  const name = (npc?.getCurrentDefinition?.() ?? npc?.getDefinition?.())?.getName?.() ?? "";
  const row = FINISHERS.find((entry) => entry.names.includes(name));
  return row ? { threshold: row.threshold, ids: [...(row.items ?? []), ...(row.consumed ?? []), ...(row.sprays ?? [])] } : null;
}

/**
 * Gets the task's kit (createObtainAction for each piece: the bank, else a shop) and wears its
 * protection. `task(player)` is the current task. Fails when a piece can't be had.
 */
function createSlayerKitAction({ task }, world) {
  const { core } = world;
  let fetching = null;
  return {
    id: "slayerKit",
    update(ctx) {
      const { player } = ctx;
      for (const need of needs(task(player))) {
        const worn = need.ids.some((id) => player.getEquipment().contains(id));
        if (need.wear && worn) continue;
        const carried = need.ids.find((id) => player.getInventory().getAmount(id) >= Math.min(need.amount, 1));
        if (carried !== undefined) {
          if (need.wear) {
            const slot = player.getInventory().getItems().findIndex((item) => item?.getId?.() === carried);
            core.EquipPacketListener.equip(player, carried, slot, core.Inventory.INTERFACE_ID);
            if (!player.getEquipment().contains(carried)) return "failed";
          }
          continue;
        }
        const id = pick(player, need);
        if (id === null) return "failed";
        const key = `${id}x${need.amount}`;
        if (fetching?.key !== key) fetching = { key, action: createObtainAction({ items: [{ item: id, amount: need.amount }] }, world) };
        const result = fetching.action.update(ctx);
        if (result === "failed") return "failed";
        return "running";
      }
      fetching = null;
      return "success";
    },
    stop(ctx) {
      fetching?.action?.stop?.(ctx);
      fetching = null;
    },
    madeProgress() {
      return true;
    },
    describe() {
      return "getting its Slayer kit";
    },
  };
}

/** Finishes its target when it waits at 0 hitpoints for an item (a gargoyle, a rockslug, a lizard). */
function finishTarget(player, core) {
  const npc = player.getCombat?.()?.getTarget?.();
  if (!npc?.isNpc?.()) return false;
  const finisher = finisherFor(npc);
  if (!finisher || npc.getHitpoints() > finisher.threshold) return false;
  const id = finisher.ids.find((candidate) => player.getInventory().getAmount(candidate) > 0);
  if (id === undefined) return false;
  const slot = player.getInventory().getItems().findIndex((item) => item?.getId?.() === id);
  core.UseItemPacketListener.itemOnNpc(player, core.Inventory.INTERFACE_ID, npc.getIndex(), id, slot);
  return true;
}

module.exports = { createSlayerKitAction, needs, missing, finishTarget };
