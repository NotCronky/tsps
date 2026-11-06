"use strict";

const { PrivateChatStatus, World } = require("./Core.Construction");
const Data = require("./Data.Construction");
const MaxHouse = require("./MaxHouse.Construction");

/**
 * Houses for the player bots, through the house's own code:
 *
 * - "construction:host-house" { player, location, handled }: a host opens its house to guests. The
 *   first time it's the ::maxhouse house (one of every room, the best piece in every space), moved
 *   to `location` (an id from data/house-locations.json); then it goes in, unlocked, private chat
 *   on (guests are let in as by any owner who accepts them). Its incense burners are lit and
 *   never go out, so every guest's offering gets both burners' bonus.
 * - "construction:visit-house" { player, owner, handled }: a guest at a house portal goes into
 *   `owner`'s house, as typing the name at the portal does.
 * - "construction:furniture" { player, keys, objects }: the furniture of the house the player is in
 *   whose buildable key is one of `keys` ("GILDED_ALTAR", "MARBLE_BURNER"), as
 *   [{ object, key, lit }]: the objects drawn in the house, used like any other.
 * - "construction:leave-house" { player, handled }: out through the exit portal.
 */
const BURNERS = new Set(["INCENSE_BURNER", "MAHOGANY_BURNER", "MARBLE_BURNER"]);
let House;

function hostHouse(request) {
  const { player } = request;
  if (!player) return;
  const save = House.houseStateFor(player);
  const location = Number.isInteger(request.location) ? request.location : 1;
  if (!player.getAttribute(MaxHouse.BACKUP_ATTRIBUTE)) {
    player.setAttribute(Data.HOUSE_ATTRIBUTE, { ...save, owned: true, location });
    MaxHouse.maxHouse({ player });
  }
  const house = House.houseStateFor(player);
  if (house.location !== location || house.locked) {
    House.releaseHouse(player, false);
    player.setAttribute(Data.HOUSE_ATTRIBUTE, { ...house, location, locked: false });
  }
  player.getRelations().setStatus(PrivateChatStatus.ON, true);
  const inside = House.houseFor(player);
  // ::maxhouse leaves its owner in building mode, which keeps guests out: back in as a host.
  request.handled = (inside?.owner === player && !inside.buildingMode) || House.enterHouse(player, false);
  const hosted = House.houseFor(player);
  if (request.handled && hosted?.owner === player) lightForever(hosted);
}

/** Every burner in the house lit, never to expire (Altars.expireHouseBurners keeps what's still due). */
function lightForever(house) {
  let lit = false;
  for (const { furniture } of house.furnitureEntries()) {
    if (!BURNERS.has(furniture.buildableKey) || house.litBurners.get(furniture) === Infinity) continue;
    house.litBurners.set(furniture, Infinity);
    lit = true;
  }
  if (lit) house.redrawFurniture();
}

function visitHouse(request) {
  const { player, owner } = request;
  if (!player || !owner) return;
  House.visitHouse(player, String(owner));
  request.handled = House.houseFor(player)?.owner?.getUsername?.()?.toLowerCase() === String(owner).toLowerCase();
}

function furniture(request) {
  const house = request.player ? House.houseFor(request.player) : null;
  if (!house) return;
  const keys = new Set(request.keys ?? []);
  const now = World.getProcessCycle();
  for (const object of house.furnitureObjects ?? []) {
    const piece = house.getFurnitureAt(object.getLocation(), object.getId(), object.getType());
    if (!piece || (keys.size > 0 && !keys.has(piece.buildableKey))) continue;
    request.objects.push({ object, key: piece.buildableKey, lit: (house.litBurners.get(piece) ?? 0) > now });
  }
}

function leaveHouse(request) {
  if (request.player) request.handled = House.exitHouse(request.player) !== false && !House.houseFor(request.player);
}

function attachBotHouses(api) {
  House = require("./House.Construction");
  api.onCustomEvent("construction:host-house", hostHouse);
  api.onCustomEvent("construction:visit-house", visitHouse);
  api.onCustomEvent("construction:furniture", furniture);
  api.onCustomEvent("construction:leave-house", leaveHouse);
}

module.exports = { attachBotHouses };
