// Run after `yarn build`: node --test tests/wintertodt-bots.test.cjs
// The Wintertodt bots' choices (Bots.Wintertodt.js): who heals, how many come, and what a bot
// does next from what it can see, in the Wiki's order of a team's jobs.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const Shared = require('../plugins/minigames/wintertodt/Shared.Wintertodt');
const Bots = require('../plugins/minigames/wintertodt/Bots.Wintertodt');

const { roleFor, spawnsNeeded, decide, realPlayersAbout, EAT_WARMTH, LEAVE_WARMTH } = Bots._test;

/** A bot that is warm, healthy, idle and empty-handed, with `over` laid on top. */
const self = (over = {}) => ({
  warmth: 1000, hp: 90, maxHp: 90, food: 5, doses: 0, roots: 0, kindling: 0, free: 18,
  safe: false, action: null, ...over,
});
const corner = (over = {}) => ({ brazier: Shared.BRAZIER.LIT, pyromancerHealthy: true, ...over });
const feeder = { corner: 0, healer: false, fletcher: false };
const fletcher = { corner: 0, healer: false, fletcher: true };
const healer = { corner: 1, healer: true, fletcher: false };
const plan = (over) => decide({ self: self(), corner: corner(), downed: [], role: feeder, phase: 'gather', ...over }).action;

test('bots are dealt round the four corners, and every one brews its own potions and heals pyromancers (task play)', () => {
  const roles = Array.from({ length: 8 }, (_, i) => roleFor(i, () => 0.9));
  assert.deepEqual(roles.map((r) => r.corner), [0, 1, 2, 3, 0, 1, 2, 3]);
  assert.ok(roles.every((r) => r.brews && r.heals && !r.healer));
  assert.equal(roleFor(0, () => 0.1).fletcher, true);
  assert.equal(roleFor(0, () => 0.9).fletcher, false);
});

test('the whole crowd comes at once up to the target, and only real players in the camp or prison count', () => {
  assert.equal(spawnsNeeded(8, 0), 8);
  assert.equal(spawnsNeeded(8, 5), 3);
  assert.equal(spawnsNeeded(8, 8), 0);
  assert.equal(spawnsNeeded(0, 3), 0);
  const at = (x, y, bot = false) => ({ isPlayerBot: () => bot, getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }) });
  assert.equal(realPlayersAbout([at(1630, 3960), at(1630, 4000, true), at(3200, 3200)]).length, 1, 'the camp counts; bots and Lumbridge do not');
});

test('keeping warm comes first: a cake, else a potion, else out with nothing left', () => {
  assert.equal(plan({ self: self({ warmth: EAT_WARMTH - 1 }) }), 'eat');
  assert.equal(plan({ self: self({ hp: 40 }) }), 'eat', 'hurt by shrapnel or an area attack');
  assert.equal(plan({ self: self({ warmth: EAT_WARMTH - 1, food: 0, doses: 3 }) }), 'drink');
  assert.equal(plan({ self: self({ warmth: LEAVE_WARMTH - 1, food: 0 }) }), 'leave');
  assert.equal(plan({ self: self({ warmth: EAT_WARMTH - 1, food: 0 }) }), 'chop', 'cold but not freezing: keep working');
});

test('a broken brazier is fixed, an unlit one lit, but not while its pyromancer is down', () => {
  assert.equal(plan({ corner: corner({ brazier: Shared.BRAZIER.BROKEN }) }), 'fix');
  assert.equal(plan({ corner: corner({ brazier: Shared.BRAZIER.UNLIT }) }), 'light');
  assert.equal(plan({ corner: corner({ brazier: Shared.BRAZIER.UNLIT, pyromancerHealthy: false }) }), 'chop', 'gathers meanwhile');
});

test('chop until full, then fletchers cut kindling and everyone feeds until the fuel is gone', () => {
  assert.equal(plan({}), 'chop');
  assert.equal(plan({ self: self({ action: 'chop' }) }), 'busy');
  assert.equal(plan({ self: self({ roots: 18, free: 0 }), phase: 'burn' }), 'feed');
  assert.equal(plan({ self: self({ roots: 18, free: 0 }), phase: 'burn', role: fletcher }), 'fletch');
  assert.equal(plan({ self: self({ roots: 18, free: 0, safe: true }), phase: 'burn', role: fletcher }), 'feed', 'no fletching in the safe area (Wiki)');
  assert.equal(plan({ self: self({ kindling: 18, free: 0 }), phase: 'burn', role: fletcher }), 'feed');
  assert.equal(plan({ self: self({ roots: 4, free: 14 }), phase: 'burn' }), 'feed', 'a part-burnt load goes in before chopping again');
  assert.equal(plan({ self: self({ roots: 4, free: 14 }), phase: 'burn', corner: corner({ brazier: Shared.BRAZIER.UNLIT, pyromancerHealthy: false }) }), 'wait');
  assert.equal(plan({ self: self({ free: 0 }) }), 'wait', 'a full pack with no fuel in it never feeds nothing');
});

test('a healer picks only the herbs its concoctions need', () => {
  assert.equal(Bots._test.herbsWanted(0), 1);
  assert.equal(Bots._test.herbsWanted(1), 1);
  assert.equal(Bots._test.herbsWanted(5), 2);
});

test('the healer heals any downed pyromancer first, and keeps potions brewed', () => {
  const role = healer;
  assert.equal(decide({ self: self({ doses: 4, action: 'chop' }), corner: corner(), downed: [2], role, phase: 'gather' }).action, 'heal');
  assert.equal(decide({ self: self({ doses: 4 }), corner: corner(), downed: [2], role, phase: 'gather' }).corner, 2);
  assert.equal(decide({ self: self({ doses: 0 }), corner: corner(), downed: [2], role, phase: 'gather' }).action, 'brew');
  assert.equal(decide({ self: self({ doses: 4 }), corner: corner(), downed: [], role, phase: 'gather' }).action, 'chop', 'with potions to hand, it works its corner');
  assert.equal(plan({ downed: [2] }), 'chop', 'feeders leave the pyromancers to the healer');
});

test('a bot replays the Doors zone handlers as it crosses, as zone events do for players', () => {
  const Doors = require('../plugins/minigames/wintertodt/Doors.Wintertodt');
  const saved = { enteredPrison: Doors.enteredPrison, leftPrison: Doors.leftPrison, syncHud: Doors.syncHud };
  const calls = [];
  Doors.enteredPrison = () => calls.push('entered');
  Doors.leftPrison = () => calls.push('left');
  Doors.syncHud = () => calls.push('hud');
  try {
    let tile = [1630, 3960];
    const player = { getLocation: () => ({ getX: () => tile[0], getY: () => tile[1], getZ: () => 0 }) };
    const bot = new Bots._test.WintertodtBot(player, { corner: 0, healer: false, fletcher: false });
    bot.crossZones();
    bot.crossZones();
    tile = [1630, 3980];
    bot.crossZones();
    tile = [1630, 3960];
    bot.crossZones();
    tile = [3200, 3200];
    bot.crossZones();
    assert.deepEqual(calls, ['hud', 'entered', 'left', 'hud', 'hud'], 'the camp, in, out, then away: once each crossing');
  } finally {
    Object.assign(Doors, saved);
  }
});

test('one that brews its own makes a batch of four when low, and only then', () => {
  const brewer = { corner: 0, healer: false, brews: true, fletcher: false };
  assert.equal(plan({ role: brewer, self: self({ doses: 0 }), brewing: true }), 'brew');
  assert.equal(plan({ role: brewer, self: self({ doses: 0 }), brewing: false }), 'chop', 'not brewing: works');
  assert.equal(Bots._test.OWN_POTIONS, 4);
});

test('with a full pack it burns its fuel to make room before brewing, instead of clicking the crate', () => {
  const brewer = { corner: 0, healer: false, brews: true, fletcher: false };
  const full = self({ doses: 1, roots: 26, free: 0 });
  assert.equal(plan({ role: brewer, self: full, brewing: true, canBrew: false, phase: 'burn' }), 'feed', 'no room: feeds the brazier');
  assert.equal(plan({ role: brewer, self: self({ doses: 1, roots: 25, free: 1 }), brewing: true, canBrew: true, phase: 'burn' }), 'brew', 'a slot free: brews');
  const healer = { corner: 0, healer: true, fletcher: false };
  assert.equal(plan({ role: healer, self: full, canBrew: false, phase: 'burn' }), 'feed', 'a healer too');
});

test('the round left is its energy over the drain of the lit braziers', () => {
  const Round = require('../plugins/minigames/wintertodt/Round.Wintertodt');
  const Corners = require('../plugins/minigames/wintertodt/Corners.Wintertodt');
  const energy = Round.energy;
  const draining = Corners.isDraining;
  try {
    Round.energy = () => 350;
    Corners.isDraining = (index) => index < 2;
    assert.equal(Math.round(Bots._test.ticksLeft()), Math.round(350 / (2 * Shared.DRAIN_PER_PYROMANCER)));
    Corners.isDraining = () => false;
    assert.equal(Bots._test.ticksLeft(), Infinity, 'nothing draining it: no end in sight');
  } finally {
    Round.energy = energy;
    Corners.isDraining = draining;
  }
});

test('the falling snow: the tiles an area attack or a breaking brazier will hit are dangerous', () => {
  const Attacks = require('../plugins/minigames/wintertodt/Attacks.Wintertodt');
  const Corners = require('../plugins/minigames/wintertodt/Corners.Wintertodt');
  const centre = Attacks.brazierCentre(0);
  assert.equal(Attacks.isDangerous(centre.x + 2, centre.y), false);
  Corners.corner(0).brazierBreaking = true;
  try {
    assert.equal(Attacks.isDangerous(centre.x + 2, centre.y), true, 'within 2 of a breaking brazier');
    assert.equal(Attacks.isDangerous(centre.x + 3, centre.y), false, 'one more step is clear');
  } finally {
    Corners.corner(0).brazierBreaking = false;
  }
});

test('a downed pyromancer is healed by the one nearest bot with a dose, not all of them', () => {
  const Round = require('../plugins/minigames/wintertodt/Round.Wintertodt');
  const Corners = require('../plugins/minigames/wintertodt/Corners.Wintertodt');
  const { healerFor, playing } = Bots._test;
  const tile = Corners.corner(0).corner.pyromancer;
  const bot = (dx, doses) => ({
    player: {
      isRegistered: () => true, getHitpoints: () => 50,
      getLocation: () => ({ getX: () => tile.x + dx, getY: () => tile.y, getZ: () => 0 }),
      getInventory: () => ({ getItems: () => (doses > 0 ? [{ getId: () => Shared.ITEM.REJUVENATION_4, getAmount: () => doses }] : []) }),
    },
  });
  const inPrison = Round.inPrison;
  const before = [...playing];
  playing.clear();
  try {
    Round.inPrison = () => true;
    const far = bot(9, 1);
    const near = bot(2, 1);
    const nearest = bot(1, 0);
    for (const b of [far, near, nearest]) playing.add(b);
    assert.equal(healerFor(0), near, 'the nearest with a potion; the very nearest has none');
  } finally {
    Round.inPrison = inPrison;
    playing.clear();
    for (const b of before) playing.add(b);
  }
});
