"use strict";

/**
 * Destination networks a bot travels by (docs/playerbots.md, "Teleports"): spirit trees and fairy
 * rings. Unlike a teleport they start at a place (a tree, a ring) and the destination is picked
 * on an interface, so they're transports from that place to every destination, built for each
 * plan from what the server says this player can use:
 *
 * - Spirit trees (SpiritTrees.plugin.js): "spirit-trees:destinations" lists the trees the player
 *   can travel to; the network needs Tree Gnome Village, leaving the Stronghold The Grand Tree.
 *   Played as a client: Travel on the tree, then the menu's slot for the destination (187:3).
 * - Fairy rings (FairyRings.plugin.js): "fairy-rings:destinations" lists every code; the rings
 *   need Fairytale II ("fairy-rings:access") and a Dramen or Lunar staff wielded. The staff is a
 *   transport item, so the trip fetches it from the bank like a fare; at the ring the bot wields
 *   it, clicks Configure, turns the dials (398:19-24) to the code and confirms (398:26).
 */

const { SPIRIT_TREES } = require("./Imports.SppBots");

const SPIRIT_MENU = 187;
const SPIRIT_MENU_CHOICES = 3;
const DIALS_INTERFACE = 398;
const DIAL_VARBITS = [3985, 3986, 3987];
const DIAL_LETTERS = [["A", "D", "C", "B"], ["I", "L", "K", "J"], ["P", "S", "R", "Q"]];
/** The button that turns dial n one step forward. */
const DIAL_FORWARD = [19, 21, 23];
const DIAL_CONFIRM = 26;
const STAFFS = [772, 9084]; // Dramen staff, Lunar staff
const NETWORK_QUEST = "Tree Gnome Village";
/** Planner cost of a network hop on top of its ticks: a click, a menu, the animation. */
const HOP_COST = 8;

const tileArray = (location) => [location.getX(), location.getY(), location.getZ()];
const tileKey = (x, y, z) => z * 268435456 + x * 16384 + y;

function questComplete(api, player, name) {
  const request = { player, name, complete: false };
  api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

/** Spirit tree hops for `player`: origin key -> transports. */
function spiritTreeHops(api, player) {
  const hops = new Map();
  if (!questComplete(api, player, NETWORK_QUEST)) return hops;
  const request = { player, list: [] };
  api.emitCustomEvent("spirit-trees:destinations", request);
  if (!request.list.length) return hops;
  for (const origin of SPIRIT_TREES) {
    if (!origin.landing || origin.house || origin.grown || origin.mooredAt) continue;
    if (origin.leaveRequires && !questComplete(api, player, origin.leaveRequires)) continue;
    // The origin itself must be a tree the player can use (it's in the menu as a destination).
    if (!request.list.some((entry) => entry.name === origin.name)) continue;
    const [x, y, z] = origin.landing;
    const list = [];
    for (const destination of request.list) {
      if (destination.name === origin.name) continue;
      const slot = SPIRIT_TREES.findIndex((tree) => tree.name === destination.name);
      if (slot < 0) continue;
      list.push({
        type: "spirit_tree", menu: "Travel Spirit tree", id: null, from: [x, y, z], to: tileArray(destination.location),
        ticks: 5 + HOP_COST, network: { kind: "spirit_tree", slot, name: destination.name, tree: origin.tree },
      });
    }
    hops.set(tileKey(x, y, z), list);
  }
  return hops;
}

/** Fairy ring hops for `player` (if it may use the rings and has a staff in `counts`). */
function fairyRingHops(api, player, counts) {
  const hops = new Map();
  if (!STAFFS.some((id) => (counts.get(id) ?? 0) > 0)) return hops;
  const access = { player, allowed: true };
  api.emitCustomEvent("fairy-rings:access", access);
  if (access.allowed !== true) return hops;
  const request = { list: [] };
  api.emitCustomEvent("fairy-rings:destinations", request);
  for (const origin of request.list) {
    const from = tileArray(origin.location);
    const list = [];
    for (const destination of request.list) {
      if (destination.code === origin.code) continue;
      list.push({
        type: "fairy_ring", menu: "Configure Fairy ring", id: null, from, to: tileArray(destination.location),
        ticks: 6 + HOP_COST, items: STAFFS.map((id) => `${id}=1`).join("|"),
        network: { kind: "fairy_ring", code: destination.code, name: destination.name },
      });
    }
    hops.set(tileKey(...from), list);
  }
  return hops;
}

/** All network hops for a plan: origin key -> transports. */
function networkHops(api, player, counts) {
  const hops = spiritTreeHops(api, player);
  for (const [key, list] of fairyRingHops(api, player, counts)) hops.set(key, [...(hops.get(key) ?? []), ...list]);
  return hops;
}

/** The staff the bot holds (worn or carried), or null. */
function heldStaff(player) {
  const worn = player.getEquipment().getItems().find((item) => item && STAFFS.includes(item.getId()));
  if (worn) return { worn: true, id: worn.getId() };
  const items = player.getInventory().getItems();
  const slot = items.findIndex((item) => item && STAFFS.includes(item.getId()));
  return slot >= 0 ? { worn: false, id: items[slot].getId(), slot } : null;
}

/** Wields the staff from the inventory, as a click on it does. False when there's none. */
function wieldStaff(api, player) {
  const staff = heldStaff(player);
  if (!staff) return false;
  if (!staff.worn) api.core.EquipPacketListener.equip(player, staff.id, staff.slot, 3214);
  return true;
}

/** With the spirit tree menu open: the destination's slot, as the menu's click. */
function chooseSpiritTree(api, player, network) {
  api.core.PluginManager.emitInterfaceActionClick({
    player, buttonId: (SPIRIT_MENU << 16) | SPIRIT_MENU_CHOICES, action: network.slot,
    groupId: SPIRIT_MENU, childId: SPIRIT_MENU_CHOICES, handled: false,
  });
}

function spiritMenuOpen(player) {
  return !!player.getAttribute("spirit-trees:menu");
}

function dialsOpen(player) {
  return Number(player.getInterfaceId?.() ?? -1) === DIALS_INTERFACE;
}

/** With the dials open: turns each to the code's letter and confirms, as the buttons do. */
function dialCode(api, player, code) {
  const { PluginManager } = api.core;
  const sender = player.getPacketSender();
  const click = (childId) => PluginManager.emitInterfaceActionClick({
    player, buttonId: (DIALS_INTERFACE << 16) | childId, action: 1, groupId: DIALS_INTERFACE, childId, handled: false,
  });
  for (let dial = 0; dial < 3; dial++) {
    for (let turns = 0; turns < 4 && DIAL_LETTERS[dial][sender.getVarbit(DIAL_VARBITS[dial]) & 3] !== code[dial]; turns++) {
      click(DIAL_FORWARD[dial]);
    }
  }
  click(DIAL_CONFIRM);
}

module.exports = { networkHops, wieldStaff, heldStaff, chooseSpiritTree, spiritMenuOpen, dialsOpen, dialCode, STAFFS };
