// Run after `yarn build`: node --test tests/giant-lair-chests.test.cjs
// Obor's and Bryophyta's chests roll their tables through NpcDrops (npc-drops:roll-table), and
// their uniques (Hill giant club, Bryophyta's essence) drop at the Wiki's 1/118.
const assert = require("node:assert/strict");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const NpcDrops = require("../plugins/npcs/NpcDrops.plugin");
const data = require("../plugins/bosses/data/giant-boss-lairs.json");

const HILL_GIANT_CLUB = 20756;
const BRYOPHYTAS_ESSENCE = 22372;
const handlers = new Map();

function emitCustomEvent(name, payload) {
  for (const handler of handlers.get(name) ?? []) handler(payload);
}

before(() => {
  CachePipeline.initialize();
  NpcDrops.register({
    core: { CacheDefinitions },
    getPluginConfig: (key, fallback) => fallback,
    getItemOnGroundManager() {},
    onCustomEvent(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    emitCustomEvent,
    onNpcDeath() {},
    registerCommand() {},
    log() {},
  });
  NpcDrops._test.loadDrops();
});

function uniqueRate(slug, itemId, opens) {
  let hits = 0;
  for (let i = 0; i < opens; i++) {
    const request = { player: null, table: data.lairs[slug].chestTable, source: data.lairs[slug].name, drops: [] };
    emitCustomEvent("npc-drops:roll-table", request);
    hits += request.drops.filter((drop) => drop.itemId === itemId).length;
  }
  return hits / opens;
}

for (const [slug, itemId] of [["obor", HILL_GIANT_CLUB], ["bryophyta", BRYOPHYTAS_ESSENCE]]) {
  test(`${slug}'s chest drops its unique at about 1/118`, () => {
    const rate = uniqueRate(slug, itemId, 60000);
    assert.ok(rate > 1 / 150 && rate < 1 / 95, `rate 1/${(1 / rate).toFixed(1)}`);
  });
}
