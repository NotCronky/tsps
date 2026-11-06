// Run after `yarn build`: node --test tests/auto-prayer.test.cjs
const assert = require('node:assert/strict');
const { test, before, beforeEach } = require('node:test');

const { PluginManager } = require('../dist/plugins/PluginManager');
const { HitQueue } = require('../dist/game/content/combat/hit/HitQueue');
const AutoPrayer = require('../plugins/combat/AutoPrayer.plugin');

let core;
let commands;
let persisted;

before(() => {
  core = PluginManager.getCoreApi();
  commands = new Map();
  persisted = new Map();
  PluginManager.customEventHooks.delete('combat:incoming-attack');
  const api = PluginManager.createApi('AutoPrayerTest');
  AutoPrayer.register({
    ...api,
    core,
    onCustomEvent: (name, handler) => api.onCustomEvent(name, handler),
    persistAttribute: (key, initial) => persisted.set(key, initial),
    registerCommand: (name, handler) => commands.set(name, handler),
  });
  const { PrayerHandler } = core;
  PrayerHandler.canUse = () => true;
  PrayerHandler.activatePrayerPrayerId = (player, prayer) => {
    if (PrayerHandler.PROTECTION_PRAYERS.includes(prayer)) for (const other of PrayerHandler.PROTECTION_PRAYERS) player.prayers[other] = false;
    player.prayers[prayer] = true;
  };
  PrayerHandler.deactivatePrayer = (player, prayer) => { player.prayers[prayer] = false; };
});

beforeEach(() => {
  core.World.processCycle = 100;
});

function fakePlayer(autopray = true) {
  const attributes = new Map([[AutoPrayer.AUTOPRAY_ATTRIBUTE, autopray]]);
  const p = {
    prayers: [], messages: [],
    isPlayer: () => true,
    isNpc: () => false,
    isRegistered: () => true,
    getHitpoints: () => 99,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    sendMessage: (message) => p.messages.push(message),
    getPrayerActive: () => p.prayers,
    getSkillManager: () => ({ getCurrentLevel: () => 99 }),
  };
  return p;
}

const npc = { isNpc: () => true, isPlayer: () => false };

function announce(player, attack) {
  PluginManager.emitCustomEvent('combat:incoming-attack', { attacker: npc, target: player, ...attack });
}

function protecting(player) {
  const { PrayerHandler: P } = core;
  return [[P.PROTECT_FROM_MELEE, 'melee'], [P.PROTECT_FROM_MISSILES, 'ranged'], [P.PROTECT_FROM_MAGIC, 'magic']]
    .filter(([prayer]) => player.prayers[prayer]).map(([, style]) => style);
}

function tick() {
  core.World.processCycle++;
  core.TaskManager.process();
}

test('with auto-prayer off, nothing is prayed', () => {
  const player = fakePlayer(false);
  announce(player, { type: 'magic', cycle: 102 });
  assert.deepEqual(protecting(player), []);
});

test('an incoming attack is prayed against at once, by CombatType or style name', () => {
  const player = fakePlayer();
  announce(player, { type: core.CombatType.RANGED, cycle: 103 });
  assert.deepEqual(protecting(player), ['ranged']);
  const other = fakePlayer();
  announce(other, { type: 'melee', cycle: 101 });
  assert.deepEqual(protecting(other), ['melee']);
});

test('the protection only moves on once the attack before has been judged', () => {
  const player = fakePlayer();
  announce(player, { type: 'ranged', cycle: 102 });
  announce(player, { type: 'magic', cycle: 104 });
  assert.deepEqual(protecting(player), ['ranged'], 'the ranged attack is judged first');
  tick();
  tick();
  assert.deepEqual(protecting(player), ['ranged'], 'still judged on its own tick');
  tick();
  assert.deepEqual(protecting(player), ['magic']);
});

test('an attack judged sooner takes over at once (a prayer checked as the hit is rolled)', () => {
  const player = fakePlayer();
  announce(player, { type: 'ranged', cycle: 104 });
  announce(player, { type: 'magic' });
  assert.deepEqual(protecting(player), ['magic']);
  tick();
  assert.deepEqual(protecting(player), ['ranged']);
});

test('`protects` picks the prayer that lets least through (a curse swapping them round)', () => {
  const player = fakePlayer();
  // Cursed: magic is blocked by Protect from Melee.
  announce(player, { protects: (prayer) => (prayer === 'melee' ? 0 : 1), cycle: 100 });
  assert.deepEqual(protecting(player), ['melee']);
  const unhelped = fakePlayer();
  announce(unhelped, { protects: () => 1, cycle: 100 });
  assert.deepEqual(protecting(unhelped), [], 'nothing helps, nothing prayed');
});

test('the best offensive prayer for the player\'s own style goes up with it', () => {
  const { PrayerHandler: P, PrayerData, CombatFactory } = core;
  const getMethod = CombatFactory.getMethod;
  const canUse = P.canUse;
  try {
    CombatFactory.getMethod = () => ({ type: () => core.CombatType.RANGED });
    const archer = fakePlayer();
    announce(archer, { type: 'magic', cycle: 101 });
    assert.equal(archer.prayers[P.RIGOUR], true);
    CombatFactory.getMethod = () => ({ type: () => core.CombatType.MAGIC });
    P.canUse = (player, data) => data !== PrayerData.prayerData.get(P.AUGURY);
    const mage = fakePlayer();
    announce(mage, { type: 'melee', cycle: 101 });
    assert.equal(mage.prayers[P.MYSTIC_MIGHT], true, 'without Augury, Mystic Might');
  } finally {
    CombatFactory.getMethod = getMethod;
    P.canUse = canUse;
  }
});

test('the hit queue announces an NPC\'s hit on a player with its protection type and cycle', () => {
  const player = fakePlayer();
  const queue = new HitQueue(player);
  const hit = (bypass) => ({
    getAttacker: () => npc,
    getTarget: () => player,
    bypassesProtectionPrayer: () => bypass,
    getProtectionType: () => core.CombatType.MAGIC,
  });
  queue.addPendingHit(hit(true), 103);
  assert.deepEqual(protecting(player), [], 'a hit that judged prayer as it was rolled is left to its content');
  queue.addPendingHit(hit(false), 103);
  assert.deepEqual(protecting(player), ['magic']);
  queue.clear();
});

test('in PvP, another player\'s hit is prayed against too; a player\'s own (recoil) is not', () => {
  const player = fakePlayer();
  const queue = new HitQueue(player);
  const hit = (attacker) => ({
    getAttacker: () => attacker,
    getTarget: () => player,
    bypassesProtectionPrayer: () => false,
    getProtectionType: () => core.CombatType.RANGED,
  });
  queue.addPendingHit(hit(player), 102);
  assert.deepEqual(protecting(player), [], 'its own hit announces nothing');
  queue.addPendingHit(hit(fakePlayer(false)), 102);
  assert.deepEqual(protecting(player), ['ranged']);
  queue.clear();
});

test('out of combat, the prayers it turned on go off again; ones the player put up stay', () => {
  const { PrayerHandler: P } = core;
  const player = fakePlayer();
  player.prayers[P.PROTECT_ITEM] = true;
  announce(player, { type: 'ranged', cycle: 101 });
  assert.deepEqual(protecting(player), ['ranged']);
  for (let i = 0; i < 10; i++) tick();
  assert.deepEqual(protecting(player), ['ranged'], 'still up between attacks');
  tick();
  assert.deepEqual(protecting(player), [], 'ten ticks after the last attack, off');
  assert.equal(player.prayers[P.PROTECT_ITEM], true, "the player's own prayer is left alone");
});

test('prayers stay up while the player is still attacking', () => {
  const player = fakePlayer();
  let target = { isRegistered: () => true, getHitpoints: () => 50 };
  player.getCombat = () => ({ getTarget: () => target });
  announce(player, { type: 'magic', cycle: 100 });
  for (let i = 0; i < 20; i++) tick();
  assert.deepEqual(protecting(player), ['magic']);
  target = null;
  tick();
  assert.deepEqual(protecting(player), []);
});

test('::autoprayoff leaves the offensive prayers alone; the protection still switches', () => {
  const { PrayerHandler: P, CombatFactory } = core;
  const getMethod = CombatFactory.getMethod;
  try {
    CombatFactory.getMethod = () => ({ type: () => core.CombatType.RANGED });
    const player = fakePlayer();
    commands.get('autoprayoff')({ player, parts: ['autoprayoff'] });
    assert.equal(player.getAttribute(AutoPrayer.OFFENSIVE_ATTRIBUTE), false, 'on by default, so the first toggle turns it off');
    announce(player, { type: 'magic', cycle: 101 });
    assert.deepEqual(protecting(player), ['magic']);
    assert.ok(!player.prayers[P.RIGOUR], 'no offensive prayer');
    commands.get('autoprayoff')({ player, parts: ['autoprayoff', 'on'] });
    announce(player, { type: 'magic', cycle: 101 });
    assert.equal(player.prayers[P.RIGOUR], true);
  } finally {
    CombatFactory.getMethod = getMethod;
  }
});

test('::autopray toggles and is saved, off by default; offensive prayers saved, on by default', () => {
  assert.equal(persisted.get(AutoPrayer.AUTOPRAY_ATTRIBUTE), false);
  assert.equal(persisted.get(AutoPrayer.OFFENSIVE_ATTRIBUTE), true);
  const player = fakePlayer(false);
  commands.get('autopray')({ player, parts: ['autopray'] });
  assert.equal(player.getAttribute(AutoPrayer.AUTOPRAY_ATTRIBUTE), true);
  commands.get('autopray')({ player, parts: ['autopray', 'off'] });
  assert.equal(player.getAttribute(AutoPrayer.AUTOPRAY_ATTRIBUTE), false);
  commands.get('autopray')({ player, parts: ['autopray', 'on'] });
  assert.equal(player.getAttribute(AutoPrayer.AUTOPRAY_ATTRIBUTE), true);
});

test('offensive turned off mid-fight (a bot leaving the boss): the offensive prayer it put up comes down', () => {
  const { PrayerHandler: P, CombatFactory } = core;
  const getMethod = CombatFactory.getMethod;
  try {
    CombatFactory.getMethod = () => ({ type: () => core.CombatType.RANGED });
    const player = fakePlayer();
    player.prayers[P.PROTECT_ITEM] = true;
    announce(player, { type: 'magic', cycle: 101 });
    assert.equal(player.prayers[P.RIGOUR], true);
    PluginManager.emitCustomEvent('combat:autopray-set', { player, on: true, offensive: false });
    announce(player, { type: 'ranged', cycle: 102 });
    assert.ok(!player.prayers[P.RIGOUR], 'the offensive prayer is off');
    assert.deepEqual(protecting(player), ['magic'], 'protection still up for the attack judged next');
    assert.equal(player.prayers[P.PROTECT_ITEM], true, "the player's own prayer is left alone");
  } finally {
    CombatFactory.getMethod = getMethod;
  }
});

test('auto-prayer turned off mid-fight: the prayers it put up come down, not left draining', () => {
  const { PrayerHandler: P, CombatFactory } = core;
  const getMethod = CombatFactory.getMethod;
  try {
    CombatFactory.getMethod = () => ({ type: () => core.CombatType.RANGED });
    const player = fakePlayer();
    announce(player, { type: 'magic', cycle: 105 });
    assert.equal(player.prayers[P.RIGOUR], true);
    PluginManager.emitCustomEvent('combat:autopray-set', { player, on: false });
    tick();
    assert.deepEqual(protecting(player), []);
    assert.ok(!player.prayers[P.RIGOUR]);
  } finally {
    CombatFactory.getMethod = getMethod;
  }
});
