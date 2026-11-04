"use strict";

/**
 * Puts on carried items, as a player does before a trip: `items(player)` lists the item ids to
 * wear (the best axe it carries, its games necklace). Each goes on through the normal equip code,
 * so wear requirements apply - an axe the character can't wield yet just stays in the inventory,
 * where the skills still use it - and what it replaces goes into the inventory.
 */
function createWearAction({ items }, world) {
  const { core } = world;
  return {
    id: "wear",
    update({ player }) {
      for (const itemId of items(player) ?? []) {
        if (!Number.isInteger(itemId) || player.getEquipment().getItems().some((item) => item?.getId?.() === itemId)) continue;
        const slot = player.getInventory().getItems().findIndex((item) => item?.getId?.() === itemId);
        if (slot >= 0) core.EquipPacketListener.equip(player, itemId, slot, core.Inventory.INTERFACE_ID);
      }
      return "success";
    },
  };
}

module.exports = { createWearAction };
