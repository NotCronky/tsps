"use strict";

const Data = require("./Data.Construction");
const Ids = require("./Ids.Construction");
const House = require("./House.Construction");
const Instance = require("./Instance.Construction");
const Portals = require("./Portals.Construction");
const Nexus = require("./Nexus.Construction");
const Trophies = require("./Trophies.Construction");

// ::maxhouse (developer): replaces the house with a 4x4 max house, every space holding its best
// piece, for testing. The old house is kept for ::restorehouse. Levels, room counts and the house
// size are ignored. The layout is the community "minimum load time" max house: one floor, no
// upstairs or dungeon, a one-room border of grass on every side, rooms shifted to the south-west.
// The formal garden has the exit portal; the two superior gardens hold the spirit tree & fairy
// ring and the Wilderness obelisk, each with an ornate pool; two bedrooms keep a servant, the
// dining room's bell pull calls them. Each room is turned so its doorways meet its neighbours'.
// Portals, the nexus, the cape hanger and the prize chest come set up.
const { HOUSE_ATTRIBUTE } = Data;
const BACKUP_ATTRIBUTE = "construction:house-backup";
const GRID = 8;
const GROUND = 1;
const ORIGIN = 1; // the grass border: the block's south-west room sits at (1, 1)
// North row first, west to east, as the layout is drawn.
const LAYOUT = [
  ["BEDROOM", "CHAPEL", "ACHIEVEMENT_GALLERY", "STUDY"],
  ["WORKSHOP", ["SUPERIOR_GARDEN", { TELEPORT_SPACE: "SPIRIT_TREE_AND_FAIRY_RING" }], "FORMAL_GARDEN", "PORTAL_NEXUS"],
  ["COSTUME_ROOM", "MENAGERIE_INDOORS", ["SUPERIOR_GARDEN", { TELEPORT_SPACE: "OBELISK" }], "COMBAT_ROOM"],
  ["DINING_ROOM", "QUEST_HALL_UP", "BEDROOM", "GAMES_ROOM"],
];
// Spaces whose top piece isn't the one to have: the formal garden keeps the exit portal, the quest
// hall has no floor above for stairs, and its trophy is the mythical cape.
const PICKS = {
  FORMAL_GARDEN: { FORMAL_GARDEN_CENTERPIECE: "EXIT_PORTAL" },
  QUEST_HALL_UP: { QUEST_HALL_STAIRS_UP: "HALL_OPULENT_RUG", GUILD_TROPHY: "MOUNTED_MYTHICAL_CAPE" },
  ACHIEVEMENT_GALLERY: { DISPLAY: "CAPE_HANGER" },
};
const PORTAL_DESTINATIONS = ["varrock teleport", "camelot teleport", "ardougne teleport"];
const NEXUS_DESTINATIONS = ["varrock teleport", "lumbridge teleport", "falador teleport", "camelot teleport", "ardougne teleport", "watchtower teleport", "trollheim teleport", "kharyrll teleport"];
const MAX_CAPE = { cape: Ids.obj("skillcape_max"), hood: Ids.obj("skillcape_max_hood") };
const MAX_CAPE_LOC = Ids.loc("poh_mounted_max_cape");
const TROPHY_FOR = { head: 7, fish: 18 }; // Vorkath's head, swift marlin
const PRIZE = 100000;
const OFFSETS = [[0, 1], [1, 0], [0, -1], [-1, 0]]; // doorway edges: north, east, south, west

function rotated(doors, rotation) {
  return ((doors << rotation) | (doors >> (4 - rotation))) & 15;
}

/** The highest-level piece a space takes (the top of an upgrade chain saves as itself). */
function bestPiece(roomKey, hotspotKey, picks = {}) {
  const forced = picks[hotspotKey] ?? PICKS[roomKey]?.[hotspotKey];
  if (forced) return forced;
  const choices = House.hotspotChoices(hotspotKey);
  if (!choices.length) return null;
  const best = choices.reduce((top, choice) => (choice.level >= top.level ? choice : top));
  return best.savesAs ?? best.key;
}

function furnished(roomKey, picks) {
  const furniture = {};
  for (const hotspotKey of new Set(Data.ROOM_BY_KEY.get(roomKey).hotspots)) {
    if (hotspotKey === "EMPTY") continue;
    const piece = bestPiece(roomKey, hotspotKey, picks);
    if (piece) furniture[hotspotKey] = piece;
  }
  return furniture;
}

/** Whether score `a` beats `b`, comparing their parts in order. */
function outscores(a, b) {
  const i = a.findIndex((value, j) => value !== b[j]);
  return i >= 0 && a[i] > b[i];
}

/**
 * Places LAYOUT's rooms, turning each (outward from the formal garden) to meet the most doorways
 * of the rooms already down, then to face the most rooms still to come, then the fewest outside.
 * Doorway masks come from the house style's room templates.
 */
function layout(save) {
  const doorsOf = (roomKey) => Instance.PlayerHouseInstance.prototype.templateDoorMask.call({ save }, roomKey);
  const rooms = Array.from({ length: 3 }, () => Array.from({ length: GRID }, () => Array(GRID).fill(null)));
  const cells = new Map();
  LAYOUT.forEach((row, r) => row.forEach((entry, column) => {
    const [roomKey, picks] = Array.isArray(entry) ? entry : [entry, {}];
    cells.set(`${ORIGIN + column},${ORIGIN + LAYOUT.length - 1 - r}`, { roomKey, picks });
  }));
  const [startKey] = [...cells].find(([, cell]) => cell.roomKey === "FORMAL_GARDEN");
  const queue = [startKey], seen = new Set(queue);
  while (queue.length) {
    const key = queue.shift();
    const [x, y] = key.split(",").map(Number);
    const { roomKey, picks } = cells.get(key);
    const doors = doorsOf(roomKey);
    let best = null;
    for (let rotation = 0; rotation < 4; rotation++) {
      const mask = rotated(doors, rotation);
      let met = 0, ahead = 0, outside = 0;
      OFFSETS.forEach(([dx, dy], edge) => {
        if (!(mask & (1 << edge))) return;
        const neighbour = rooms[GROUND][x + dx]?.[y + dy];
        if (neighbour) {
          if (rotated(doorsOf(neighbour.roomKey), neighbour.rotation) & (1 << ((edge + 2) & 3))) met++;
        } else if (cells.has(`${x + dx},${y + dy}`)) ahead++;
        else outside++;
      });
      const score = [met, ahead, -outside];
      if (!best || outscores(score, best.score)) best = { rotation, score };
    }
    rooms[GROUND][x][y] = { roomKey, rotation: best.rotation, furniture: furnished(roomKey, picks) };
    for (const [dx, dy] of OFFSETS) {
      const next = `${x + dx},${y + dy}`;
      if (cells.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return rooms;
}

/** Furniture that needs more than building: directed portals, the nexus, the hanger, trophies. */
function setUp(player, house) {
  const destinations = Portals.houseDestinations();
  let portal = 0;
  const trophies = new Set(player.getAttribute(Trophies.MOUNTED_ATTRIBUTE) ?? []);
  for (const { furniture } of house.furnitureEntries()) {
    const key = furniture.buildableKey;
    if (key.endsWith("_PORTAL_FRAME")) {
      const destination = destinations.find(data => data.name === PORTAL_DESTINATIONS[portal % PORTAL_DESTINATIONS.length]);
      if (furniture.destinations?.length === undefined && destination) {
        furniture.destinations = [destination.name];
        const tier = key.startsWith("TEAK") ? 0 : key.startsWith("MAHOGANY") ? 1 : 2;
        if (Number.isInteger(destination.portalIds[tier])) furniture.displayObjectId = destination.portalIds[tier];
      }
      portal++;
    } else if (furniture.hotspotKey === "PORTAL_NEXUS") {
      const ids = NEXUS_DESTINATIONS.map(name => [...Nexus.destinations().values()].find(data => data.spellName === name)?.id).filter(Boolean);
      player.setAttribute(Nexus.STATE_ATTRIBUTE, { slots: ids, left: ids[0] ?? 0 });
    } else if (key === "CAPE_HANGER") {
      furniture.mountedCape = { ...MAX_CAPE };
      furniture.displayObjectId = MAX_CAPE_LOC;
    } else if (key.startsWith("HEAD_DISPLAY_") || key.startsWith("FISH_DISPLAY_")) {
      const trophy = TROPHY_FOR[key.startsWith("HEAD") ? "head" : "fish"];
      furniture.trophy = trophy;
      trophies.add(trophy);
    }
  }
  player.setAttribute(Trophies.MOUNTED_ATTRIBUTE, [...trophies]);
  house.save.prize = PRIZE;
}

function maxHouse({ player }) {
  const current = House.houseStateFor(player);
  if (!player.getAttribute(BACKUP_ATTRIBUTE)) player.setAttribute(BACKUP_ATTRIBUTE, JSON.parse(JSON.stringify(current)));
  House.releaseHouse(player, false);
  const save = { ...JSON.parse(JSON.stringify(current)), owned: true, locked: false };
  save.rooms = layout(save);
  delete save.prize;
  delete save.treasure;
  player.setAttribute(HOUSE_ATTRIBUTE, save);
  if (!House.enterHouse(player, false)) return player.sendMessage("Couldn't load the new house.");
  const house = House.houseFor(player);
  if (house) {
    setUp(player, house);
    House.rebuildHouse(player, house);
  }
  const count = save.rooms.flat(2).filter(Boolean).length;
  player.sendMessage(`Your house now has ${count} rooms, all furnished. ::restorehouse brings the old one back.`);
}

function restoreHouse({ player }) {
  const backup = player.getAttribute(BACKUP_ATTRIBUTE);
  if (!backup) return player.sendMessage("There is no saved house to restore.");
  House.releaseHouse(player, true);
  player.setAttribute(HOUSE_ATTRIBUTE, backup);
  player.setAttribute(BACKUP_ATTRIBUTE, null);
  House.syncHouseOptions(player);
  player.sendMessage("Your old house is back. Enter it at your house portal.");
}

Object.assign(module.exports, { maxHouse, restoreHouse, BACKUP_ATTRIBUTE });
