// Run after `yarn build`: node --test tests/bot-magic.test.cjs
//
// The bots' castOnItem action through the real spells: High Level Alchemy (the core's alchemy),
// Superheat Item and Lvl-1 Enchant (the spell plugins' spell-on-item hooks); runes, levels and XP
// are the spells' own. And the Magic tasks: what they need, and what they'd alch.
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const { before, after, test } = require("node:test");
require(root + "/dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require(root + "/dist/game/cache/CachePipeline");
const { PluginManager: PM } = require(root + "/dist/plugins/PluginManager");
const { Player } = require(root + "/dist/game/entity/impl/player/Player");
const { PlayerSession } = require(root + "/dist/net/PlayerSession");

let core, world, catalogue, registry, createCastOnItemAction;
before(async () => {
  await CachePipeline.initialize(root);
  PM.loadFromDirectory(root + "/plugins");
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.emitServerStartup({});
  ({ world, catalogue, registry } = require(root + "/plugins/bots/BotMode.PlayerBots").context());
  ({ createCastOnItemAction } = require(root + "/plugins/bots/brain/actions/CastOnItem.PlayerBots"));
});
after(() => PM.emitServerShutdown({}));

function player(t, name) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setUsername(name);
  p.setLocation(new core.Location(3164, 3486, 0));
  p.needsPlacement = false;
  assert.equal(core.World.getPlayers().add(p), true);
  t.after(() => core.World.getPlayers().removes(p));
  for (const skill of ["MAGIC", "SMITHING"]) p.getSkillManager().setMaxLevels(core.Skill[skill], 80, false).setCurrentLevel(core.Skill[skill], 80, false);
  return p;
}

function cast(p, action, ticks = 120) {
  for (let tick = 0; tick < ticks; tick++) {
    const result = action.update({ player: p, nowMs: tick * 600 });
    core.World.process();
    if (result === "success") return true;
    assert.notEqual(result, "failed", `failed at tick ${tick}`);
  }
  return false;
}

test("High Level Alchemy on its banked bows, through the core's alchemy", (t) => {
  const I = core.ItemIdentifiers;
  const p = player(t, "magicalch");
  p.getInventory().adds(I.YEW_LONGBOW, 3);
  p.getInventory().adds(I.NATURE_RUNE, 3);
  p.getInventory().adds(I.FIRE_RUNE, 15);
  assert.ok(cast(p, createCastOnItemAction({ spell: "High Level Alchemy", items: [I.YEW_LONGBOW] }, world)));
  assert.equal(p.getInventory().getAmount(I.NATURE_RUNE), 0, "a nature rune a cast");
  assert.ok(p.getInventory().getAmount(I.COINS) > 0, "coins for the bows");
});

test("Superheat Item on iron ore, and Lvl-1 Enchant on sapphire rings, through the spells' plugins", (t) => {
  const I = core.ItemIdentifiers;
  const p = player(t, "magicspells");
  p.getInventory().adds(I.IRON_ORE, 2);
  p.getInventory().adds(I.NATURE_RUNE, 2);
  p.getInventory().adds(I.FIRE_RUNE, 8);
  assert.ok(cast(p, createCastOnItemAction({ spell: "Superheat Item", items: [I.IRON_ORE] }, world)));
  assert.equal(p.getInventory().getAmount(I.IRON_BAR), 2);
  p.getInventory().adds(I.SAPPHIRE_RING, 2);
  p.getInventory().adds(I.COSMIC_RUNE, 2);
  p.getInventory().adds(I.WATER_RUNE, 2);
  assert.ok(cast(p, createCastOnItemAction({ spell: "Lvl-1 Enchant", items: [I.SAPPHIRE_RING] }, world)));
  assert.equal(p.getInventory().getAmount(I.RING_OF_RECOIL), 2);
});

test("the Magic tasks: alchemy takes its most valuable spare product; enchanting comes from the spell plugin", (t) => {
  const I = core.ItemIdentifiers;
  const p = player(t, "magictasks");
  const ctx = { registry, world };
  const high = catalogue.get("alch_high_level_alchemy");
  assert.match(high.check(p, ctx).reason, /items to alch/);
  p.getBank(0).adds(I.MAPLE_LONGBOW, 20);
  p.getBank(0).adds(I.YEW_LONGBOW, 10);
  p.getBank(0).adds(I.NATURE_RUNE, 100);
  p.getBank(0).adds(I.FIRE_RUNE, 500);
  assert.equal(high.check(p, ctx).ok, true);
  assert.equal(require(root + "/plugins/bots/tasks/Magic.PlayerBots").alchTarget(p).id, I.YEW_LONGBOW, "the more valuable bows first");
  assert.deepEqual(high.build(p, ctx).actions.map((action) => action.id), ["bank", "obtain", "bank", "castOnItem"]);
  assert.ok(catalogue.get("enchant_sapphire_ring"), "enchant tasks from the plugin's table");
  assert.ok(catalogue.get("superheat_mithril_bar"));
});
