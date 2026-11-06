// Run after `yarn build`: node --test tests/wintertodt-bot-restock.test.cjs
//
// A Wintertodt bot restocks its potions between rounds: concoctions from the crate then (a
// part-drunk potion doesn't count as a whole one), and as the next round starts, with the pack
// still empty, herbs from the sprouting roots and the mix, before it chops a root.
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const { before, after, test } = require("node:test");
require(root + "/dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require(root + "/dist/game/cache/CachePipeline");
const { PluginManager: PM } = require(root + "/dist/plugins/PluginManager");
const { Player } = require(root + "/dist/game/entity/impl/player/Player");
const { PlayerSession } = require(root + "/dist/net/PlayerSession");
let core;
before(async () => {
  await CachePipeline.initialize(root);
  PM.loadFromDirectory(root + "/plugins");
  core = PM.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(1630, 3980);
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));
test("between rounds it takes the batch's concoctions; as the round starts it picks the herbs and mixes them", { timeout: 300000 }, (t) => {
  const Round = require(root + "/plugins/minigames/wintertodt/Round.Wintertodt");
  const Shared = require(root + "/plugins/minigames/wintertodt/Shared.Wintertodt");
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setUsername("wtbot");
  p.setLocation(new core.Location(1630, 3984, 0)); p.needsPlacement = false;
  assert.equal(core.World.getPlayers().add(p), true);
  t.after(() => core.World.getPlayers().removes(p));
  for (const s of ["FIREMAKING", "WOODCUTTING", "HITPOINTS", "HERBLORE", "FLETCHING"]) p.getSkillManager().setMaxLevels(core.Skill[s], 80, false).setCurrentLevel(core.Skill[s], 80, false);
  for (const id of [core.ItemIdentifiers.RUNE_AXE, core.ItemIdentifiers.TINDERBOX, core.ItemIdentifiers.KNIFE, core.ItemIdentifiers.HAMMER]) p.getInventory().adds(id, 1);
  p.getInventory().adds(Shared.ITEM.REJUVENATION_1, 1);
  const msgs = []; p.sendMessage = (m) => msgs.push(m);
  if (Round.isActive()) Round.endRound();
  const request = { player: p, controller: null };
  PM.emitCustomEvent("wintertodt:play", request);
  const c = request.controller;
  const count = (id) => p.getInventory().getAmount(id);
  const full = () => count(Shared.ITEM.REJUVENATION_4);
  for (let tick = 0; tick < 60; tick++) { c.tick(); core.World.process(); }
  assert.equal(Round.isActive(), false);
  assert.equal(count(Shared.ITEM.REJUVENATION_UNF), 4, "between rounds: four concoctions (the 1-dose potion isn't a whole one)");
  assert.equal(count(Shared.ITEM.BRUMA_HERB), 0, "no herbs till the round");
  Round.startRound();
  let mixedAt = -1;
  for (let tick = 0; tick < 80 && mixedAt < 0; tick++) {
    c.tick();
    core.World.process();
    if (full() >= 4) mixedAt = tick;
    if (mixedAt < 0) assert.equal(count(Shared.ITEM.BRUMA_ROOT), 0, "no roots before the potions are made");
  }
  assert.ok(mixedAt >= 0, "four full potions mixed early in the round");
  assert.equal(count(Shared.ITEM.REJUVENATION_UNF), 0);
  c.stop?.();
  Round.endRound();
});
