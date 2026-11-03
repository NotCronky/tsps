// Run after `yarn build`: node --test tests/bow-of-faerdhinen.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { ItemIdentifiers: I } = require("../dist/util/ItemIdentifiers");
const { RangedWeapon } = require("../dist/game/content/combat/ranged/RangedData");
const { CombatFactory } = require("../dist/game/content/combat/CombatFactory");

const Bowfa = require("../plugins/items/BowOfFaerdhinen.plugin");
const { charges, ammoHandler, checkCharges, addShardCharges, uncharge, canEquip } = Bowfa._test;

Bowfa.attach({
  core: { Equipment, ItemIdentifiers: I, Flag: {} },
  emitCustomEvent() {},
});

function item(id, amount = 1) {
  return {
    id,
    amount,
    meta: {},
    getId() { return this.id; },
    setId(next) { this.id = next; },
    getAmount() { return this.amount; },
    getMetaValue(key) { return this.meta[key]; },
    setMetaValue(key, next) {
      if (next === undefined) delete this.meta[key];
      else this.meta[key] = next;
    },
  };
}

function player({ weapon = null, shards = 0, freeSlots = 27 } = {}) {
  const equipment = new Array(14).fill(null);
  equipment[Equipment.WEAPON_SLOT] = weapon;
  const inventory = { shards, freeSlots };
  return {
    messages: [],
    inventory,
    sendMessage(text) { this.messages.push(text); },
    getEquipment: () => ({ getItems: () => equipment, get: (slot) => equipment[slot], refreshItems() {} }),
    getInventory: () => ({
      refreshItems() {},
      getFreeSlots: () => inventory.freeSlots,
      getAmount: (id) => (id === I.CRYSTAL_SHARD ? inventory.shards : 0),
      deleteNumber: (id, count) => { if (id === I.CRYSTAL_SHARD) inventory.shards -= count; },
      adds: (id, count) => { if (id === I.CRYSTAL_SHARD) inventory.shards += count; },
    }),
  };
}

test("a shot spends one charge and the bow stays wielded", () => {
  const bow = item(I.BOW_OF_FAERDHINEN);
  bow.setMetaValue("bow-of-faerdhinen", { charges: 500 });
  const p = player({ weapon: bow });
  assert.equal(ammoHandler.decrementAmmo(p, null, 1), true, "the bow claims its own shot");
  assert.equal(charges(bow), 499);
  assert.equal(bow.getId(), I.BOW_OF_FAERDHINEN);
});

test("the last charge reverts the bow to inactive", () => {
  const bow = item(I.BOW_OF_FAERDHINEN);
  bow.setMetaValue("bow-of-faerdhinen", { charges: 1 });
  const p = player({ weapon: bow });
  ammoHandler.decrementAmmo(p, null, 1);
  assert.equal(bow.getId(), I.BOW_OF_FAERDHINEN_INACTIVE_);
  assert.equal(p.messages.at(-1), "Your bow of Faerdhinen has run out of charges.");
});

test("coloured (c) bows never spend charges or drop", () => {
  const bow = item(I.BOW_OF_FAERDHINEN_C_);
  assert.equal(ammoHandler.decrementAmmo(player({ weapon: bow }), null, 1), true);
  assert.equal(bow.getId(), I.BOW_OF_FAERDHINEN_C_);
});

test("other weapons are left to the core", () => {
  assert.equal(ammoHandler.decrementAmmo(player({ weapon: item(I.TWISTED_BOW) }), null, 1), false);
});

test("crystal shards charge an inactive bow at 100 each, capped at 20,000", () => {
  const bow = item(I.BOW_OF_FAERDHINEN_INACTIVE_);
  const p = player({ shards: 250 });
  const event = { player: p, usedItem: item(I.CRYSTAL_SHARD, 250), usedWithItem: bow, handled: false };
  addShardCharges(event);
  assert.equal(event.handled, true);
  assert.equal(bow.getId(), I.BOW_OF_FAERDHINEN);
  assert.equal(charges(bow), 20000);
  assert.equal(p.inventory.shards, 50, "only the shards that fit are used");

  const full = { player: p, usedItem: bow, usedWithItem: item(I.CRYSTAL_SHARD, 50), handled: false };
  addShardCharges(full);
  assert.equal(p.inventory.shards, 50);
  assert.equal(p.messages.at(-1), "Your bow of Faerdhinen cannot hold any more charges.");
});

test("Check reports the charges; Uncharge refunds whole shards and goes inactive", () => {
  const bow = item(I.BOW_OF_FAERDHINEN);
  bow.setMetaValue("bow-of-faerdhinen", { charges: 1234 });
  const p = player();
  checkCharges({ player: p, item: bow });
  assert.equal(p.messages.at(-1), "Your bow of Faerdhinen has 1,234 charges remaining.");
  uncharge({ player: p, item: bow });
  assert.equal(bow.getId(), I.BOW_OF_FAERDHINEN_INACTIVE_);
  assert.equal(p.inventory.shards, 12);
  assert.equal(charges(bow), 0);
});

test("an inactive bow can't be wielded", () => {
  const p = player();
  const event = { player: p, item: item(I.BOW_OF_FAERDHINEN_INACTIVE_), allow: true };
  canEquip(event);
  assert.equal(event.allow, false);
  const active = { player: p, item: item(I.BOW_OF_FAERDHINEN), allow: true };
  canEquip(active);
  assert.equal(active.allow, true);
});

test("the core never drops a bow of Faerdhinen after a shot", () => {
  const bow = item(I.BOW_OF_FAERDHINEN_C_);
  const p = player({ weapon: bow });
  p.getCombat = () => ({ getRangedWeapon: () => RangedWeapon.BOW_OF_FAERDHINEN[2] });
  p.getEquipment = ((original) => () => ({ ...original(), get: () => bow }))(p.getEquipment);
  CombatFactory.decrementAmmo(p, null, 1);
  assert.equal(bow.getId(), I.BOW_OF_FAERDHINEN_C_);
  assert.equal(bow.getAmount(), 1);
});
