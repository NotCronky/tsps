// node --test tests/bryophyta-growthlings.test.cjs
// Bryophyta summons growthlings only once she has lost ~25% of her health, on a 1/5 roll each
// time she attacks or is attacked, one batch at a time and 20+ ticks apart (Wiki).
const assert = require("node:assert/strict");
const { test, before, afterEach } = require("node:test");

const Common = require("../plugins/bosses/giantlairs/Common.GiantLairs");
const Bryophyta = require("../plugins/bosses/giantlairs/Bryophyta.GiantLairs");

let cycle = 1000;
const spawned = [];
const realRandom = Math.random;

class Location {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
  getX() { return this.x; }
  getY() { return this.y; }
}

const core = {
  Location,
  World: { getProcessCycle: () => cycle },
  RegionManager: { blocked: () => false },
  CombatMethod: class {},
  CombatType: { MAGIC: "magic", MELEE: "melee" },
};

const api = {
  core,
  spawnNpc({ id }) {
    const npc = { id, hp: 10, getHitpoints() { return this.hp; }, getCombat: () => ({ attack() {} }) };
    spawned.push(npc);
    return npc;
  },
  registerNpcCombatMethodProvider() {},
  onNpcHitModify() {},
  onObjectInteraction() {},
};

const player = { isPlayer: () => true };

function boss(hp) {
  const session = { area: { add() {} } };
  return { hp, __giantLair: session, getHitpoints() { return this.hp; }, getMaxHitpoints: () => 200, getLocation: () => new Location(3220, 9940, 0), session };
}

before(() => {
  Common.init(api);
  Bryophyta(api);
});

afterEach(() => {
  Math.random = realRandom;
  spawned.length = 0;
  cycle += 100;
});

test("no growthlings while she is above 75% health, even on a hit roll", () => {
  Math.random = () => 0;
  const npc = boss(151);
  for (let i = 0; i < 50; i++) Bryophyta.maybeSummon(npc, player);
  assert.equal(spawned.length, 0);
});

test("below 75% health a hit roll summons one batch of three", () => {
  Math.random = () => 0;
  const npc = boss(149);
  Bryophyta.maybeSummon(npc, player);
  Bryophyta.maybeSummon(npc, player);
  assert.equal(spawned.length, 3);
});

test("a new batch waits for the last to die and 20 ticks to pass", () => {
  Math.random = () => 0;
  const npc = boss(100);
  Bryophyta.maybeSummon(npc, player);
  for (const growthling of spawned) growthling.hp = 0;
  cycle += 19;
  Bryophyta.maybeSummon(npc, player);
  assert.equal(spawned.length, 3);
  cycle += 1;
  Bryophyta.maybeSummon(npc, player);
  assert.equal(spawned.length, 6);
});

test("being attacked rolls too, and her immunity holds while they live", () => {
  Math.random = () => 0;
  const npc = boss(100);
  npc.getId = () => 8195;
  const damage = { value: 30, getDamage() { return this.value; }, setDamage(v) { this.value = v; } };
  const hit = { getAttacker: () => player, getHits: () => [damage], updateTotalDamage() {} };
  Bryophyta.modifyHit({ npc, hit });
  assert.equal(spawned.length, 3);
  assert.equal(damage.value, 30, "the hit that summons them still lands");
  Bryophyta.modifyHit({ npc, hit });
  assert.equal(damage.value, 0);
});
