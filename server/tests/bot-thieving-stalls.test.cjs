// Run after `yarn build`: node --test tests/bot-thieving-stalls.test.cjs
//
// Stall thieving as a bot task, in bot mode on a real player: Varrock's tea stall, stolen from
// through the Thieving plugin's own Steal-from until there's tea in the pack.
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const { before, after, test } = require("node:test");
require(root + "/dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require(root + "/dist/game/cache/CachePipeline");
const { PluginManager: PM } = require(root + "/dist/plugins/PluginManager");
const { Player } = require(root + "/dist/game/entity/impl/player/Player");
const { PlayerSession } = require(root + "/dist/net/PlayerSession");

let core, BotMode;
before(async () => {
  await CachePipeline.initialize(root);
  PM.loadFromDirectory(root + "/plugins");
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.emitServerStartup({});
  BotMode = require(root + "/plugins/bots/BotMode.PlayerBots");
});
after(() => PM.emitServerShutdown({}));

test("a stall task steals tea from Varrock's tea stall in bot mode", { timeout: 300000 }, (t) => {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setUsername("stallthief");
  p.setLocation(new core.Location(3267, 3412, 0));
  p.needsPlacement = false;
  core.RegionManager.loadMapFiles(3267, 3412);
  assert.equal(core.World.getPlayers().add(p), true);
  t.after(() => { BotMode.stop(p); core.World.getPlayers().removes(p); });
  p.getSkillManager().setMaxLevels(core.Skill.THIEVING, 10, false).setCurrentLevel(core.Skill.THIEVING, 10, false);
  const { catalogue, registry, world } = BotMode.context();
  assert.ok(catalogue.get("steal_tea_stall"), "a task per stall");
  assert.match(catalogue.get("steal_gem_stall").check(p, { registry, world }).reason, /needs 75 Thieving/);
  assert.equal(BotMode.start(p, "steal_tea_stall"), true);
  const tea = core.ItemIdentifiers.CUP_OF_TEA_2;
  // The bot paces itself by the clock: 600ms a tick, as the game's are.
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  let stolen = 0;
  for (let tick = 0; tick < 300 && stolen === 0; tick++) {
    now += 600;
    core.World.process();
    stolen = p.getInventory().getAmount(tea);
  }
  Date.now = realNow;
  assert.ok(stolen > 0, `tea stolen (thieving xp ${p.getSkillManager().getExperience(core.Skill.THIEVING)})`);
});
