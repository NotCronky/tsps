/**
 * A chisel on a serpentine visage makes an uncharged serpentine helm
 * (https://oldschool.runescape.wiki/w/Serpentine_helm_(uncharged): level 52 Crafting, boostable, 120 XP, 1 tick).
 * Each use makes one helm in the visage's slot, with no menu, as a chisel on limestone does. No capture
 * gives an animation or a chat line, so neither is played; the level refusal is ours.
 */
const Shared = require("./Shared.Crafting");

let recipe = null;

function data() {
  if (recipe) return recipe;
  const { ItemIds: I } = Shared.getCore();
  const { serpentineHelm } = Shared.DATA;
  return (recipe = {
    visage: Shared.itemId(serpentineHelm.visage),
    item: Shared.itemId(serpentineHelm.item),
    level: serpentineHelm.level,
    xp: serpentineHelm.xp,
    chisels: [I.CHISEL, I.JEWELLERS_CHISEL],
  });
}

/** The visage's slot when a chisel and a visage are used on each other, else -1. */
function visageSlot(event, { visage, chisels }) {
  if (event.usedItemId === visage && chisels.includes(event.usedWithItemId)) return event.usedItemSlot;
  if (event.usedWithItemId === visage && chisels.includes(event.usedItemId)) return event.usedWithItemSlot;
  return -1;
}

function chiselOnVisage(event) {
  if (event.handled || !Shared.isMembersWorld()) return;
  const helm = data();
  const slot = visageSlot(event, helm);
  if (slot < 0) return;
  const { player } = event;
  const inventory = player.getInventory();
  const visage = inventory.getItems()[slot];
  if (visage?.getId() !== helm.visage) return;
  event.handled = true;
  Shared.stopCrafting(player);
  if (Shared.craftingLevel(player) < helm.level) {
    player.sendMessage(`You need a Crafting level of ${helm.level} to make a serpentine helm.`);
    return;
  }
  visage.setId(helm.item);
  inventory.refreshItems();
  Shared.addCraftingXp(player, helm.xp);
  Shared.produced(player, helm.item, 1, helm.xp, "serpentine-helm", [[helm.visage, 1]]);
  Shared.getApi().emitCustomEvent("crafting:made", { player, itemId: helm.item });
}

module.exports = function attach(api) {
  api.onItemOnItem(chiselOnVisage, { noted: false });
};

module.exports._test = { data, visageSlot, chiselOnVisage };
