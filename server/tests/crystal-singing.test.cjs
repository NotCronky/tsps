// Run after `yarn build`: node --test tests/crystal-singing.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
CachePipeline.initialize();
const { PluginManager } = require("../dist/plugins/PluginManager");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { Skill } = require("../dist/game/model/Skill");

const CrystalSinging = require("../plugins/items/CrystalSinging.plugin");
const CrystalArmour = require("../plugins/items/CrystalArmour.plugin");
const KeyChests = require("../plugins/objects/KeyChests.plugin");

const core = PluginManager.getCoreApi();
const I = core.ItemIdentifiers;
const listeners = new Map();
const objects = new Map();
const onObject = [];
let songComplete = true;
function makeApi() {
  const api = {
    core,
    emitCustomEvent(name, request) {
      if (name === "quest:is-complete" && request.key === "song_of_the_elves") request.complete = songComplete;
      for (const fn of listeners.get(name) ?? []) fn(request);
    },
    onCustomEvent: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    onObjectInteraction: (name, options) => objects.set(name, { ...objects.get(name), ...options }),
    onItemOnObject: (item, object, fn) => onObject.push([item, object, fn]),
  };
  return new Proxy(api, { get: (target, key) => (key in target ? target[key] : () => {}) });
}
for (const plugin of [CrystalArmour, KeyChests, CrystalSinging]) plugin.register(makeApi());

const BOWL = CacheDefinitions.getLocId("prif_singing_bowl");
const T = CrystalSinging._test;

function createPlayer({ level = 99, items = [] } = {}) {
  const amounts = new Map(items);
  const added = [];
  const player = {
    added, xp: [], menu: null, statements: [],
    performAnimation() {},
    getPacketSender: () => ({ sendSound() {}, sendCreationMenu: (menu) => { player.menu = menu; } }),
    getDialogueManager: () => ({ startDialogues: (chain) => player.statements.push(chain) }),
    getSkillManager: () => ({
      getCurrentLevel: () => level,
      addExperiences: (skill, amount) => player.xp.push([skill, amount]),
    }),
    getInventory: () => ({
      getAmount: (id) => amounts.get(id) ?? 0,
      deleteNumber: (id, amount) => amounts.set(id, (amounts.get(id) ?? 0) - amount),
      add: (item) => { added.push(item); amounts.set(item.getId(), (amounts.get(item.getId()) ?? 0) + item.getAmount()); },
      refreshItems() {},
    }),
  };
  return player;
}
const offered = (player) => player.menu?.items ?? player.menu?.getItems?.() ?? null;

test("Sing-crystal on the Prifddinas bowl; other bowls fall through", () => {
  assert.ok(objects.get("Singing bowl")?.["Sing-crystal"]);
  assert.equal(T.singCrystal({ player: createPlayer(), objectId: CacheDefinitions.getLocId("gauntlet_singing_bowl") }), false);
  assert.ok(onObject.some(([item]) => item === "Enhanced crystal weapon seed"));
});

test("an enhanced crystal weapon seed sings a Bow of Faerdhinen with 10,000 charges", () => {
  const player = createPlayer({ items: [[I.ENHANCED_CRYSTAL_WEAPON_SEED, 1], [I.CRYSTAL_SHARD, 250]] });
  T.useSeedOnBowl({ player, objectId: BOWL, itemId: I.ENHANCED_CRYSTAL_WEAPON_SEED });
  assert.deepEqual(offered(player), [I.BOW_OF_FAERDHINEN, I.BLADE_OF_SAELDOR], "the seed's two recipes");
  player.menu.execute(I.BOW_OF_FAERDHINEN, 1);
  assert.equal(player.added[0].getId(), I.BOW_OF_FAERDHINEN);
  assert.equal(player.added[0].getMetaValue("bow-of-faerdhinen").charges, 10000);
  assert.equal(player.getInventory().getAmount(I.CRYSTAL_SHARD), 150);
  assert.equal(player.getInventory().getAmount(I.ENHANCED_CRYSTAL_WEAPON_SEED), 0);
  assert.deepEqual(player.xp, [[Skill.SMITHING, 5000], [Skill.CRAFTING, 5000]]);
});

test("Sing-crystal offers every recipe the materials allow: armour, weapons and the key", () => {
  const player = createPlayer({ items: [[I.CRYSTAL_ARMOUR_SEED, 5], [I.CRYSTAL_SHARD, 400], [I.ENHANCED_CRYSTAL_WEAPON_SEED, 1], [I.CRYSTAL_KEY, 1]] });
  T.singCrystal({ player, objectId: BOWL });
  const items = offered(player);
  for (const id of [I.CRYSTAL_HELM, I.CRYSTAL_BODY, I.CRYSTAL_LEGS, I.BOW_OF_FAERDHINEN, I.BLADE_OF_SAELDOR, CacheDefinitions.getObjId("prif_crystal_key")]) {
    assert.ok(items.includes(id), `offers ${id}`);
  }
  assert.ok(!items.includes(I.CRYSTAL_BOW), "no crystal weapon seed, no crystal bow");
  player.menu.execute(I.CRYSTAL_BODY, 1);
  assert.equal(player.added[0].getId(), I.CRYSTAL_BODY);
  assert.equal(player.getInventory().getAmount(I.CRYSTAL_ARMOUR_SEED), 2);
  assert.equal(player.getInventory().getAmount(I.CRYSTAL_SHARD), 250);
});

test("refusals: nothing to sing, levels too low, Song of the Elves", () => {
  const empty = createPlayer();
  T.singCrystal({ player: empty, objectId: BOWL });
  assert.equal(empty.menu, null);
  assert.equal(empty.statements.length, 1);
  const low = createPlayer({ level: 81, items: [[I.ENHANCED_CRYSTAL_WEAPON_SEED, 1], [I.CRYSTAL_SHARD, 100]] });
  T.singCrystal({ player: low, objectId: BOWL });
  assert.equal(low.menu, null, "82 needed for the enhanced seed");
  songComplete = false;
  const locked = createPlayer({ items: [[I.CRYSTAL_ARMOUR_SEED, 1], [I.CRYSTAL_SHARD, 50]] });
  T.singCrystal({ player: locked, objectId: BOWL });
  assert.equal(locked.menu, null);
  songComplete = true;
});
