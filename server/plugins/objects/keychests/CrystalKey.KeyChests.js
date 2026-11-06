"use strict";

/**
 * The crystal key and the enhanced crystal key:
 *
 * - The loop and tooth halves used on each other make a crystal key (rsprox captures: sound
 *   2127 and "You join the two halves of the key together.").
 * - Sing-crystal at a Prifddinas singing bowl offers the enhanced crystal key: a crystal key
 *   and 10 crystal shards, 80 Smithing and Crafting (boostable), 500 XP in each (Wiki). The
 *   menu, the messages, the animation and sound 8 are the captured singing bowl's. The bowl's
 *   menu is CrystalSinging's (every crystal recipe); the key is added to it as a recipe.
 */
const Data = require("./Data.KeyChests");

const JOIN_SOUND = 2127;

let core = null;

function init(api) {
  core = api.core;
}

/** The noted halves share the names, so only the halves themselves join. */
function joinHalves({ player, usedItemId, usedWithItemId, usedItemSlot, usedWithItemSlot }) {
  const halves = [core.CacheDefinitions.getObjId("keyhalf1"), core.CacheDefinitions.getObjId("keyhalf2")];
  if (!halves.includes(usedItemId) || !halves.includes(usedWithItemId)) return false;
  const inventory = player.getInventory();
  inventory.deleteAtSlot(Math.max(usedItemSlot, usedWithItemSlot), 1, false);
  inventory.deleteAtSlot(Math.min(usedItemSlot, usedWithItemSlot), 1, false);
  inventory.adds(core.CacheDefinitions.getObjId("crystal_key"), 1);
  player.getPacketSender().sendSound(JOIN_SOUND, 1, 0);
  player.sendMessage("You join the two halves of the key together.");
}

/** The key in the bowl's Sing-crystal menu (CrystalSinging). */
function singingRecipe() {
  const { productId, needs, level, xp } = Data.get().enhancedKey;
  return { productId, needs, level, xp };
}

function attach(api) {
  api.onItemOnItem("Loop half of key", "Tooth half of key", joinHalves);
  api.onCustomEvent("crystal-singing:recipes", ({ recipes }) => recipes.push(singingRecipe()));
}

module.exports = { init, attach, joinHalves, singingRecipe };
