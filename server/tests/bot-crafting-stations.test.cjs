// Run after `yarn build`: node --test tests/bot-crafting-stations.test.cjs
//
// The bots' station action against the real Crafting plugin: gold jewellery at a furnace (the bar
// used on it, the menu answered through "crafting:furnace-make"), spinning at a wheel, and pottery
// shaped on a potter's wheel then fired in the oven - each through the plugin's own menus.
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const { before, after, test } = require("node:test");
require(root + "/dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require(root + "/dist/game/cache/CachePipeline");
const { PluginManager: PM } = require(root + "/dist/plugins/PluginManager");
const { Player } = require(root + "/dist/game/entity/impl/player/Player");
const { PlayerSession } = require(root + "/dist/net/PlayerSession");

let core, world, createStationAction;
before(async () => {
  await CachePipeline.initialize(root);
  PM.loadFromDirectory(root + "/plugins");
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.emitServerStartup({});
  world = require(root + "/plugins/bots/BotMode.PlayerBots").context().world;
  ({ createStationAction } = require(root + "/plugins/bots/brain/actions/Station.PlayerBots"));
});
after(() => PM.emitServerShutdown({}));

function player(t, name, x, y) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setUsername(name);
  p.setLocation(new core.Location(x, y, 0));
  p.needsPlacement = false;
  core.RegionManager.loadMapFiles(x, y);
  assert.equal(core.World.getPlayers().add(p), true);
  t.after(() => core.World.getPlayers().removes(p));
  p.getSkillManager().setMaxLevels(core.Skill.CRAFTING, 60, false).setCurrentLevel(core.Skill.CRAFTING, 60, false);
  return p;
}

/** Runs the actions in order, a tick at a time, till each says it's done (or time runs out). */
function run(p, actions, ticks = 400) {
  let index = 0;
  for (let tick = 0; tick < ticks && index < actions.length; tick++) {
    const result = actions[index].update({ player: p, nowMs: tick * 600 });
    core.World.process();
    if (result === "success") index++;
    assert.notEqual(result, "failed", `${actions[index]?.id} failed at tick ${tick}`);
  }
  return index === actions.length;
}

test("gold jewellery at a furnace: the bar on it, the ring picked from the menu, all made", (t) => {
  const I = core.ItemIdentifiers;
  const p = player(t, "stationjewel", 3107, 3499);
  p.getInventory().adds(I.RING_MOULD, 1);
  p.getInventory().adds(I.GOLD_BAR, 3);
  p.getInventory().adds(I.SAPPHIRE, 3);
  const station = createStationAction({ catalog: "furnace", use: I.GOLD_BAR, event: "crafting:furnace-make", material: I.GOLD_BAR, output: I.SAPPHIRE_RING }, world);
  assert.ok(run(p, [station]), "done");
  assert.equal(p.getInventory().getAmount(I.SAPPHIRE_RING), 3);
  assert.equal(p.getInventory().getAmount(I.RING_MOULD), 1, "the mould kept");
});

test("spinning: wool at Barbarian Village's wheel becomes balls of wool", (t) => {
  const I = core.ItemIdentifiers;
  const p = player(t, "stationspin", 3083, 3428);
  p.getInventory().adds(I.WOOL, 4);
  const station = createStationAction({ catalog: "spinning wheel", option: "Spin", material: I.WOOL, output: I.BALL_OF_WOOL }, world);
  assert.ok(run(p, [station]), "done");
  assert.equal(p.getInventory().getAmount(I.BALL_OF_WOOL), 4);
});

test("pottery: soft clay shaped into pots at the wheel, then fired in the oven", (t) => {
  const I = core.ItemIdentifiers;
  const p = player(t, "stationpot", 3086, 3410);
  p.getInventory().adds(I.SOFT_CLAY, 3);
  const shape = createStationAction({ catalog: "potter's wheel", option: "Use", material: I.SOFT_CLAY, output: I.UNFIRED_POT }, world);
  const fire = createStationAction({ catalog: "pottery oven", option: "Fire", material: I.UNFIRED_POT, output: I.UNFIRED_POT }, world);
  assert.ok(run(p, [shape, fire]), "done");
  assert.equal(p.getInventory().getAmount(I.POT), 3);
});
