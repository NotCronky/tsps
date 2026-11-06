// Run after `yarn build`: node --test tests/key-chests.test.cjs
// Key chests against the real cache: data, loot rolls, fish, key halves, enhanced key (docs/key-chests.md).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
CachePipeline.initialize();
const { PluginManager } = require("../dist/plugins/PluginManager");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { Skill } = require("../dist/game/model/Skill");

const KeyChests = require("../plugins/objects/KeyChests.plugin");
const Data = require("../plugins/objects/keychests/Data.KeyChests");
const Loot = require("../plugins/objects/keychests/Loot.KeyChests");
const CrystalKey = require("../plugins/objects/keychests/CrystalKey.KeyChests");

const core = PluginManager.getCoreApi();
const objects = new Map();
const itemOnItem = [];
KeyChests.register({
  core,
  persistAttribute() {},
  emitCustomEvent() {},
  onObjectInteraction: (name, options) => objects.set(name, { ...objects.get(name), ...options }),
  onItemOnObject() {},
  onItemOnItem: (a, b, fn) => itemOnItem.push([a, b, fn]),
  onCustomEvent() {},
});

const obj = (name) => CacheDefinitions.getObjId(name);
const chest = (key) => Data.get().chests.find((entry) => entry.key === key);
/** A fixed sequence of random numbers, then 0.5. */
const randoms = (...values) => () => (values.length ? values.shift() : 0.5);

test("every chest, key and loot item is in the cache, and each main table fits its roll", () => {
  for (const entry of Data.get().chests) {
    assert.ok(entry.locId != null, entry.name);
    assert.equal(CacheDefinitions.getObject(entry.locId).name, entry.name === "Crystal chest" ? "Closed chest" : entry.name);
    const total = entry.loot.main.reduce((sum, row) => sum + row.weight, 0);
    assert.ok(total <= entry.loot.outOf, `${entry.name}: ${total} > ${entry.loot.outOf}`);
    for (const name of ["Unlock", "Open"]) {
      const options = CacheDefinitions.getObject(entry.locId).actions;
      if (options.includes(name)) assert.ok(objects.get(CacheDefinitions.getObject(entry.locId).name)?.[name], `${entry.name} ${name}`);
    }
  }
  assert.equal(Data.get().chests.find((entry) => entry.key === "larranBig").loot.main.reduce((sum, row) => sum + row.weight, 0), 60);
});

test("the crystal chest always gives an uncut dragonstone; spinach roll with 2,000 coins on 34/128", () => {
  const drops = Loot.roll(chest("crystal"), 1, randoms(0));
  assert.deepEqual(drops.map((drop) => [drop.itemId, drop.amount]), [[obj("uncut_dragonstone"), 1], [obj("spinach_roll"), 1], [obj("coins"), 2000]]);
  const nothing = Loot.roll(chest("crystal"), 1, randoms(127 / 128));
  assert.deepEqual(nothing.map((drop) => drop.itemId), [obj("uncut_dragonstone")], "17/128 is nothing more");
});

test("a pre-roll that hits is the whole reward", () => {
  const drops = Loot.roll(chest("brimstone"), 99, randoms(0, 0));
  assert.deepEqual(drops.map((drop) => drop.itemId), [obj("broken_dragon_hasta")]);
  const elven = Loot.roll(chest("elven"), 99, randoms(0.5, 0, 0));
  assert.deepEqual(elven.map((drop) => drop.itemId), [obj("dragonstone_helmet")]);
});

test("the Elven chest's key halves come with coins and one half", () => {
  const drops = Loot.roll(chest("elven"), 1, randoms(0.5, 0.5, 0, 0.5, 0.9));
  assert.deepEqual(drops.map((drop) => drop.itemId), [obj("uncut_dragonstone"), obj("coins"), obj("keyhalf1")]);
  assert.ok(drops[1].amount >= 10000 && drops[1].amount <= 15000);
});

test("fish: none of the shark-table fish below 17 Fishing; big chest amounts are half again", () => {
  for (let i = 0; i < 500; i++) {
    const fish = Loot.rollFish(1, 1, Math.random);
    assert.ok([obj("raw_monkfish"), obj("raw_swordfish"), obj("raw_tuna"), obj("raw_lobster")].includes(fish.itemId));
  }
  assert.equal(Loot.successChance(-10, 20, 1), 0);
  assert.equal(Loot.successChance(-10, 20, 99), 21 / 256);
  const lure = Loot.rollFish(99, 1.5, randoms(0, 0.99, 0));
  assert.deepEqual([lure.itemId, lure.amount], [obj("shark_lure"), Math.floor(80 * 1.5 * 2)]);
  const manta = Loot.rollFish(99, 1.5, randoms(0, 0, 0));
  assert.deepEqual([manta.itemId, manta.amount, manta.noted], [obj("raw_mantaray"), 120, true]);
});

function createPlayer({ smithing = 99, crafting = 99, items = [] } = {}) {
  const inventory = new Map(items);
  const messages = [];
  const xp = [];
  const player = {
    messages,
    xp,
    inventory,
    menu: null,
    statements: [],
    sendMessage: (message) => messages.push(message),
    performAnimation() {},
    getPacketSender: () => ({ sendSound() {}, sendCreationMenu: (menu) => { player.menu = menu; } }),
    getDialogueManager: () => ({ startDialogues: (chain) => player.statements.push(chain) }),
    getSkillManager: () => ({
      getCurrentLevel: (skill) => (skill === Skill.SMITHING ? smithing : skill === Skill.CRAFTING ? crafting : 99),
      addExperiences: (skill, amount) => xp.push([skill, amount]),
    }),
    getInventory: () => ({
      getAmount: (id) => inventory.get(id) ?? 0,
      delete: (id, amount) => inventory.set(id, (inventory.get(id) ?? 0) - amount),
      adds: (id, amount) => inventory.set(id, (inventory.get(id) ?? 0) + amount),
      deleteAtSlot() {},
    }),
  };
  return player;
}

test("the key halves join into a crystal key; the noted halves don't", () => {
  const player = createPlayer();
  assert.equal(CrystalKey.joinHalves({ player, usedItemId: obj("cert_keyhalf1"), usedWithItemId: obj("keyhalf2") }), false);
  CrystalKey.joinHalves({ player, usedItemId: obj("keyhalf1"), usedWithItemId: obj("keyhalf2"), usedItemSlot: 0, usedWithItemSlot: 1 });
  assert.equal(player.inventory.get(obj("crystal_key")), 1);
  assert.deepEqual(player.messages, ["You join the two halves of the key together."]);
  assert.ok(itemOnItem.some(([a, b]) => a === "Loop half of key" && b === "Tooth half of key"));
});

test("the enhanced crystal key is a crystal singing recipe at 80 Smithing and Crafting", () => {
  // The bowl's menu is CrystalSinging's (tests/crystal-singing.test.cjs); the key adds its recipe.
  const recipe = CrystalKey.singingRecipe();
  assert.equal(recipe.productId, obj("prif_crystal_key"));
  assert.deepEqual(recipe.needs, [{ itemId: obj("crystal_key"), amount: 1 }, { itemId: obj("prif_crystal_shard"), amount: 10 }]);
  assert.equal(recipe.level, 80);
  assert.equal(recipe.xp, 500);
});
