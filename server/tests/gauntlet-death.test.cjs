// Run after `yarn build`: node --test tests/gauntlet-death.test.cjs
//
// Dying in the Gauntlet always ends back in the lobby with nothing from the run: in the fight;
// while an ended run is still fading out (a bot mode stop, the barrier's Escape); and when a death
// begun in the maze lands after the run is over, or with the run's items somehow carried out.
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const { before, after, test } = require("node:test");
require(root + "/dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require(root + "/dist/game/cache/CachePipeline");
const { PluginManager: PM } = require(root + "/dist/plugins/PluginManager");
const { Player } = require(root + "/dist/game/entity/impl/player/Player");
const { PlayerSession } = require(root + "/dist/net/PlayerSession");

let core, Run, Items;
before(async () => {
  await CachePipeline.initialize(root);
  PM.loadFromDirectory(root + "/plugins");
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.emitServerStartup({});
  Run = require(root + "/plugins/minigames/gauntlet/RunState.Gauntlet");
  Items = require(root + "/plugins/minigames/gauntlet/Items.Gauntlet");
});
after(() => PM.emitServerShutdown({}));

function player(t, name) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setUsername(name);
  p.setLocation(new core.Location(3032, 6127, 1));
  p.needsPlacement = false;
  assert.equal(core.World.getPlayers().add(p), true);
  t.after(() => { Run.runOf(p)?.end("exit", { fade: false }); core.World.getPlayers().removes(p); });
  return p;
}
const ticks = (count) => { for (let i = 0; i < count; i++) core.World.process(); };
const inLobby = (p) => p.getLocation().getX() === 3032 && p.getLocation().getY() === 6127 && p.getLocation().getZ() === 1;
const carried = (p) => p.getInventory().getValidItems().length + p.getEquipment().getValidItems().length;

function inFight(p) {
  const run = Run.startRun(p, {});
  ticks(4);
  run.startBossPhase({ forced: true });
  ticks(2);
  assert.equal(run.stage, "boss");
  return run;
}

test("a death fighting the Hunllef ends the run in the lobby, the run's items gone", (t) => {
  const p = player(t, "gdeath1");
  inFight(p);
  p.setHitpoints(1);
  p.appendDeath();
  ticks(12);
  assert.equal(Run.runOf(p), null);
  assert.ok(inLobby(p), p.getLocation().toString());
  assert.equal(carried(p), 0);
});

test("a death while an ended run fades out still lands in the lobby, not Lumbridge", (t) => {
  const p = player(t, "gdeath2");
  const run = inFight(p);
  run.end("exit");
  p.setHitpoints(1);
  p.appendDeath();
  ticks(12);
  assert.ok(inLobby(p), p.getLocation().toString());
  assert.equal(carried(p), 0);
});

test("dying with the run's items outside a run takes them and respawns in the lobby", (t) => {
  const p = player(t, "gdeath3");
  const I = Items.itemsFor("regular");
  p.moveTo(new core.Location(3222, 3218, 0));
  ticks(1);
  p.getInventory().adds(I.helm[1], 1);
  p.getInventory().adds(I.shards, 300);
  p.getInventory().adds(core.ItemIdentifiers.COINS, 50);
  p.setHitpoints(1);
  p.appendDeath();
  ticks(12);
  assert.ok(inLobby(p), p.getLocation().toString());
  assert.equal(p.getInventory().getAmount(I.helm[1]) + p.getInventory().getAmount(I.shards), 0, "the run's items taken");
});
