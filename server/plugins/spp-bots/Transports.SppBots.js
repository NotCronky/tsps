"use strict";

/**
 * The transports spp-bots plan with: the live game's table (plugins/agent/data/transports.json,
 * imported from Shortest Path) plus the ones scouts discovered on this server
 * (Scout.SppBots.js), saved in data/saves/spp-bots/discovered-transports.json in the same row
 * shape. Discovered rows are what this server's own handlers did when a scout clicked an object
 * the table has no row for, so they never disagree with the server.
 */

const fs = require("fs");
const path = require("path");
const { TRANSPORTS_FILE, LOC_TELEPORTS_FILE, indexTransports } = require("./Imports.SppBots");
const { SAVE_DIRECTORY, ensureSaveDirectory } = require("./Roster.SppBots");

const DISCOVERED_FILE = path.join(SAVE_DIRECTORY, "discovered-transports.json");

let cache = null;

/** { rows: [[from, to, menu, id, ...]], tried: { "id@x,y,z|option": outcome }, findings: [...] } */
function readDiscovered() {
  try {
    const raw = JSON.parse(fs.readFileSync(DISCOVERED_FILE, "utf8"));
    return { rows: raw.rows ?? [], tried: raw.tried ?? {}, findings: raw.findings ?? [] };
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`[spp-bots] could not read ${DISCOVERED_FILE}`, error);
    return { rows: [], tried: {}, findings: [] };
  }
}

function writeDiscovered(discovered) {
  ensureSaveDirectory();
  const temp = `${DISCOVERED_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(discovered));
  fs.renameSync(temp, DISCOVERED_FILE);
  cache = null;
}

const FIXES = require(path.join(__dirname, "data", "transport-fixes.json"));

/** A table row with this server's landing where data/transport-fixes.json corrects it. */
function fixLanding(row) {
  const fix = (FIXES.landings ?? []).find((entry) => entry.menu === row[2]
    && entry.from.every((value, index) => value === row[0][index]));
  return fix ? [row[0], fix.to, ...row.slice(2)] : row;
}

/**
 * The server's loc teleports (plugins/world/data/loc-teleports.json) as table rows, for those the
 * table has no row for (same object id clicked from the same tile): what this server does when a
 * player clicks them, as discovered rows are. Found missing: the Gnome Stronghold's opening to
 * the MM2 crash site and the Crash Site Cavern's entrance, so the demonic gorillas counted as
 * cut off. Gates such as a quest stage stay the content's: a bot it refuses leaves the transport
 * out and plans again.
 */
function locTeleportRows(table) {
  let locs = [];
  try {
    locs = JSON.parse(fs.readFileSync(LOC_TELEPORTS_FILE, "utf8")).locs ?? [];
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`[spp-bots] could not read ${LOC_TELEPORTS_FILE}`, error);
    return [];
  }
  const known = new Set();
  for (const rows of Object.values(table.transports)) for (const row of rows) known.add(`${row[3]}@${row[0].join(",")}`);
  const rows = [];
  for (const loc of locs) {
    if (!Number.isInteger(loc.id) || !Array.isArray(loc.to) || !loc.option) continue;
    const from = [loc.x, loc.y, loc.z ?? 0];
    if (known.has(`${loc.id}@${from.join(",")}`)) continue;
    rows.push([from, [loc.to[0], loc.to[1], loc.to[2] ?? 0], `${loc.option} ${loc.display ?? ""}`.trim(), loc.id, null, null, null, null, null, Math.max(1, loc.tick ?? 3), `server loc teleport ${loc.name}`]);
  }
  return rows;
}

/** The table (with landing corrections), the server's loc teleports and the discovered rows as one transports.json-shaped object. */
function transportData() {
  const table = require(TRANSPORTS_FILE);
  const discovered = readDiscovered();
  const transports = Object.fromEntries(Object.entries(table.transports).map(([type, rows]) => [type, rows.map(fixLanding)]));
  return { ...table, transports: { ...transports, loc_teleports: locTeleportRows(table), discovered: discovered.rows } };
}

/** Transports by the tile they're clicked from, discovered ones included. Rebuilt after a write. */
function transportIndex() {
  if (!cache) cache = indexTransports(transportData());
  return cache;
}

module.exports = { DISCOVERED_FILE, readDiscovered, writeDiscovered, transportData, transportIndex, locTeleportRows };
