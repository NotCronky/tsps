"use strict";

/**
 * Xeric's talisman (https://oldschool.runescape.wiki/w/Xeric%27s_talisman): its teleports are the
 * Jewellery plugin's (Teleports.Jewellery.js, key "xerics_talisman"); this is the rest.
 * - A lizardman fang used on it adds a charge each, up to 1,000; an inert talisman wakes up.
 * - Check says how many charges it holds. Uncharge gives back a fang per charge and leaves it
 *   inert. Dismantle breaks an inert talisman into 100 fangs.
 * - An ancient tablet used on it unlocks Xeric's Honour for good (the tablet is used up).
 * The Wiki quotes none of these messages and there is no capture: the wording is ours.
 */

const { JEWELLERY, XERICS_HONOUR_ATTRIBUTE } = require("./Teleports.Jewellery");

const TALISMAN = "Xeric's talisman";
const INERT = "Xeric's talisman (inert)";
const FANG = "Lizardman fang";
const TABLET = "Ancient tablet";
/** Dismantling an inert talisman gives 100 fangs (Wiki). */
const DISMANTLE_FANGS = 100;

const piece = JEWELLERY.find((entry) => entry.key === "xerics_talisman");
const META = piece.chargesMeta;

let api = null;

const ids = () => api.core.ItemIdentifiers;
const format = (count) => count.toLocaleString("en-GB");

function chargesOf(item) {
  if (item?.getId?.() !== ids().XERICS_TALISMAN) return 0;
  return Math.max(0, Math.min(META.max, Math.floor(Number(item.getMetaValue(META.key)) || 0)));
}

function checkLine(charges) {
  return charges > 0
    ? `Your talisman has ${format(charges)} charge${charges === 1 ? "" : "s"}.`
    : "Your talisman has no charges. It can be charged with lizardman fangs.";
}

/** The talisman's slot in the inventory, or -1. */
function slotOf(player, item) {
  return player.getInventory().getItems().indexOf(item);
}

/** Sets the talisman's charges: none leaves it inert, any wakes it up. */
function setCharges(item, charges) {
  if (charges > 0) {
    item.setId(ids().XERICS_TALISMAN);
    item.setMetaValue(META.key, charges);
  } else {
    item.setId(ids().XERICS_TALISMAN_INERT_);
    item.setMetaValue(META.key, undefined);
  }
}

/** Lizardman fangs on the talisman (either form): one charge each, up to 1,000. */
function charge(event) {
  const { player } = event;
  const talisman = [event.usedItem, event.usedWithItem].find((item) => item.getId() !== ids().LIZARDMAN_FANG);
  const inventory = player.getInventory();
  const current = chargesOf(talisman);
  const room = META.max - current;
  if (room <= 0) {
    player.sendMessage("Your talisman can't hold any more charges.");
    return true;
  }
  const fangs = Math.min(inventory.getAmount(ids().LIZARDMAN_FANG), room);
  if (fangs <= 0) return true;
  inventory.deleteNumber(ids().LIZARDMAN_FANG, fangs);
  setCharges(talisman, current + fangs);
  inventory.refreshItems();
  player.sendMessage(`You add ${format(fangs)} charge${fangs === 1 ? "" : "s"} to your talisman. ${checkLine(current + fangs)}`);
  return true;
}

function check(event) {
  const item = event.item ?? null;
  event.player.sendMessage(checkLine(chargesOf(item)));
  return true;
}

/** Gives back a fang per charge and leaves the talisman inert. */
function uncharge(event) {
  const { player, item } = event;
  const charges = chargesOf(item);
  if (charges <= 0) {
    player.sendMessage(checkLine(0));
    return true;
  }
  const inventory = player.getInventory();
  if (!inventory.contains(ids().LIZARDMAN_FANG) && inventory.getFreeSlots() <= 0) {
    player.sendMessage("You need a free inventory space to take the fangs out of your talisman.");
    return true;
  }
  setCharges(item, 0);
  inventory.adds(ids().LIZARDMAN_FANG, charges);
  inventory.refreshItems();
  player.getEquipment().refreshItems();
  player.sendMessage(`You take ${format(charges)} lizardman fang${charges === 1 ? "" : "s"} out of your talisman.`);
  return true;
}

/** Breaks an inert talisman into 100 fangs, after asking. */
function dismantle(event) {
  const { player, item } = event;
  api.sendMultiChatboxPrompt(
    player,
    `Dismantle your talisman into ${DISMANTLE_FANGS} lizardman fangs?`,
    "Yes, dismantle it.",
    () => {
      const slot = slotOf(player, item);
      if (slot < 0 || item.getId() !== ids().XERICS_TALISMAN_INERT_) return;
      const inventory = player.getInventory();
      inventory.deleteAtSlot(slot, 1, false);
      inventory.adds(ids().LIZARDMAN_FANG, DISMANTLE_FANGS);
      inventory.refreshItems();
      player.sendMessage(`You dismantle your talisman into ${DISMANTLE_FANGS} lizardman fangs.`);
    },
    "No.",
    () => {},
  );
  return true;
}

/** An ancient tablet on the talisman unlocks Xeric's Honour, once. */
function unlockHonour(event) {
  const { player } = event;
  if (player.getAttribute(XERICS_HONOUR_ATTRIBUTE) === true) {
    player.sendMessage("Your talisman can already take you to Xeric's Honour.");
    return true;
  }
  const inventory = player.getInventory();
  const tablet = [event.usedItem, event.usedWithItem].find((item) => item.getId() === ids().ANCIENT_TABLET);
  const slot = inventory.getItems().indexOf(tablet);
  if (slot < 0) return true;
  inventory.deleteAtSlot(slot, 1, false);
  inventory.refreshItems();
  player.setAttribute(XERICS_HONOUR_ATTRIBUTE, true);
  player.sendMessage("You use the tablet on your talisman, unlocking the teleport to Xeric's Honour.");
  return true;
}

module.exports = function registerXericsTalisman(pluginApi) {
  api = pluginApi;
  api.persistAttribute(XERICS_HONOUR_ATTRIBUTE, false);
  api.onItemAction(TALISMAN, { Check: check, Uncharge: uncharge });
  api.onItemAction(INERT, { Check: check, Dismantle: dismantle });
  api.onItemOnItem(FANG, TALISMAN, charge);
  api.onItemOnItem(FANG, INERT, charge);
  api.onItemOnItem(TABLET, TALISMAN, unlockHonour);
  api.onItemOnItem(TABLET, INERT, unlockHonour);
};

Object.assign(module.exports, { _test: { chargesOf, checkLine, charge, check, uncharge, unlockHonour, DISMANTLE_FANGS } });
