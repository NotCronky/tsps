// From server/: node --test tests/alchemical-hydra.test.cjs (after yarn build).
//
// The Alchemical Hydra against the OSRS Wiki (Alchemical_Hydra, /Strategies): the attack count
// (three autos, then the special, then every nine), the style switches, the 75% shield and its
// vents, the phase changes at 825/550/275, the poison, lightning and fire specials, the private
// chamber's door and spawn, and the kill.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { NpcDefinitionLoader } = require('../dist/game/definition/loader/impl/NpcDefinitionLoader');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { NPCDeathTask } = require('../dist/game/task/impl/NPCDeathTask');
const core = PluginManager.getCoreApi();

let Common, Fight, Lair, Kills, tasks, onTaskAnswer;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  new NpcDefinitionLoader().load();
  Common = require('../plugins/bosses/alchemicalhydra/Common.AlchemicalHydra');
  ({ Fight } = { Fight: require('../plugins/bosses/alchemicalhydra/Fight.AlchemicalHydra').Fight });
  Lair = require('../plugins/bosses/alchemicalhydra/Lair.AlchemicalHydra');
  Kills = require('../plugins/bosses/alchemicalhydra/Kills.AlchemicalHydra');
  tasks = [];
  const events = {};
  const api = new Proxy({
    core: { ...core, TaskManager: { submit: (task) => tasks.push(task) }, CombatFactory: { poisonEntity: (player, severity) => player.poison.push(severity) } },
    persistAttribute: () => {},
    onCustomEvent: (name, fn) => (events[name] ??= []).push(fn),
    emitCustomEvent(name, event) {
      if (name === 'slayer:on-task') { event.onTask = onTaskAnswer(event); return; }
      for (const fn of events[name] ?? []) fn(event);
    },
  }, { get: (target, key) => target[key] ?? (() => {}) });
  Common.init(api);
});

/** Runs every queued one-shot task (the phase change's second step). */
function flush() {
  const due = tasks;
  tasks = [];
  for (const task of due) task.execute();
}

const loc = (x, y) => new core.Location(x, y, 0);

function fakeHydra(hp = 1100) {
  let transform = -1;
  const npc = {
    hitpoints: hp, anims: [],
    getId: () => (transform !== -1 ? transform : Common.ids.npcs.serpentine),
    setNpcTransformationId: (id) => { transform = id; },
    getLocation: () => loc(1364, 10265),
    getSize: () => 6,
    getHitpoints: () => npc.hitpoints,
    isDyingFunction: () => false,
    performAnimation: (anim) => npc.anims.push(anim),
    getCombat: () => ({ setAttackDelay: () => {}, getHitQueue: () => ({ getQueuedDamage: () => 0 }) }),
  };
  return npc;
}

function fakePlayer(x = 1363, y = 10260) {
  let tile = loc(x, y);
  const player = {
    damage: [], poison: [], messages: [], blocked: false,
    getLocation: () => tile,
    moveTo: (to) => { tile = to; },
    isRegistered: () => true,
    sendMessage: (m) => player.messages.push(m),
    getPacketSender: () => ({ sendGraphic: () => {} }),
    getCombat: () => ({ getHitQueue: () => ({ addPendingDamage: (hits) => player.damage.push(...hits.map((h) => h.getDamage())) }) }),
    getMovementQueue: () => ({ reset: () => {} }),
    // The engine's timers, as far as a hold needs them: `blocked` is a running freeze.
    timers: new Map(),
    getTimers: () => ({
      has: (key) => (player.timers.get(key) ?? 0) > 0,
      left: (key) => player.timers.get(key) ?? 0,
      registers: (key, ticks) => player.timers.set(key, ticks),
    }),
    get blocked() { return (player.timers.get(core.TimerKey.FREEZE) ?? 0) > 0; },
  };
  return player;
}

function fakeLair(player) {
  const [minX, maxX, minY, maxY] = Common.data.room.bounds;
  return {
    players: () => (player ? [player] : []),
    contains: (l) => l.getX() >= minX && l.getX() <= maxX && l.getY() >= minY && l.getY() <= maxY,
  };
}

test('every id resolves from the cache, the phase forms in the Wiki order', () => {
  assert.deepEqual(Common.phaseForms(), [8615, 8619, 8620, 8621]);
  assert.deepEqual(Common.ids.locs.door, [34553, 34554]);
});

test('three autos, the special on the fourth, then every ninth; styles switch every three', () => {
  const fight = new Fight(fakeLair(null), fakeHydra());
  const kinds = [];
  for (let i = 0; i < 22; i++) {
    const kind = fight.nextAttack();
    kinds.push(kind);
    fight.counted(kind);
  }
  assert.deepEqual(kinds.flatMap((k, i) => (k === 'special' ? [i + 1] : [])), [4, 13, 22]);
  assert.deepEqual(kinds.slice(0, 8), ['ranged', 'ranged', 'ranged', 'special', 'magic', 'magic', 'magic', 'ranged']);
});

test('enraged, the style switches every attack', () => {
  const fight = new Fight(fakeLair(null), fakeHydra());
  fight.phase = 3;
  const kinds = [];
  for (let i = 0; i < 3; i++) { const k = fight.nextAttack(); kinds.push(k); fight.counted(k); }
  assert.deepEqual(kinds, ['ranged', 'magic', 'ranged']);
});

test('shielded it takes a quarter; its own vent takes the shield, the wrong one empowers it', () => {
  const player = fakePlayer();
  const npc = fakeHydra();
  const fight = new Fight(fakeLair(player), npc);
  assert.equal(fight.reduce(40), 10);
  // Its 6x6 footprint from (1366, 10258) reaches (1371, 10263): on the red vent.
  npc.getLocation = () => loc(1366, 10258);
  fight.eruptVents([player]);
  assert.equal(fight.shielded, false);
  assert.equal(player.messages.at(-1), Common.message('weakened'));
  assert.equal(fight.reduce(40), 40);
  fight.phase = 1;
  fight.shielded = true;
  fight.eruptVents([player]);
  assert.equal(fight.shielded, true, 'the red vent does nothing for the electric phase');
  assert.equal(player.messages.at(-1), Common.message('empowered'));
});

test('a head falls at 825, 550 and 275: each form in turn, shielded again until the enraged one', () => {
  const npc = fakeHydra(824);
  const fight = new Fight(fakeLair(null), npc);
  const { ids } = Common;
  assert.equal(fight.checkPhase(), true);
  assert.equal(npc.getId(), ids.npcs.toElectric);
  assert.equal(fight.transitioning(), true);
  flush(1);
  assert.equal(npc.getId(), ids.npcs.electric);
  assert.equal(fight.shielded, true);
  assert.equal(fight.checkPhase(), false, 'not below 550 yet');
  fight.tickCount = fight.transitionUntil;
  npc.hitpoints = 549;
  fight.checkPhase();
  flush(1);
  assert.equal(npc.getId(), ids.npcs.flame);
  fight.tickCount = fight.transitionUntil;
  npc.hitpoints = 274;
  fight.checkPhase();
  flush(1);
  assert.equal(npc.getId(), ids.npcs.enraged);
  assert.equal(fight.enraged, true);
  assert.equal(fight.reduce(40), 40, 'no shield once enraged');
  npc.hitpoints = 1;
  assert.equal(fight.checkPhase(), false);
});

test('poison: a 3x3 splash (up to 7, poison 6 on the target) leaves pools hitting up to 12 a tick', () => {
  const player = fakePlayer();
  const fight = new Fight(fakeLair(player), fakeHydra());
  fight.landPoison(player.getLocation(), player);
  assert.equal(player.damage.length, 1);
  assert.ok(player.damage[0] <= Common.data.poison.splashMax);
  assert.deepEqual(player.poison, [Common.data.poison.poisonTargeted]);
  assert.equal(fight.pools.length, 9);
  fight.tickCount += 1;
  fight.tickPools([player]);
  assert.equal(player.damage.length, 2);
  assert.ok(player.damage[1] >= 1 && player.damage[1] <= Common.data.poison.poolMax);
  fight.tickCount += Common.data.poison.poolTicks;
  fight.tickPools([player]);
  assert.equal(fight.pools.length, 0);
});

test('lightning: four currents from the corners close in; reaching the player hits and binds', () => {
  const player = fakePlayer(1360, 10256);
  const fight = new Fight(fakeLair(player), fakeHydra());
  fight.castLightning();
  assert.equal(fight.currents.length, 4);
  for (let i = 0; i < 30 && fight.currents.length; i++) {
    fight.tickCount += 1;
    fight.tickCurrents([player]);
  }
  assert.ok(player.damage.length >= 1, 'a current reached the player');
  assert.ok(player.damage.every((d) => d <= Common.data.lightning.max));
  assert.equal(player.blocked, true);
});

test('fire: away from a corner, 5x5 layers right beside the player, then a tracking fire and its five burns', () => {
  const player = fakePlayer(1366, 10262);
  const fight = new Fight(fakeLair(player), fakeHydra());
  fight.breatheFire(player);
  assert.equal(fight.walls.length, 0, 'the side fires spread from the next tick');
  fight.tickCount = fight.launch.at;
  fight.tickFire([player]);
  // South of the Hydra, away from its corners: two 5x5 layers right beside the player.
  assert.equal(fight.walls.length, 50);
  assert.ok(fight.walls.every((w) => w.tile.getX() !== player.getLocation().getX()), 'the walls flank, not cover, the player');
  assert.ok(fight.walls.some((w) => Math.abs(w.tile.getX() - player.getLocation().getX()) === 1), 'with no clear tile beside them');
  assert.equal(fight.trackers.length, 1, 'the tracking fire leaves once they are out');
  for (let i = 0; i < 30; i++) {
    fight.tickCount += 1;
    fight.tickFire([player]);
  }
  const burns = player.damage.filter((d) => d === Common.data.fire.burnDamage).length;
  assert.ok(player.damage.length >= 1 + Common.data.fire.burnHits - 1);
  assert.ok(burns >= Common.data.fire.burnHits - 1);
});

test('a phase change dissipates the lightning, and stopping clears everything', () => {
  const player = fakePlayer();
  const npc = fakeHydra(549);
  const fight = new Fight(fakeLair(player), npc);
  fight.phase = 1;
  fight.castLightning();
  fight.checkPhase();
  assert.equal(fight.currents.length, 0);
  fight.landPoison(player.getLocation(), player);
  fight.stop();
  assert.equal(fight.pools.length, 0);
  assert.equal(npc.__hydraFight, null);
});

test('the world spawn in the chamber stays out; a hit off task does nothing', () => {
  const event = { npcId: Common.ids.npcs.serpentine, location: loc(1364, 10265), allow: true };
  Lair.blockWorldSpawn(event);
  assert.equal(event.allow, false);
  const outside = { npcId: Common.ids.npcs.serpentine, location: loc(1300, 10200), allow: true };
  Lair.blockWorldSpawn(outside);
  assert.equal(outside.allow, true);

  const npc = fakeHydra();
  const fight = new Fight(fakeLair(null), npc);
  const part = { damage: 40, getDamage() { return this.damage; }, setDamage(d) { this.damage = d; } };
  const player = { isPlayer: () => true, getAsPlayer: () => player };
  onTaskAnswer = () => false;
  Lair.hydraHit({ npc, hit: { getAttacker: () => player, getHits: () => [part] } });
  assert.equal(part.damage, 0);
  onTaskAnswer = () => true;
  part.damage = 40;
  Lair.hydraHit({ npc, hit: { getAttacker: () => player, getHits: () => [part] } });
  assert.equal(part.damage, 10, 'shielded: a quarter');
  fight.stop();
});

test('the kill: its fight stops, the count goes up, a task kill is worth 1,320 Slayer xp', () => {
  const npc = fakeHydra(0);
  const fight = new Fight(fakeLair(null), npc);
  const attrs = new Map();
  const player = { isPlayer: () => true, isRegistered: () => true, messages: [], sendMessage(m) { this.messages.push(m); }, getAttribute: (k) => attrs.get(k), setAttribute: (k, v) => attrs.set(k, v) };
  Kills.hydraDeath({ npc, killer: player });
  assert.equal(fight.stopped, true);
  flush();
  assert.equal(player.messages.at(-1), 'Your Alchemical Hydra kill count is: <col=ff0000>1</col>.');
  const kill = { npc, xp: 1100 };
  Kills.slayerXp(kill);
  assert.equal(kill.xp, 1320);
});

test('before it is enraged, no hit can take its last hitpoint', () => {
  const npc = fakeHydra(3);
  const fight = new Fight(fakeLair(null), npc);
  fight.shielded = false;
  const parts = [20, 15].map((damage) => ({ damage, getDamage() { return this.damage; }, setDamage(d) { this.damage = d; } }));
  const player = { isPlayer: () => true, getAsPlayer: () => player };
  onTaskAnswer = () => true;
  Lair.hydraHit({ npc, hit: { getAttacker: () => player, getHits: () => parts } });
  assert.equal(parts.reduce((sum, p) => sum + p.getDamage(), 0), 2, 'it keeps 1 hitpoint');
  fight.phase = 3;
  parts.forEach((p) => p.setDamage(20));
  Lair.hydraHit({ npc, hit: { getAttacker: () => player, getHits: () => parts } });
  assert.equal(parts.reduce((sum, p) => sum + p.getDamage(), 0), 40, 'enraged, it can die');
  fight.stop();
});


for (const lastStyle of ['magic', 'ranged']) {
  test(`enrage opens opposite the last ${lastStyle} attack, then alternates around its special`, () => {
    for (const priorBasics of [1, 2, 3]) {
      const npc = fakeHydra(275);
      const fight = new Fight(fakeLair(null), npc);
      fight.phase = 2;
      fight.style = lastStyle;
      fight.basics = priorBasics;
      assert.equal(fight.checkPhase(), true);
      flush();
      fight.tickCount = fight.transitionUntil;
      const kinds = [];
      for (let i = 0; i < 5; i++) {
        const kind = fight.nextAttack();
        kinds.push(kind);
        fight.counted(kind);
      }
      const opposite = lastStyle === 'magic' ? 'ranged' : 'magic';
      assert.deepEqual(kinds, [opposite, lastStyle, opposite, 'special', lastStyle]);
      fight.stop();
    }
  });
}

/** Real combat/health/death code, dispatching the plugin's registered hooks. */
function realFlameFight(t) {
  tasks = [];
  let beforeDeath;
  Kills.attach(new Proxy({ onNpcBeforeDeath: (handler) => { beforeDeath = handler; } }, {
    get: (target, key) => target[key] ?? (() => {}),
  }));
  t.mock.method(PluginManager, 'emitNpcBeforeDeath', (event) => {
    beforeDeath(event);
    return event.preventDeath === true;
  });
  t.mock.method(PluginManager, 'emitNpcHitModify', (npc, hit) => {
    Lair.hydraHit({ npc, hit });
    return hit;
  });
  const submitted = [];
  t.mock.method(core.TaskManager, 'submit', (task) => submitted.push(task));
  const player = new Player(null, loc(1363, 10265));
  player.getPacketSender = () => new Proxy({}, { get: () => () => {} });
  player.setRegistered(true);
  player.setHitpoints(99);
  player.setNeedsPlacement(false);
  const npc = core.NPC.create(Common.ids.npcs.serpentine, loc(1364, 10265));
  npc.setRegistered(true);
  npc.setNeedsPlacement(false);
  const fight = new Fight(fakeLair(null), npc);
  fight.phase = 2;
  fight.shielded = false;
  npc.setNpcTransformationId(Common.ids.npcs.flame);
  npc.setHitpoints(280); // Valid third-phase HP, just above its 275 threshold.
  onTaskAnswer = () => true;
  const method = new (class extends core.CombatMethod {
    type() { return core.CombatType.RANGED; }
  })();
  const hit = (damage) => new core.PendingHit(player, npc, method, {
    delay: 0, damage, rollAccuracy: false, experience: false, handleAfterHitEffects: false,
  });
  const queue = npc.getCombat().getHitQueue();
  t.after(() => {
    fight.stop();
    queue.clear();
    npc.setRegistered(false);
    player.setRegistered(false);
  });
  return { npc, fight, queue, submitted, hit };
}

test('same-tick real PendingHits keep one HP until enrage, then schedule normal death', (t) => {
  const { npc, fight, queue, submitted, hit } = realFlameFight(t);
  const hits = [hit(100), hit(100), hit(100)];
  for (const pending of hits) queue.addPendingHit(pending, 100);
  queue.process(100);
  assert.deepEqual(hits.map((pending) => pending.getTotalDamage()), [100, 100, 79]);
  assert.equal(npc.getHitpoints(), 1);
  assert.notEqual(npc.isDyingFunction(), true);
  assert.equal(npc.getId(), Common.ids.npcs.flame);
  assert.equal(submitted.filter((task) => task instanceof NPCDeathTask).length, 0);

  fight.tick([]);
  flush();
  fight.tickCount = fight.transitionUntil;
  assert.equal(fight.enraged, true);
  assert.equal(npc.getId(), Common.ids.npcs.enraged);
  queue.addPendingHit(hit(10), 101);
  queue.process(101);
  assert.equal(npc.getHitpoints(), 0);
  assert.equal(npc.isDyingFunction(), true);
  assert.equal(npc.getId(), Common.ids.npcs.enraged, 'its last head falls as the enraged form first');
  assert.equal(submitted.filter((task) => task instanceof NPCDeathTask).length, 1);
  flush();
  assert.equal(npc.getId(), Common.ids.npcs.dead, 'then the final form plays hydra_death');
});

test('direct pending damage cannot bypass the pre-enrage death guard', (t) => {
  const { npc, fight, queue, submitted } = realFlameFight(t);
  queue.addPendingDamage([new core.HitDamage(300, core.HitMask.RED), new core.HitDamage(300, core.HitMask.RED)]);
  queue.process(100);
  assert.equal(npc.getHitpoints(), 1);
  assert.equal(npc.getId(), Common.ids.npcs.flame);
  assert.notEqual(npc.isDyingFunction(), true);
  assert.equal(submitted.filter((task) => task instanceof NPCDeathTask).length, 0);
  fight.tick([]);
  assert.equal(fight.enraged, true, 'the rescued hitpoint still lets the final phase begin');
});

test('the vents spray every ventEvery ticks: their geyser plays, then back to idle once it has run', () => {
  const sent = [];
  const player = fakePlayer();
  player.getPacketSender = () => ({ sendGraphic: () => {}, sendObjectAnimation: (vent, anim) => sent.push([vent, anim.getId()]) });
  const lair = { ...fakeLair(player), vents: () => ['red', 'green', 'blue'] };
  const fight = new Fight(lair, fakeHydra());
  const { combat } = Common.data;
  const [geyser, off] = [Common.ids.seqs.geyser, Common.ids.seqs.geyserOff];
  assert.deepEqual([geyser, off], [8279, 8280], 'hydra_geyser / hydra_geyser_off');
  for (let i = 0; i < combat.ventEvery; i++) fight.tick([player]);
  assert.deepEqual(sent, [['red', geyser], ['green', geyser], ['blue', geyser]]);
  for (let i = 0; i < combat.geyserTicks - 1; i++) fight.tick([player]);
  assert.equal(sent.length, 3, 'still spraying');
  fight.tick([player]);
  assert.deepEqual(sent.slice(3), [['red', off], ['green', off], ['blue', off]]);
  fight.tick([player]);
  fight.stop();
  assert.equal(sent.length, 6, 'stopped between sprays: nothing more to reset');
});

test('a Hydra walking onto its vent mid-spray is weakened once and roars; a wrong vent empowers it (52)', () => {
  const player = fakePlayer();
  const npc = fakeHydra();
  const chat = [];
  npc.forceChat = (text) => chat.push(text);
  let at = loc(1356, 10252);
  npc.getLocation = () => at;
  const fight = new Fight(fakeLair(player), npc);
  const { combat } = Common.data;
  for (let i = 0; i < combat.ventEvery; i++) fight.tick([player]);
  assert.equal(fight.shielded, true, 'away from the vents as they start');
  at = loc(1366, 10258); // its footprint now reaches the red vent
  fight.tick([player]);
  fight.tick([player]);
  assert.equal(fight.shielded, false);
  assert.deepEqual(chat, ['Roaaaaaaaaaaar!']);
  assert.equal(player.messages.filter((m) => m === Common.message('weakened')).length, 1);
  assert.equal(fight.maxHit(), 35);

  const other = new Fight(fakeLair(player), fakeHydra());
  other.phase = 1;
  other.npc.getLocation = () => loc(1366, 10258);
  other.eruptVents([player]);
  assert.equal(other.maxHit(), 52, 'empowered: up to 50% more');
  other.phase = 0; other.changePhase();
  assert.equal(other.maxHit(), 35, 'a new phase starts unempowered');
});

test('its heads sway after every third basic attack (not once enraged); the enraged poison uses its own skeleton', () => {
  const fight = new Fight(fakeLair(null), fakeHydra());
  const sways = [];
  for (let i = 0; i < 8; i++) {
    const kind = fight.nextAttack();
    fight.counted(kind);
    if (kind !== 'special' && fight.switchesNext()) sways.push(i + 1);
  }
  assert.deepEqual(sways, [3, 7]);
  assert.deepEqual(Common.ids.seqs.switch, [9111, 9112, 9113, 9114]);
  fight.phase = 3;
  assert.equal(fight.switchesNext(), false);
  assert.equal(Common.ids.seqs.special[3], 8255, 'hydra_stage_4_attack_magic, not the stage 1 special');
});

/** A Hydra that walks: `step(to)` moves it, and routes and scripted movement are recorded. */
function walkingHydra(hp, at) {
  const npc = fakeHydra(hp);
  let tile = at;
  npc.routes = 0;
  npc.scripted = false;
  npc.getLocation = () => tile;
  npc.step = (to) => { tile = to; };
  npc.setScriptedMovement = (value) => { npc.scripted = value; };
  npc.getMovementQueue = () => ({ reset: () => {}, size: () => 0 });
  return npc;
}

function withPathFinder(npc, fn) {
  const before = Common.core.PathFinder;
  Common.core.PathFinder = { calculateWalkRoute: (who) => { if (who === npc) npc.routes += 1; } };
  try { return fn(); } finally { Common.core.PathFinder = before; }
}

test('flame special: it walks to the centre with its attacks paused, then stuns and breathes there', () => {
  const player = fakePlayer(1360, 10262);
  const npc = walkingHydra(400, loc(1370, 10256));
  const fight = new Fight(fakeLair(player), npc);
  fight.phase = 2;
  withPathFinder(npc, () => {
    fight.startFire(player);
    assert.equal(npc.scripted, true, 'combat waits while it walks');
    assert.ok(npc.routes >= 1, 'routed to the centre');
    fight.tick([player]);
    assert.equal(fight.walls.length, 0, 'no fire before it gets there');
    npc.step(Common.toLocation(Common.data.room.centre));
    fight.tick([player]);
  });
  assert.equal(npc.scripted, false, 'it has stopped');
  assert.equal(fight.flame, null);
  assert.equal(player.blocked, false, 'a tick for a following player to step in beside it');
  assert.equal(fight.pendingWalls?.length ?? 0, 0);
  fight.tick([player]);
  assert.ok(fight.pendingWalls.length > 0, 'the side fires are on their way');
  assert.equal(fight.trackers.length, 0);
  assert.ok(fight.launch, 'the tracking fire is due');
  assert.equal(player.blocked, true, 'stunned in place on arrival');
  assert.equal(npc.anims.at(-1).getId(), Common.ids.seqs.special[2]);
});

test('flame special: a player under the Hydra at the centre is pushed out', () => {
  const centre = Common.toLocation(Common.data.room.centre);
  const player = fakePlayer(centre.getX() + 2, centre.getY() + 2);
  const npc = walkingHydra(400, centre);
  const fight = new Fight(fakeLair(player), npc);
  fight.phase = 2;
  fight.breatheFire(player);
  assert.equal(Common.distanceToFootprint(player.getLocation(), npc), 1);
});

test('flame skip: turning enraged mid-special ends the walk and the tracking fire; lit walls stay', () => {
  const player = fakePlayer(1360, 10262);
  const npc = walkingHydra(400, Common.toLocation(Common.data.room.centre));
  const fight = new Fight(fakeLair(player), npc);
  fight.phase = 2;
  fight.breatheFire(player);
  fight.tickCount = fight.launch.at;
  fight.tickFire([player]);
  assert.equal(fight.trackers.length, 1);
  const lit = fight.walls.length;
  npc.step(loc(1370, 10256));
  withPathFinder(npc, () => fight.startFire(player));
  npc.hitpoints = 274;
  fight.checkPhase();
  assert.equal(fight.enraged, true);
  assert.equal(fight.flame, null);
  assert.equal(npc.scripted, false, 'its attacks carry on');
  assert.equal(fight.trackers.length, 0, 'the tracking fire stops');
  assert.equal(fight.walls.length, lit, 'walls already burning stay');
  fight.tick([player]);
  assert.equal(fight.walls.length, lit, 'and no new fire comes');
});

test('lured onto the blue vent while electric, it is weakened by the same spray as it turns to flame', () => {
  const player = fakePlayer(1356, 10276);
  const chat = [];
  const npc = fakeHydra(551);
  npc.forceChat = (text) => chat.push(text);
  npc.getLocation = () => loc(1356, 10273); // footprint 1356-1361 x 10273-10278: beside the blue vent (1362, 10272)
  const fight = new Fight(fakeLair(player), npc);
  fight.phase = 1;
  fight.shielded = true;
  fight.tickCount = Common.data.combat.ventEvery - 1;
  fight.tick([player]);
  assert.ok(fight.spraying());
  assert.equal(fight.empowered, true, 'the blue vent is the wrong one for the electric form');
  npc.hitpoints = 549;
  fight.tick([player]);
  assert.equal(fight.phase, 2);
  assert.equal(fight.shielded, false, 'the flame form loses its shield straight away');
  assert.deepEqual(chat, ['Roaaaaaaaaaaar!']);
  assert.equal(fight.reduce(40), 40);
});

test('a bind is the engine freeze timer: it runs out on its own, and a shorter one never cuts a longer one', () => {
  const { bind } = require('../plugins/bosses/alchemicalhydra/Fight.AlchemicalHydra');
  const player = fakePlayer();
  bind(player, 5);
  assert.equal(player.timers.get(core.TimerKey.FREEZE), 5);
  bind(player, 2);
  assert.equal(player.timers.get(core.TimerKey.FREEZE), 5);
  player.timers.set(core.TimerKey.FREEZE, 0);
  assert.equal(player.blocked, false, 'nothing else holds them once it runs out');
});

/** The guide's spot: the Hydra at the centre, the player beside its north-west corner. */
function atCentreWithCornerPlayer(x, y) {
  const centre = Common.toLocation(Common.data.room.centre);
  const player = fakePlayer(x, y);
  const npc = walkingHydra(400, centre);
  const fight = new Fight(fakeLair(player), npc);
  fight.phase = 2;
  return { player, npc, fight, centre };
}

test('by its north-west corner: north then west to the walls, clear of the Tile Packs melee tiles', () => {
  const { player, fight, centre } = atCentreWithCornerPlayer(1364, 10271); // "2, center"
  assert.deepEqual([centre.getX(), centre.getY()], [1364, 10265], 'its body covers 1364-1369 x 10265-10270');
  fight.breatheFire(player);
  const burning = (x, y) => fight.walls.some((w) => w.tile.getX() === x && w.tile.getY() === y);
  fight.tickCount += Common.data.fire.firstWallAfter;
  fight.tickFire([player]);
  assert.ok(burning(1365, 10272) && !burning(1362, 10269), 'north first, west not yet');
  fight.tickCount = fight.launch.at - 1;
  fight.tickFire([player]);
  assert.equal(burning(1356, 10267), false, 'the west stream is not at the wall yet');
  fight.tickCount = fight.launch.at;
  fight.tickFire([player]);
  assert.ok(burning(1356, 10267), "it reaches the wall at 'Skip when fire hits wall' as the tracking fire leaves");
  assert.equal(fight.trackers.length, 1);
  for (const [x, y, name] of [[1364, 10271, '2, center'], [1363, 10270, '3, skip'], [1363, 10271, 'the corner'], [1361, 10270, '4th attack']]) {
    assert.equal(burning(x, y), false, `${name} (${x}, ${y}) is clear`);
  }
  const [minX, , , maxY] = Common.data.room.bounds;
  for (let x = 1365; x <= 1369; x++) assert.ok(burning(x, 10272) && burning(x, maxY), `column ${x} burns north to the wall`);
  for (let y = 10265; y <= 10269; y++) assert.ok(burning(1363, y) && burning(minX, y), `row ${y} burns west to the wall`);
  assert.ok(fight.walls.every((w) => w.tile.getX() >= 1365 || w.tile.getY() <= 10269), 'nothing else');
});

test('the melee trap: stepping round the corner as it launches leaves the tracking fire stuck on its first tile', () => {
  const { player, fight } = atCentreWithCornerPlayer(1364, 10271);
  fight.breatheFire(player);
  fight.tickCount = fight.launch.at;
  fight.tickFire([player]);
  const [tracker] = fight.trackers;
  assert.deepEqual([tracker.x, tracker.y], [1364, 10271], 'it starts in front of its mouth, on the player');
  player.moveTo(loc(1363, 10270)); // the other green tile
  const hits = player.damage.length;
  for (let i = 0; i < 8; i++) { fight.tickCount += 1; fight.tickFire([player]); }
  assert.deepEqual([tracker.x, tracker.y], [1364, 10271], 'the diagonal past its corner is blocked');
  assert.equal(tracker.trapped, true);
  assert.equal(player.damage.length, hits, 'the player is never reached');
});

test('a tracking fire that is not trapped follows the player and burns them', () => {
  const { player, fight } = atCentreWithCornerPlayer(1364, 10271);
  fight.breatheFire(player);
  fight.tickCount = fight.launch.at;
  fight.tickFire([player]);
  player.moveTo(loc(1372, 10274)); // away from the Hydra, clear of both side fires
  for (let i = 0; i < 6; i++) { fight.tickCount += 1; fight.tickFire([player]); }
  assert.ok(player.damage.some((d) => d > Common.data.fire.burnDamage || d === 0) || player.damage.length > 0, 'it caught them');
  assert.ok(fight.burns.length > 0 || player.damage.filter((d) => d === Common.data.fire.burnDamage).length > 0, 'and they burn');
});

test("the video's skip: from the corner's diagonal tile to the tile beside it, the fire stays on its first tile", () => {
  const { player, fight } = atCentreWithCornerPlayer(1363, 10271); // "2. center", by the blue vent
  fight.breatheFire(player);
  fight.tickCount = fight.launch.at;
  fight.tickFire([player]);
  const [tracker] = fight.trackers;
  assert.deepEqual([tracker.x, tracker.y], [1363, 10271]);
  player.moveTo(loc(1363, 10270)); // "3. skip", beside the Hydra
  const hits = player.damage.length;
  for (let i = 0; i < 8; i++) { fight.tickCount += 1; fight.tickFire([player]); }
  assert.equal(tracker.trapped, true);
  assert.equal(player.damage.length, hits, 'the player is never reached');
});

test('a phase change before the side fires are out leaves the rest unlit', () => {
  const { player, npc, fight } = atCentreWithCornerPlayer(1364, 10271);
  fight.breatheFire(player);
  fight.tickCount += Common.data.fire.firstWallAfter;
  fight.tickFire([player]);
  const lit = fight.walls.length;
  npc.hitpoints = 274;
  fight.checkPhase();
  fight.tickCount += 10;
  fight.tickFire([player]);
  assert.equal(fight.walls.length, lit, 'the second stream never comes');
  assert.equal(fight.trackers.length, 0);
});

test('basic attacks are well-formed flights whose hits land with them (#1862)', (t) => {
  const Combat = require('../plugins/bosses/alchemicalhydra/Combat.AlchemicalHydra');
  const sent = [];
  t.mock.method(core.Projectile.prototype, 'sendProjectile', function () { sent.push(this); });
  for (const style of ['magic', 'ranged']) {
    for (const x of [1363, 1361, 1356]) {
      const npc = fakeHydra();
      npc.getAsNpc = () => npc;
      npc.getPrivateArea = () => null;
      npc.__hydraFight = { stopped: false, phase: 0, transitioning: () => false, nextAttack: () => style, counted: () => {} };
      const player = { getLocation: () => loc(x, 10265), getSize: () => 1, isPlayer: () => true, getIndex: () => 1 };
      const method = new (Combat.combatClass())();
      method.start(npc, player);
      const shot = sent.at(-1);
      assert.ok(shot.speed > shot.delay + 1, `${style} from ${x} is drawn as a flight`);
      assert.equal(method.delay, Math.ceil(shot.speed / 30), `${style} from ${x}`);
    }
  }
  // Within a tile the 1-tick hit's 30-cycle end is replaced by 35 + 10 (magic) / 5 (ranged) a tile.
  assert.equal(Combat.flightEnd('magic', 1), 45);
  assert.equal(Combat.flightEnd('ranged', 2), 45);
  assert.equal(Combat.flightEnd('magic', 4), 60);
});
