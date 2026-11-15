// Run after `yarn build`: node --test tests/magic-fang-crafting.test.cjs
// A magic fang on an uncharged trident, an uncharged trident (e) or a Staff of the Dead, with a chisel in the
// pack, makes the toxic version at 59 Crafting for no XP; the chisel is kept (Wiki: Uncharged toxic trident,
// Uncharged toxic trident (e), Toxic staff (uncharged)). On a charged trident of the seas it refuses with the
// Wiki's line. A chisel on a serpentine visage makes an uncharged serpentine helm at 52 Crafting for 120 XP
// (Wiki: Serpentine helm (uncharged)), one per use, in the visage's slot.
// Real engine: every plugin loaded, a real Player and Inventory, the item-on-item packet path.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { UseItemPacketListener } = require("../dist/net/packet/impl/UseItemPacketListener");

const CHARGED_REFUSAL = "You can't graft the fang onto a charged trident.";
let core;
let I;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  I = core.ItemIdentifiers;
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

let next = 9510;
function crafter(t, level = 99) {
  t.mock.method(core.WorldDefinition, "isMembersWorld", () => true);
  const p = new Player(null);
  p.setIndex(next++);
  p.setUsername(`fangqa${p.getIndex()}`);
  p.setLocation(new core.Location(3222, 3218, 0));
  p.messages = [];
  t.mock.method(p, "getSession", () => ({ sendClientPacket() { return true; }, write() { return true; } }));
  t.mock.method(p, "sendMessage", (m) => p.messages.push(m));
  t.mock.method(p.getInventory(), "refreshItems", () => p.getInventory());
  p.setRegistered(true);
  p.getSkillManager().setMaxLevels(core.Skill.CRAFTING, level, false).setCurrentLevels(core.Skill.CRAFTING, level, false);
  t.after(() => { core.TaskManager.cancelTasks(p); p.setRegistered(false); });
  return p;
}

function pack(p, ids) {
  ids.forEach((id, slot) => p.getInventory().setItem(slot, new core.Item(id, 1)));
}

/** Fang (slot 0) on the base (slot 1), the menu's only choice taken, and the ticks run. */
function graft(p) {
  UseItemPacketListener.itemOnItem(p, 0, 1);
  const menu = p.getCreationMenu();
  if (!menu) return false;
  menu.execute(menu.getItems()[0], 1);
  for (let i = 0; i < 4; i++) core.TaskManager.process();
  return true;
}

for (const [label, base, product] of [
  ["uncharged trident", "UNCHARGED_TRIDENT", "UNCHARGED_TOXIC_TRIDENT"],
  ["uncharged trident (e)", "UNCHARGED_TRIDENT_E_", "UNCHARGED_TOXIC_TRIDENT_E_"],
  ["Staff of the Dead", "STAFF_OF_THE_DEAD", "TOXIC_STAFF_UNCHARGED_"],
]) {
  test(`a magic fang on the ${label} with a chisel makes it toxic, keeps the chisel and gives no XP`, (t) => {
    const p = crafter(t);
    pack(p, [I.MAGIC_FANG, I[base], I.CHISEL]);
    const xp = p.getSkillManager().getExperience(core.Skill.CRAFTING);
    assert.ok(graft(p), "the make menu opens");
    const inventory = p.getInventory();
    assert.equal(inventory.getAmount(I[product]), 1);
    assert.equal(inventory.getAmount(I.MAGIC_FANG), 0);
    assert.equal(inventory.getAmount(I[base]), 0);
    assert.equal(inventory.getAmount(I.CHISEL), 1);
    assert.equal(p.getSkillManager().getExperience(core.Skill.CRAFTING), xp);
  });
}

test("without a chisel the fang is refused and nothing is used", (t) => {
  const p = crafter(t);
  pack(p, [I.MAGIC_FANG, I.UNCHARGED_TRIDENT]);
  UseItemPacketListener.itemOnItem(p, 0, 1);
  assert.deepEqual(p.messages, ["You need a chisel to make this."]);
  assert.equal(p.getInventory().getAmount(I.MAGIC_FANG), 1);
});

test("below 59 Crafting nothing is made", (t) => {
  const p = crafter(t, 58);
  pack(p, [I.MAGIC_FANG, I.UNCHARGED_TRIDENT, I.CHISEL]);
  graft(p);
  assert.equal(p.getInventory().getAmount(I.UNCHARGED_TOXIC_TRIDENT), 0);
  assert.equal(p.getInventory().getAmount(I.MAGIC_FANG), 1);
});

for (const charged of ["TRIDENT_OF_THE_SEAS", "TRIDENT_OF_THE_SEAS_FULL_", "TRIDENT_OF_THE_SEAS_E_"]) {
  test(`a magic fang on a charged ${charged} is refused`, (t) => {
    const p = crafter(t);
    pack(p, [I.MAGIC_FANG, I[charged], I.CHISEL]);
    UseItemPacketListener.itemOnItem(p, 0, 1);
    assert.deepEqual(p.messages, [CHARGED_REFUSAL]);
    assert.ok(!p.getCreationMenu(), "no make menu");
    assert.equal(p.getInventory().getAmount(I.MAGIC_FANG), 1);
    assert.equal(p.getInventory().getAmount(I[charged]), 1);
  });
}

for (const order of ["chisel on visage", "visage on chisel"]) {
  test(`${order}: an uncharged serpentine helm in the visage's slot, 120 Crafting XP, the chisel kept`, (t) => {
    const p = crafter(t);
    pack(p, [I.CHISEL, I.SERPENTINE_VISAGE, I.SERPENTINE_VISAGE]);
    const xp = p.getSkillManager().getExperience(core.Skill.CRAFTING);
    if (order === "chisel on visage") UseItemPacketListener.itemOnItem(p, 0, 1);
    else UseItemPacketListener.itemOnItem(p, 1, 0);
    const inventory = p.getInventory();
    assert.equal(inventory.getItems()[1]?.getId(), I.SERPENTINE_HELM_UNCHARGED_);
    assert.equal(inventory.getAmount(I.SERPENTINE_VISAGE), 1, "one helm per use");
    assert.equal(inventory.getAmount(I.CHISEL), 1);
    assert.equal(p.getSkillManager().getExperience(core.Skill.CRAFTING) - xp, 120);
    assert.ok(!p.getCreationMenu(), "no make menu");
  });
}

test("below 52 Crafting the visage is refused and kept", (t) => {
  const p = crafter(t, 51);
  pack(p, [I.CHISEL, I.SERPENTINE_VISAGE]);
  UseItemPacketListener.itemOnItem(p, 0, 1);
  assert.deepEqual(p.messages, ["You need a Crafting level of 52 to make a serpentine helm."]);
  assert.equal(p.getInventory().getAmount(I.SERPENTINE_VISAGE), 1);
  assert.equal(p.getInventory().getAmount(I.SERPENTINE_HELM_UNCHARGED_), 0);
});
