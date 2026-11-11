const test = require('node:test');
const assert = require('node:assert/strict');

const Simulator = require('../plugins/spp-bots/Simulator.SppBots');
const { planGear } = require('../plugins/spp-bots/Gear.SppBots');
const accounts = require('../plugins/spp-bots/data/accounts.json');
const training = require('../plugins/spp-bots/data/training.json');
const gear = require('../plugins/spp-bots/data/gear.json');

const { SKILL_INDEX, levelForXp, xpForLevel, combatLevel, rollProfile, simulate } = Simulator;
const skill = (name) => SKILL_INDEX.get(name);

function run(overrides, extra = {}) {
  const profile = rollProfile(accounts, overrides.seed ?? 42, overrides);
  return { profile, result: simulate({ profile, training, accounts, members: true, ...extra }) };
}

test('levels and xp follow the OSRS table', () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(83), 2);
  assert.equal(levelForXp(1154), 10);
  assert.equal(levelForXp(13_034_431), 99);
  assert.equal(xpForLevel(99), 13_034_431);
  assert.equal(combatLevel([1, 1, 1, 10, 1, 1, 1]), 3);
  assert.equal(combatLevel([99, 99, 99, 99, 99, 99, 99]), 126);
});

test('the same seed always makes the same account', () => {
  const a = run({ seed: 7, stage: 'mid' });
  const b = run({ seed: 7, stage: 'mid' });
  assert.deepEqual(a.profile, b.profile);
  assert.deepEqual(a.result, b.result);
});

test('later stages play longer and end stronger', () => {
  const totals = ['new', 'early', 'mid', 'late', 'endgame'].map((stage) => run({ seed: 3, stage, archetype: 'main' }).result.totalLevel);
  for (let i = 1; i < totals.length; i++) assert.ok(totals[i] > totals[i - 1], `${totals}`);
});

test('a skiller stays combat 3 and a pure keeps 1 Defence, even at endgame', () => {
  const skiller = run({ seed: 5, stage: 'endgame', archetype: 'skiller' }).result;
  assert.equal(skiller.combatLevel, 3);
  const pure = run({ seed: 5, stage: 'endgame', archetype: 'pure' }).result;
  assert.equal(pure.levels[skill('defence')], 1);
  assert.ok(pure.levels[skill('prayer')] <= 52);
});

test('a free world trains only free methods: members skills stay at 1', () => {
  const { result } = run({ seed: 9, stage: 'late', archetype: 'main' }, { members: false });
  for (const name of ['agility', 'herblore', 'thieving', 'slayer', 'farming', 'hunter', 'construction', 'fletching']) {
    assert.equal(result.levels[skill(name)], 1, name);
  }
});

test('quests are done only once their requirements are met, and in order', () => {
  const quests = [
    { key: 'a', members: false, questPoints: 1, length: 0, stats: [], quests: [], qp: 0, combat: 0, xp: [[skill('cooking'), 300]] },
    { key: 'b', members: false, questPoints: 2, length: 1, stats: [[skill('cooking'), 20]], quests: ['a'], qp: 1, combat: 0, xp: [] },
    { key: 'never', members: false, questPoints: 1, length: 0, stats: [[skill('agility'), 99]], quests: [], qp: 0, combat: 0, xp: [] },
    { key: 'pure-breaker', members: false, questPoints: 1, length: 0, stats: [], quests: [], qp: 0, combat: 0, xp: [[skill('defence'), 20000]] },
  ];
  const main = run({ seed: 11, stage: 'mid', archetype: 'main' }, { quests, members: false }).result;
  assert.ok(main.quests.includes('a') && main.quests.includes('b'));
  assert.ok(main.quests.indexOf('a') < main.quests.indexOf('b'));
  assert.ok(!main.quests.includes('never'));
  const pure = run({ seed: 11, stage: 'mid', archetype: 'pure' }, { quests, members: false }).result;
  assert.ok(!pure.quests.includes('pure-breaker'), 'a pure skips a quest that gives Defence xp');
});

function account(overrides) {
  const levels = Simulator.SKILLS.map((name) => overrides.levels?.[name] ?? 1);
  return { levels, combatLevel: 60, questNames: [], gp: 0, ironman: false, archetype: 'main', stage: 'mid', members: true, ...overrides, levels };
}

test('a new account keeps its starter kit and buys nothing', () => {
  const plan = planGear(gear, account({ stage: 'new', gp: 100000 }));
  assert.equal(plan.starterKit, true);
  assert.deepEqual(plan.equipment, {});
  assert.equal(plan.coins, 100000);
});

test('a main buys the best it can wield and afford; quest-locked items need the quest', () => {
  const levels = { attack: 60, defence: 45, woodcutting: 50, mining: 35, fishing: 45 };
  const rich = planGear(gear, account({ levels, gp: 5_000_000 }));
  assert.equal(rich.equipment.WEAPON_SLOT, 'RUNE_SCIMITAR', 'dragon weapons need their quests');
  assert.equal(rich.equipment.BODY_SLOT, 'RUNE_CHAINBODY', 'no rune platebody without Dragon Slayer I');
  const slayer = planGear(gear, account({ levels, gp: 5_000_000, questNames: ['Dragon Slayer I', 'Monkey Madness I'] }));
  assert.equal(slayer.equipment.BODY_SLOT, 'RUNE_PLATEBODY');
  assert.equal(slayer.equipment.WEAPON_SLOT, 'DRAGON_SCIMITAR');
  assert.ok(slayer.bank.some(([item]) => item === 'RUNE_AXE'));
  assert.ok(slayer.bank.some(([item]) => item === 'ADAMANT_PICKAXE'));
  const poor = planGear(gear, account({ levels, gp: 1000 }));
  assert.notEqual(poor.equipment.WEAPON_SLOT, 'RUNE_SCIMITAR', 'it cannot afford rune');
});

test('an ironman has only what its own skills or kills could get, and keeps its gp', () => {
  const levels = { attack: 70, defence: 70, smithing: 55, woodcutting: 61, mining: 60, slayer: 50 };
  const plan = planGear(gear, account({ levels, ironman: true, gp: 900_000, combatLevel: 90 }));
  assert.equal(plan.equipment.WEAPON_SLOT, 'MITHRIL_SCIMITAR', 'no whip below 85 Slayer, no rune below 90 Smithing');
  assert.equal(plan.equipment.BODY_SLOT, 'FIGHTER_TORSO');
  assert.ok(plan.bank.some(([item]) => item === 'DRAGON_AXE'), 'a dragon axe drop at combat 80+');
});

test('a skiller wears no combat gear', () => {
  const plan = planGear(gear, account({ archetype: 'skiller', levels: { woodcutting: 70 }, gp: 1_000_000 }));
  assert.deepEqual(plan.equipment, {});
  assert.ok(plan.bank.some(([item]) => item === 'RUNE_AXE'));
});

test('the planner climbs a ladder that stands on a blocked tile from the tile beside it', () => {
  const { planTravel, BLOCKED } = require('../plugins/agent/mcp/TravelRoutes.AgentMcp');
  const LOC = 0x100;
  // An open 5x5 floor at plane 0 with the ladder on (2, 2), and an open floor at plane 1.
  const getFlag = (x, y, z) => {
    if (x < 0 || y < 0 || x > 4 || y > 4) return BLOCKED;
    return z === 0 && x === 2 && y === 2 ? LOC : 0;
  };
  const ladder = { type: 'transports', from: [2, 2, 0], to: [2, 2, 1], menu: 'Climb-up Ladder', id: 1, ticks: 2 };
  const transportsAt = (x, y, z) => (x === 2 && y === 2 && z === 0 ? [ladder] : []);
  const route = planTravel({ from: { x: 0, y: 0, z: 0 }, to: { x: 4, y: 4, z: 1 }, getFlag, transportsAt });
  assert.ok(route, 'a route up exists');
  assert.ok(route.steps.some((step) => step.via === ladder), 'it takes the ladder');
  assert.ok(!route.steps.some((step) => step.z === 0 && step.x === 2 && step.y === 2), 'without standing on the blocked tile');
});

test('a travel search run a few tiles at a time finds the same route as planTravel', () => {
  const { planTravel, createTravelSearch, BLOCKED } = require('../plugins/agent/mcp/TravelRoutes.AgentMcp');
  // A 40x40 floor with a wall across it at y = 20, open only at x = 37.
  const getFlag = (x, y) => {
    if (x < 0 || y < 0 || x > 39 || y > 39) return BLOCKED;
    return y === 20 && x !== 37 ? BLOCKED : 0;
  };
  const options = { from: { x: 2, y: 2, z: 0 }, to: { x: 3, y: 35, z: 0 }, getFlag, transportsAt: () => [] };
  const whole = planTravel(options);
  const search = createTravelSearch(options);
  let runs = 0;
  while (!search.run(7)) runs += 1;
  assert.ok(runs > 10, 'it took several runs');
  assert.deepEqual(search.result, whole);
  assert.ok(whole.steps.some((step) => step.x === 37 && step.y === 20), 'through the gap');

  // An unreachable goal ends the search too (with no result), within the expansion cap.
  const shut = createTravelSearch({ ...options, getFlag: (x, y) => (y === 20 || x < 0 || y < 0 || x > 39 || y > 39 ? BLOCKED : 0) });
  while (!shut.run(50));
  assert.equal(shut.result, null);
  assert.equal(planTravel({ ...options, maxExpansions: 5 }), null);
});

test('a weighted search expands fewer tiles and still gets there; capped tells "too far" from "no way"', () => {
  const { createTravelSearch, BLOCKED } = require('../plugins/agent/mcp/TravelRoutes.AgentMcp');
  // A 200x200 floor with a long wall in the way.
  const getFlag = (x, y) => {
    if (x < 0 || y < 0 || x > 199 || y > 199) return BLOCKED;
    return x === 100 && y < 190 ? BLOCKED : 0;
  };
  const options = { from: { x: 10, y: 10, z: 0 }, to: { x: 190, y: 10, z: 0 }, getFlag, transportsAt: () => [] };
  const run = (extra) => {
    const search = createTravelSearch({ ...options, ...extra });
    search.run();
    return search;
  };
  const exact = run({});
  const weighted = run({ heuristicWeight: 2 });
  assert.ok(weighted.result, 'it gets there');
  assert.ok(weighted.expansions < exact.expansions, `${weighted.expansions} < ${exact.expansions}`);
  assert.ok(weighted.result.cost <= exact.result.cost * 2);
  assert.equal(exact.capped, false);
  assert.equal(run({ maxExpansions: 50 }).capped, true);
});

test('an isGoal search finds the nearest goal it can reach, not the nearest as the crow flies', () => {
  const { createTravelSearch, BLOCKED } = require('../plugins/agent/mcp/TravelRoutes.AgentMcp');
  // A 60x60 floor. Bank A (5,10) is 5 tiles away but walled in (a guild); bank B (30,5) is open.
  const walledIn = (x, y) => x >= 3 && x <= 7 && y >= 8 && y <= 12 && !(x === 5 && y === 10);
  const getFlag = (x, y) => (x < 0 || y < 0 || x > 59 || y > 59 || walledIn(x, y) ? BLOCKED : 0);
  const banks = new Set(['5,10', '30,5']);
  const search = createTravelSearch({
    from: { x: 5, y: 5, z: 0 }, getFlag, transportsAt: () => [],
    isGoal: (x, y, z) => z === 0 && banks.has(`${x},${y}`),
  });
  while (!search.run(100));
  const last = search.result.steps[search.result.steps.length - 1];
  assert.deepEqual([last.x, last.y], [30, 5]);

  // No goal in reach: done, no result, and only "capped" when it stopped at the cap.
  const none = createTravelSearch({ from: { x: 5, y: 5, z: 0 }, getFlag, transportsAt: () => [], isGoal: () => false });
  while (!none.run(500));
  assert.equal(none.result, null);
  assert.equal(none.capped, false);
});

test('after dying, a bot puts its kept gear back on and starts afresh; a skiller walks away from a fight', () => {
  const { defend } = require('../plugins/spp-bots/Defence.SppBots');
  const actions = { 1: ['Wield', null], 2: ['Wear'], 3: ['Eat'] };
  const clicks = [];
  const core = {
    CacheDefinitions: { getItem: (id) => ({ inventoryActions: actions[id] ?? [] }) },
    ItemActionPacketListener: { handleAction: (player, iface, itemId, slot, option, action) => clicks.push({ itemId, slot, action }) },
    EquipPacketListener: { equip: (player, itemId, slot) => clicks.push({ itemId, slot, action: actions[itemId].find((a) => a && /wield|wear/i.test(a)).toLowerCase() }) },
    CombatFactory: { inCombat: () => true },
    Skill: { HITPOINTS: 'hp' },
    Location: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } },
  };
  const item = (id) => ({ getId: () => id, getAmount: () => 1 });
  let resets = 0;
  let retaliate = true;
  const walks = [];
  const player = {
    isDyingReturn: () => false, getHitpoints: () => 10,
    getInventory: () => ({ getItems: () => [item(1), null, item(2), item(3)] }),
    getUsername: () => 'bot', getLocation: () => ({ getX: () => 10, getY: () => 10, getZ: () => 0 }),
    autoRetaliateReturn: () => retaliate, setAutoRetaliate: (value) => { retaliate = value; },
    getSkillManager: () => ({ getCombatLevel: () => 3, getCurrentLevel: () => 10, getMaxLevel: () => 10 }),
    getRunEnergy: () => 50, setRunning: () => {},
    getMovementQueue: () => ({ size: () => walks.length, requestWalk: (to) => walks.push(to) }),
    getCombat: () => ({ getAttacker: () => attacker, reset: () => {} }),
  };
  let attacker = null;
  const entry = { player, died: true, brain: { reset: () => { resets += 1; } }, bot: { profile: { archetype: 'skiller' } } };
  assert.equal(defend({ core }, entry, 1000), true);
  assert.deepEqual(clicks.map((c) => [c.itemId, c.action]), [[1, 'wield'], [2, 'wear']], 'the axe and the shield, not the food');
  assert.equal(entry.died, false);
  assert.equal(resets, 1);

  // A skiller attacked by anything leaves: auto retaliate off, a walk away, a new activity.
  attacker = { isNpc: () => true, getHitpoints: () => 5, getLocation: () => ({ getX: () => 9, getY: () => 10 }), getCurrentDefinition: () => ({ getCombatLevel: () => 2, getName: () => 'Rat' }) };
  assert.equal(defend({ core }, entry, 2000), true);
  assert.equal(retaliate, false);
  assert.equal(walks.length, 1);
  assert.ok(walks[0].x > 10, 'away from the rat');
  assert.equal(resets, 2);
});

test('the online target follows the day: the peak at peakHour, quietShare of it twelve hours later', () => {
  const { dailyTarget, hourWeight, favouriteHour } = require('../plugins/spp-bots/Schedule.SppBots');
  const at = (hour) => new Date(2026, 10, 9, hour, 0, 0).getTime();
  const config = { online: 200, quietShare: 0.5, peakHour: 20 };
  assert.equal(dailyTarget(config, 3, at(20)), 203);
  assert.equal(dailyTarget(config, 3, at(8)), 103);
  assert.ok(dailyTarget(config, 0, at(14)) > dailyTarget(config, 0, at(8)) && dailyTarget(config, 0, at(14)) < dailyTarget(config, 0, at(20)));
  assert.equal(dailyTarget({ ...config, quietShare: 1 }, 0, at(4)), 200, 'quietShare 1 keeps the count flat');
  assert.equal(hourWeight(20, 20), 4);
  assert.equal(hourWeight(23, 1), 2.5, 'across midnight');
  assert.equal(hourWeight(8, 20), 1);
  for (let i = 0; i < 100; i++) assert.ok(favouriteHour() >= 0 && favouriteHour() < 24);
});

test('supplies in a fight: a karambwan combo when low, brews then a restore, prayers by level, potions for points and energy', () => {
  const { supplyTick, newFight, wantedPrayers } = require('../plugins/spp-bots/Supplies.SppBots');
  const items = {
    1: { name: 'Shark', inventoryActions: ['Eat'] },
    2: { name: 'Cooked karambwan', inventoryActions: ['Eat'] },
    3: { name: 'Saradomin brew(4)', inventoryActions: ['Drink'] },
    4: { name: 'Super restore(4)', inventoryActions: ['Drink'] },
    5: { name: 'Prayer potion(4)', inventoryActions: ['Drink'] },
    6: { name: 'Stamina potion(4)', inventoryActions: ['Drink'] },
  };
  const used = [];
  const prayers = [];
  const core = {
    CacheDefinitions: { getItem: (id) => items[id] },
    ItemActionPacketListener: { handleAction: (player, iface, itemId) => used.push(items[itemId].name) },
    Skill: { HITPOINTS: 'hp', PRAYER: 'prayer' },
    CombatFactory: { getMethod: (mob) => ({ type: () => mob.style }) },
    PrayerHandler: {
      PRAYER_BY_CHILD: new Map([[23, 18], [24, 21], [35, 26], [34, 25], [17, 10], [36, 28]]),
      togglePrayer: (player, child) => { const id = new Map([[23, 18], [35, 26], [34, 25]]).get(child); if (id !== undefined) active[id] = !active[id]; prayers.push(child); },
    },
  };
  const active = [];
  const levels = { hp: [99, 99], prayer: [70, 70] };
  const player = {
    style: 0,
    getInventory: () => ({ getItems: () => inventory.map((id) => (id ? { getId: () => id, getAmount: () => 1 } : null)) }),
    getSkillManager: () => ({ getCurrentLevel: (s) => levels[s][0], getMaxLevel: (s) => levels[s][1] }),
    getRunEnergy: () => energy,
    getPrayerActive: () => active,
  };
  let inventory = [1, 2, 3, 3, 3, 4, 5, 6];
  let energy = 100;
  const attacker = { style: 0 };
  const fight = Object.assign(newFight(() => 0.5), { boosted: true });

  levels.hp[0] = 30; // under comboAt
  assert.equal(supplyTick(core, player, fight, attacker), 'combo');
  assert.deepEqual(used.splice(0), ['Shark', 'Cooked karambwan']);
  assert.ok(active[18] && active[26], 'protect from melee and piety at 70 prayer');

  inventory = [3, 3, 4];
  levels.hp[0] = 50;
  supplyTick(core, player, fight, attacker);
  supplyTick(core, player, fight, attacker);
  levels.hp[0] = 99;
  assert.equal(supplyTick(core, player, fight, attacker), 'restore', 'a super restore after two brews');
  assert.deepEqual(used.splice(0), ['Saradomin brew(4)', 'Saradomin brew(4)', 'Super restore(4)']);

  inventory = [5, 6];
  levels.prayer[0] = 5;
  assert.equal(supplyTick(core, player, fight, attacker), 'prayer');
  levels.prayer[0] = 70;
  energy = 5;
  assert.equal(supplyTick(core, player, fight, attacker), 'energy');
  assert.deepEqual(used.splice(0), ['Prayer potion(4)', 'Stamina potion(4)']);

  // By level: 45 prayer has protect from magic and mystic might, not augury; 30 has no protection.
  const none = { unavailable: new Set() };
  assert.deepEqual(wantedPrayers(player, none, 'magic', 'magic', 45), [16, 20]);
  assert.deepEqual(wantedPrayers(player, none, 'melee', 'ranged', 30), [11]);
});

test('three styles: the main one is worn (with its ammo), the others trained to 20+ are banked; supplies by level', () => {
  const { mainStyle } = require('../plugins/spp-bots/Gear.SppBots');
  const rich = { gp: 50_000_000, members: true, questNames: ['Animal Magnetism'] };
  const ranger = planGear(gear, account({ ...rich, levels: { ranged: 75, attack: 40, strength: 40, defence: 70, magic: 60, prayer: 45, hitpoints: 75 } }), () => 0.5);
  assert.equal(mainStyle({ levels: Simulator.SKILLS.map((name) => ({ ranged: 75, attack: 40 })[name] ?? 1) }), 'ranged');
  assert.ok(['TWISTED_BOW', 'ARMADYL_CROSSBOW', 'MAGIC_SHORTBOW_I_'].includes(ranger.equipment.WEAPON_SLOT), ranger.equipment.WEAPON_SLOT);
  assert.ok(Array.isArray(ranger.equipment.AMMUNITION_SLOT) && ranger.equipment.AMMUNITION_SLOT[1] > 0, 'arrows or bolts worn');
  assert.equal(ranger.equipment.CAPE_SLOT, 'AVAS_ACCUMULATOR');
  const banked = new Set(ranger.bank.map(([item]) => item));
  assert.ok(banked.has('MYSTIC_FIRE_STAFF') || banked.has('FIRE_BATTLESTAFF'), 'a magic set in the bank');
  assert.ok([...banked].some((item) => /SCIMITAR|LONGSWORD|SWORD/.test(item)), 'a melee weapon in the bank');
  assert.ok(banked.has('PRAYER_POTION_4_') || banked.has('COOKED_KARAMBWAN'), 'some supplies');

  // A low ranger fires only what its bow can: a willow shortbow with mithril arrows at most.
  const low = planGear(gear, account({ gp: 100_000, levels: { ranged: 25, attack: 10 } }), () => 0.5);
  assert.equal(low.equipment.WEAPON_SLOT, 'WILLOW_SHORTBOW');
  assert.equal(low.equipment.AMMUNITION_SLOT[0], 'MITHRIL_ARROW');

  // A mage wears the staff and robes and banks its spell's runes; a skiller has no combat kit.
  const mage = planGear(gear, account({ ...rich, gp: 200_000_000, levels: { magic: 80, defence: 70, attack: 30 } }), () => 0.5);
  assert.equal(mage.equipment.WEAPON_SLOT, 'KODAI_WAND');
  assert.ok(mage.bank.some(([item]) => item === 'BLOOD_RUNE'), 'Water Wave runes');
  const skiller = planGear(gear, account({ ...rich, archetype: 'skiller', levels: { magic: 80 } }), () => 0.5);
  assert.equal(skiller.equipment.WEAPON_SLOT, undefined);
  assert.ok(!skiller.bank.some(([item]) => item === 'PRAYER_POTION_4_'));
});

test('tactics: the style that does most damage to the monster, and a special with a switch and back', () => {
  const { meleeDamage, bestFightType, specialTick } = require('../plugins/spp-bots/Tactics.SppBots');
  const levels = { attack: 70, strength: 70 };
  const bonuses = { attack: [80, 80, 80], strength: 80 };
  // A monster weak to crush, armoured against slash.
  const npc = { defence: 100, bonuses: [100, 200, -10, 0, 0] };
  assert.ok(meleeDamage(levels, bonuses, { type: 2, kind: 'AGGRESSIVE' }, npc) > meleeDamage(levels, bonuses, { type: 1, kind: 'AGGRESSIVE' }, npc));
  const strong = { attack: 99, strength: 99 };
  const strongBonuses = { attack: [80, 80, 80], strength: 120 };
  assert.ok(meleeDamage(strong, strongBonuses, { type: 2, kind: 'AGGRESSIVE' }, npc) > meleeDamage(strong, strongBonuses, { type: 2, kind: 'DEFENSIVE' }, npc), 'aggressive hits harder (31 vs 32 max)');

  const style = (name) => ({ name });
  const core = {
    Skill: { ATTACK: 'att', STRENGTH: 'str' },
    FightStyle: { ACCURATE: style('a'), AGGRESSIVE: style('g'), DEFENSIVE: style('d'), CONTROLLED: style('c') },
    Equipment: { WEAPON_SLOT: 3, SHIELD_SLOT: 5 },
  };
  const type = (child, bonusType, kind) => ({ getChildId: () => child, getBonusType: () => bonusType, getStyle: () => core.FightStyle[kind] });
  const types = { chop: type(0, 1, 'ACCURATE'), slash: type(1, 1, 'AGGRESSIVE'), lunge: type(2, 2, 'AGGRESSIVE'), block: type(3, 1, 'DEFENSIVE') };
  const fighter = {
    getCombat: () => ({ getAutocastSpell: () => null }),
    getWeapon: () => ({ getFightType: () => types }),
    getSkillManager: () => ({ getCurrentLevel: (s) => (s === 'att' ? 70 : 70) }),
    getBonusManager: () => ({ getAttackBonus: () => [80, 80, 80, 0, 0], getOtherBonus: () => [80] }),
  };
  const monster = { getCurrentDefinition: () => ({ getStats: () => [1, 1, 100] }), getDefenceBonus: (i) => [100, 200, -10, 0, 0][i] };
  assert.equal(bestFightType(core, fighter, monster), types.lunge, 'crush, aggressive');

  // Specials: worn whip (no special), a dragon dagger in the pack; 100% energy, 25% a special.
  const DDS = 1215, WHIP = 4151, SHIELD = 1201;
  const worn = { 3: WHIP, 5: SHIELD };
  const pack = [DDS];
  let energy = 100;
  let activated = false;
  const wields = [];
  Object.assign(core, {
    CombatSpecial: {
      getForWeaponId: (id) => (id === DDS ? { cost: 25 } : null),
      energyCost: (player, special) => special.cost,
      activate: () => { activated = !activated; },
    },
    CacheDefinitions: { getItem: () => ({ inventoryActions: ['Wield'] }) },
    EquipPacketListener: {
      equip: (player, itemId) => {
        wields.push(itemId);
        const slot = itemId === SHIELD ? 5 : 3;
        const off = worn[slot];
        worn[slot] = itemId;
        pack.splice(pack.indexOf(itemId), 1);
        if (off) pack.push(off);
        if (itemId === DDS && worn[5]) { pack.push(worn[5]); worn[5] = undefined; } // the bot's own test: a 2h-style switch
      },
    },
  });
  const bot = {
    getSpecialPercentage: () => energy,
    isSpecialActivated: () => activated,
    getEquipment: () => ({ getItems: () => Object.assign([], { 3: worn[3] && { getId: () => worn[3] }, 5: worn[5] && { getId: () => worn[5] } }) }),
    getInventory: () => ({ getItems: () => pack.map((id) => ({ getId: () => id })) }),
    getCombat: () => ({ getAutocastSpell: () => null, getTarget: () => attacking, attack: (npc) => { attacking = npc; } }),
  };
  let attacking = null;
  const target = { getHitpoints: () => 100 };
  const fight = {};
  assert.equal(specialTick(core, bot, fight, target, 0), 'switch');
  assert.equal(worn[3], DDS);
  assert.equal(specialTick(core, bot, fight, target, 600), 'special');
  assert.equal(activated, true);
  assert.equal(attacking, target, 'attacks again after the wield');
  // Specials land until there isn't the energy for another; then back to the whip and shield.
  activated = false; energy = 10;
  assert.equal(specialTick(core, bot, fight, target, 1200), 'switch back');
  assert.equal(worn[3], WHIP);
  assert.equal(worn[5], SHIELD);
  assert.equal(fight.spec, null);
});

test('loot rules: first match decides; junk never, coins, runes, clues and own ammo always; valuables by room', () => {
  const { decide } = require('../plugins/spp-bots/Loot.SppBots');
  const item = (name, value, kinds = [], held = false) => ({ name, value, kinds: new Set(kinds), held, key: null });
  assert.equal(decide(item('Bones', 999999), 28).take, false, 'junk, even if worth something');
  assert.equal(decide(item('Coins', 12, ['coins', 'stackable']), 0).take, false, 'a full pack takes no new stack');
  assert.equal(decide(item('Coins', 12, ['coins', 'stackable'], true), 0).take, true, 'but tops up one it carries');
  assert.equal(decide(item('Clue scroll (hard)', 0, ['clue']), 1).take, true);
  assert.equal(decide(item('Death rune', 2000, ['runes', 'stackable']), 2).take, true);
  assert.equal(decide(item('Rune arrow', 300, ['ammo', 'stackable']), 2).take, true);
  assert.equal(decide(item('Rune full helm', 21000), 1).take, true, 'a valuable item with one slot');
  assert.equal(decide(item('Mithril sword', 1100), 2).take, false, 'a decent item needs room for supplies');
  assert.equal(decide(item('Mithril sword', 1100), 6).take, true);
  assert.equal(decide(item('Grimy ranarr weed', 5000, ['noted', 'stackable']), 1).take, true);
  assert.equal(decide(item('Iron dagger', 30), 28).take, false, 'everything else stays');
  // A task's own rules come first.
  assert.equal(decide(item('Iron dagger', 30), 28, [{ take: true, match: { names: ['dagger'] } }]).take, true);
});

test('a monster praying against the bot\'s style makes it switch to a carried set, and attack again', () => {
  const { switchTick } = require('../plugins/spp-bots/Tactics.SppBots');
  const WHIP = 4151, BOW = 861, ARROWS = 892;
  const worn = { 3: WHIP };
  const pack = [BOW, ARROWS];
  let attacking = null;
  const core = {
    Skill: { ATTACK: 'att', STRENGTH: 'str', RANGED: 'rng', MAGIC: 'mag' },
    Equipment: { WEAPON_SLOT: 3, AMMUNITION_SLOT: 13 },
    CombatFactory: { getMethod: () => ({ type: () => (worn[3] === BOW ? 1 : 0) }) },
    ItemDefinition: { forId: (id) => ({ getName: () => ({ [WHIP]: 'Abyssal whip', [BOW]: 'Magic shortbow', [ARROWS]: 'Rune arrow' })[id] ?? '' }) },
    CacheDefinitions: { getItem: () => ({ inventoryActions: ['Wield'] }) },
    EquipPacketListener: { equip: (player, id) => { const slot = id === ARROWS ? 13 : 3; const off = worn[slot]; worn[slot] = id; pack.splice(pack.indexOf(id), 1); if (off) pack.push(off); } },
  };
  const player = {
    getCombat: () => ({ getAutocastSpell: () => null, getTarget: () => attacking, attack: (npc) => { attacking = npc; } }),
    getSkillManager: () => ({ getCurrentLevel: () => 80 }),
    getInventory: () => ({ getItems: () => pack.map((id) => ({ getId: () => id })), contains: (id) => pack.includes(id) }),
    getEquipment: () => ({ getItems: () => { const items = []; for (const [slot, id] of Object.entries(worn)) items[slot] = { getId: () => id, getAmount: () => 1 }; return items; } }),
  };
  let icon = 0; // protect from melee
  const npc = { getHeadIcon: () => icon, getId: () => 1, getHitpoints: () => 200, getCurrentDefinition: () => ({ getName: () => 'Demonic gorilla', getStats: () => [] }), getDefenceBonus: () => 0 };
  const sets = { melee: { style: 'melee', worn: { WEAPON_SLOT: WHIP } }, ranged: { style: 'ranged', worn: { WEAPON_SLOT: BOW }, ammo: { id: ARROWS } } };
  const fight = {};
  assert.equal(switchTick(core, player, fight, npc, sets, 0), 'ranged');
  assert.equal(worn[3], BOW);
  assert.equal(worn[13], ARROWS);
  assert.equal(attacking, npc, 'attacks again after the wield');
  icon = 1; // now it protects from missiles
  assert.equal(switchTick(core, player, fight, npc, sets, 600), null, 'not again within the gap');
  assert.equal(switchTick(core, player, fight, npc, sets, 2400), 'melee');
  assert.equal(worn[3], WHIP);
});

test('a search to an underground goal (y + 6400) goes by its ladder without exploring the whole surface', () => {
  const { createTravelSearch, BLOCKED } = require('../plugins/agent/mcp/TravelRoutes.AgentMcp');
  // A 300x300 surface and the dungeon 6400 north of it; a trapdoor at (150, 150) leads down.
  const inside = (x, y) => x >= 0 && x < 300 && ((y >= 0 && y < 300) || (y >= 6400 && y < 6700));
  const getFlag = (x, y) => (inside(x, y) ? 0 : BLOCKED);
  const trapdoor = { type: 'transports', menu: 'Climb-down Trapdoor', from: [150, 150, 0], to: [150, 6550, 0], ticks: 1 };
  const transportsAt = (x, y) => (x === 150 && y === 150 ? [trapdoor] : []);
  const search = createTravelSearch({ from: { x: 20, y: 20, z: 0 }, to: { x: 170, y: 6570, z: 0 }, getFlag, transportsAt, heuristicWeight: 2, maxExpansions: 20000 });
  search.run();
  assert.ok(search.result, `found in ${search.expansions} expansions`);
  assert.ok(search.result.steps.some((step) => step.via?.menu === 'Climb-down Trapdoor'), 'down the trapdoor');
});

test('a goal one network hop away but far off in map coordinates is found by the hop (shortcuts)', () => {
  const { createTravelSearch, BLOCKED } = require('../plugins/agent/mcp/TravelRoutes.AgentMcp');
  const { networkShortcuts } = require('../plugins/spp-bots/Shortcuts.SppBots');
  // The mainland (0-400 x 0-3000) and a city far north (y 6000-6100); a tree at (300, 100) hops there.
  const inside = (x, y) => x >= 0 && x < 400 && ((y >= 0 && y < 3000) || (y >= 6000 && y < 6100));
  const getFlag = (x, y) => (inside(x, y) ? 0 : BLOCKED);
  const hop = { type: 'spirit_tree', menu: 'Travel Spirit tree', from: [300, 100, 0], to: [200, 6050, 0], ticks: 13 };
  const hops = new Map([['tree', [hop]]]);
  const transportsAt = (x, y) => (x === 300 && y === 100 ? [hop] : []);
  const goal = { x: 210, y: 6060, z: 0 };
  const shortcuts = networkShortcuts(hops, goal);
  assert.deepEqual(shortcuts, [{ x: 300, y: 100, z: 0, cost: 23 }]);
  const options = { from: { x: 20, y: 20, z: 0 }, to: goal, getFlag, transportsAt, heuristicWeight: 2, maxExpansions: 60000 };
  const without = createTravelSearch(options);
  without.run();
  assert.equal(without.result, null, 'without shortcuts it heads north to the cap');
  const search = createTravelSearch({ ...options, shortcuts });
  search.run();
  assert.ok(search.result, `found in ${search.expansions} expansions`);
  assert.ok(search.result.steps.some((step) => step.via === hop), 'by the tree');
  // A hop that lands nowhere near the goal isn't a shortcut.
  assert.deepEqual(networkShortcuts(new Map([['far', [{ ...hop, to: [390, 10, 0] }]]]), goal), []);
});

test('gauntlet: a task that plays its own fights gets every tick from Defence, and the brain waits', () => {
  const { defend } = require('../plugins/spp-bots/Defence.SppBots');
  const ticks = [];
  const player = { getCombat: () => ({ getAttacker: () => null }) };
  const entry = { player, combatTask: { play: (p, nowMs) => (ticks.push(nowMs), true) } };
  assert.equal(defend({ core: { CombatFactory: { inCombat: () => false } } }, entry, 5), true);
  assert.deepEqual(ticks, [5]);
  assert.equal(entry.fight, undefined, 'no fight of its own started');
});

test('gauntlet: the Hunllef is prayed against by its attack in the air, then the style it switched to', () => {
  const { protectAgainst } = require('../plugins/spp-bots/GauntletPlay.SppBots');
  const seen = { seenAttacks: 0, seenStyle: null, inFlight: null };
  const fight = { attacks: 0, style: 'ranged', ticks: 0 };
  assert.equal(protectAgainst(fight, seen), 'ranged');
  // The fourth ranged attack thrown: it switches to magic the same tick, the arrow still flying.
  Object.assign(fight, { attacks: 4, style: 'magic', ticks: 20 });
  assert.equal(protectAgainst(fight, seen), 'ranged', 'the attack in the air');
  fight.ticks = 23;
  assert.equal(protectAgainst(fight, seen), 'ranged');
  fight.ticks = 25;
  assert.equal(protectAgainst(fight, seen), 'magic', 'landed: the next is magic');
  // A magic attack thrown: magic while it flies.
  Object.assign(fight, { attacks: 5, ticks: 25 });
  assert.equal(protectAgainst(fight, seen), 'magic');
});

test('gauntlet: the maze prayer is for the demi-boss over a strong monster, never a weak one', () => {
  const { mostDangerous } = require('../plugins/spp-bots/GauntletPlay.SppBots');
  const wolf = { tier: 'strong' }, dragon = { tier: 'demi' }, rat = { tier: 'weak' };
  assert.equal(mostDangerous([wolf, dragon]), dragon, 'the wolf hitting last makes no difference');
  assert.equal(mostDangerous([rat, wolf]), wolf);
  assert.equal(mostDangerous([rat]), null, 'points saved');
  assert.equal(mostDangerous([]), null);
});

test('training: monster areas come from the spawns, every method names a monster that spawns', () => {
  const { areasOf, skillOf, COMBAT_SKILLS } = require('../plugins/spp-bots/Training.SppBots');
  const cows = areasOf('Cow');
  const lumbridge = cows.find((area) => Math.abs(area.x - 3257) < 20 && Math.abs(area.y - 3266) < 20);
  assert.ok(lumbridge, 'the Lumbridge cow field is one area');
  assert.ok(lumbridge.count >= 5 && lumbridge.radius >= 6 && lumbridge.radius <= 16);
  for (const name of COMBAT_SKILLS) {
    const skill = skillOf(name);
    assert.ok(skill.methods.length > 0, `${name} has methods`);
    for (const method of skill.methods) {
      assert.ok(areasOf(method.monster).length > 0, `${name}: ${method.monster} spawns somewhere`);
      assert.ok(method.from < method.to, `${name}: ${method.monster} band`);
    }
    // Every level 1-98 has a method.
    for (let level = 1; level < 99; level++) {
      assert.ok(skill.methods.some((method) => method.from <= level && level < method.to && !method.members && !method.items), `${name} ${level}: a free method with no items`);
    }
  }
});

test('a prayer guest leaves by the garden exit portal, not a teleport portal that has Enter too', () => {
  const { exitPortal } = require('../plugins/spp-bots/HousePrayer.SppBots');
  const object = (id, x, y) => ({ getId: () => id, getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 1 }) });
  // The chapel's neighbour: an Ardougne portal (13633) two tiles off; the exit portal (4525) across the garden.
  const area = { furnitureObjects: [object(13633, 6432, 6435), object(4525, 6417, 6436)], extraObjects: [] };
  const player = { getPrivateArea: () => area, getLocation: () => ({ getX: () => 6432, getY: () => 6437, getZ: () => 1 }) };
  const core = { CacheDefinitions: { getLocId: (name) => (name === 'poh_exit_portal' ? 4525 : null) } };
  assert.equal(exitPortal(core, player).getId(), 4525);
  // No lookup in the cache: the known id.
  assert.equal(exitPortal({}, player).getId(), 4525);
  // Outside a house there is none.
  assert.equal(exitPortal(core, { getPrivateArea: () => null }), null);
});

test('task generator: tasks from the spawns, no bosses, dragons or Wilderness; the same every time; all pass the checker', () => {
  const TaskGen = require('../plugins/spp-bots/TaskGen.SppBots');
  const { tasks } = TaskGen.generateTasks();
  const again = TaskGen.generateTasks().tasks;
  assert.deepEqual(Object.keys(again), Object.keys(tasks));
  const list = Object.values(tasks);
  assert.ok(list.length > 500, `${list.length} tasks`);
  const names = new Set(list.map((t) => t.monster.toLowerCase()));
  for (const boss of ['zulrah', 'vorkath', 'general graardor', 'demonic gorilla', 'kalphite queen', 'green dragon']) assert.ok(!names.has(boss), boss);
  for (const t of list) {
    const y = t.area.y > 6400 ? t.area.y - 6400 : t.area.y;
    assert.ok(!(t.area.x >= 2944 && t.area.x < 3392 && y >= 3520 && y < 3968), `${t.monster} in the Wilderness`);
    assert.ok(t.count >= TaskGen.MIN_SPAWNS && t.area.x < 6400);
    assert.ok(t.combat[0] <= t.combat[1]);
    assert.deepEqual(TaskGen.checkTask(t), [], `${t.monster} @ ${t.area.x},${t.area.y}`);
  }
  // The game's names, not the Wiki's: the Ardougne "Warrior woman", not "Warrior".
  assert.ok(list.some((t) => t.monster === 'Warrior woman'));
  const cows = list.find((t) => t.monster === 'Cow' && Math.abs(t.area.x - 3257) < 20 && Math.abs(t.area.y - 3266) < 20);
  assert.ok(cows && cows.food === 0 && cows.combat[0] === 3, 'the Lumbridge cows, no food');
  const giants = list.find((t) => t.monster === 'Hill Giant');
  assert.ok(giants.food > 0 && giants.combat[0] > 3);
});

test('task checker: a wrong area, an unknown monster, style or item; the hand-written tasks are fine', () => {
  const TaskGen = require('../plugins/spp-bots/TaskGen.SppBots');
  const { TASKS } = require('../plugins/spp-bots/CombatTask.SppBots');
  const core = { ItemIds: { BRASS_KEY: 983 }, Wilderness: { levelAt: (x, y) => (y >= 3520 && y < 3968 && x >= 2944 && x < 3392 ? Math.floor((y - 3520) / 8) + 1 : 0) } };
  for (const [id, task] of Object.entries(TASKS)) {
    const errors = TaskGen.checkTask(task, { core }).filter((p) => p.level === 'error');
    assert.deepEqual(errors, [], id);
  }
  const what = (task) => TaskGen.checkTask(task, { core }).map((p) => p.what).join(' | ');
  assert.match(what({ ...TASKS.cows, area: { x: 3100, y: 3100, z: 0, radius: 5 } }), /no Cow spawns in the area/);
  assert.match(what({ ...TASKS.cows, monster: 'Nothing at all' }), /doesn't spawn anywhere/);
  assert.match(what({ ...TASKS.cows, style: 'fists' }), /unknown style/);
  assert.match(what({ ...TASKS.cows, items: ['NO_SUCH_KEY'] }), /unknown item/);
  assert.match(what(TASKS.green_dragons), /Wilderness/);
  // Reach, once a run is in: an area no spawn of which the run got to.
  const reach = { lastReach: () => ({ forward: { has: () => false } }), near: () => false };
  assert.match(TaskGen.checkTask(TASKS.cows, { core, reach }).map((p) => p.what).join(), /reach run didn't get/);
});

test('task picker: only tasks the bot can do (level, set, items, members), suited to its level', () => {
  const TaskGen = require('../plugins/spp-bots/TaskGen.SppBots');
  const ids = { IRON_SCIMITAR: 1323, RUNE_SCIMITAR: 1333, BRASS_KEY: 983 };
  const item = (id, amount = 1) => ({ getId: () => id, getAmount: () => amount });
  const bot = (combat, items, at = [3222, 3219]) => ({
    getSkillManager: () => ({ getCombatLevel: () => combat, getMaxLevel: () => Math.min(99, combat), getCurrentLevel: () => combat }),
    getBank: () => ({ getItems: () => items.map((id) => item(id)) }),
    getInventory: () => ({ getItems: () => [] }),
    getEquipment: () => ({ getItems: () => [] }),
    getLocation: () => ({ getX: () => at[0], getY: () => at[1], getZ: () => 0 }),
  });
  const core = { ItemIds: ids, Skill: { ATTACK: 0, DEFENCE: 1, STRENGTH: 2, HITPOINTS: 3, RANGED: 4, PRAYER: 5, MAGIC: 6, SLAYER: 18 }, Bank: { TOTAL_BANK_TABS: 1 }, Wilderness: { levelAt: () => 0 } };
  const opts = { members: false, reach: false };
  const novice = bot(5, [ids.IRON_SCIMITAR]);
  const pick = TaskGen.pickTask(core, novice, { ...opts, random: () => 0 });
  assert.ok(pick, 'a task for a level 5');
  assert.ok(pick.task.level <= 10, `${pick.task.monster} level ${pick.task.level}`);
  // Nothing to fight with: no task.
  assert.equal(TaskGen.pickTask(core, bot(60, []), opts), null);
  const hillGiants = { monster: 'Hill Giant', area: { x: 3111, y: 9841, z: 0, radius: 16 }, style: 'auto', kills: 10, items: ['BRASS_KEY'] };
  assert.equal(TaskGen.canDo(core, bot(40, [ids.RUNE_SCIMITAR]), hillGiants, opts).why, 'needs BRASS_KEY');
  assert.ok(TaskGen.canDo(core, bot(40, [ids.RUNE_SCIMITAR, ids.BRASS_KEY]), hillGiants, opts).ok);
  assert.match(TaskGen.canDo(core, bot(10, [ids.RUNE_SCIMITAR, ids.BRASS_KEY]), hillGiants, opts).why, /combat 10 </);
  // A members task on a free world.
  const members = Object.values(TaskGen.generatedTasks()).find((t) => t.members && t.combat[0] <= 40 && t.combat[1] >= 40);
  assert.equal(TaskGen.canDo(core, bot(40, [ids.RUNE_SCIMITAR]), members, opts).why, 'members');
  // A level-90 bot gets nothing for chickens.
  const high = TaskGen.pickTask(core, bot(90, [ids.RUNE_SCIMITAR]), { ...opts, members: true, random: () => 0 });
  assert.ok(high && high.task.level >= 40, `${high?.task.monster} ${high?.task.level}`);
});

test('hazards: off a tile something is landing on, onto a form\'s safespot; protection by form or by the last projectile', () => {
  const Hazards = require('../plugins/spp-bots/Hazards.SppBots');
  const loc = (x, y, z = 0) => ({ getX: () => x, getY: () => y, getZ: () => z });
  const area = { getObjects: () => [] };
  const walks = [];
  const player = {
    getLocation: () => loc(2268, 3068), getPrivateArea: () => area, playsAsPlayer: () => true, isPlayer: () => true,
    getMovementQueue: () => ({ requestWalk: (to) => walks.push([to.x, to.y]) }),
  };
  const core = {
    Location: function Location(x, y, z) { this.x = x; this.y = y; this.z = z; },
    RegionManager: { getClipping: () => 0, BLOCKED_MASK: 0x100 },
    World: { getNpcs: () => ({ forEach() {} }) },
  };
  const named = (name, id) => ({ getId: () => id, getCurrentDefinition: () => ({ getName: () => name }), getLocation: () => loc(2266, 3073) });
  // A venom cloud (1045, 3x3) lands on the bot's tile: it steps out, beyond the cloud's edge.
  Hazards.onShot({ projectileId: 1045, end: loc(2268, 3068), privateArea: area, landsInTicks: 2 });
  assert.ok(Hazards.dangerous(2269, 3069, 0, area), 'the 3x3 around it');
  assert.ok(!Hazards.dangerous(2268, 3068, 0, null), 'not in another instance');
  const entry = { player };
  assert.equal(Hazards.dodgeTick(core, entry, named('Zulrah', 2042), Date.now()), true);
  const [x, y] = walks.pop();
  assert.ok(Math.max(Math.abs(x - 2268), Math.abs(y - 3068)) >= 2, `to ${x},${y}`);
  // Waits for the walk before asking again.
  assert.equal(Hazards.dodgeTick(core, entry, named('Zulrah', 2042), Date.now()), true);
  assert.equal(walks.length, 0);
  // The red form: to the nearest pillar safespot (the clouds are gone in another instance).
  const clear = { player: { ...player, getPrivateArea: () => null } };
  assert.equal(Hazards.dodgeTick(core, clear, named('Zulrah', 2043), Date.now()), true);
  assert.deepEqual(walks.pop(), [2272, 3072]);
  // Protection: Zulrah by its form; the Hunllef by what it last threw (magic 1707, ranged 1711).
  assert.equal(Hazards.protectFor(named('Zulrah', 2044)), 'magic');
  const hunllef = named('Crystalline Hunllef', 9021);
  // Nothing thrown yet: the style it opens with (firstStyle).
  assert.equal(Hazards.protectFor(hunllef, player), 'ranged');
  Hazards.onFiredAt({ projectileId: 1707, target: player });
  assert.equal(Hazards.protectFor(hunllef, player), 'magic');
  Hazards.onFiredAt({ projectileId: 1711, target: player });
  assert.equal(Hazards.protectFor(hunllef, player), 'ranged');
  Hazards.onFiredAt({ projectileId: 1707, target: player });
  assert.equal(Hazards.protectFor(hunllef, player), 'magic');
  // A tornado (9025) next to the bot makes its tile dangerous.
  const tornado = { getId: () => 9025, getPrivateArea: () => area, getLocation: () => loc(2280, 3080) };
  const near = { ...player, getLocation: () => loc(2281, 3080) };
  const local = Hazards.localHazards({ World: { getNpcs: () => ({ forEach: (fn) => fn(tornado) }) } }, near);
  assert.ok(Hazards.dangerous(2281, 3080, 0, area, Date.now(), local));
  // Under a big monster's body (the Hunllef, 5x5 from its corner): off it, and never onto it.
  const body = { player: { ...player, getPrivateArea: () => null, getLocation: () => loc(2300, 3002) } };
  const big = { ...named('Crystalline Hunllef', 9021), getLocation: () => loc(2298, 3000), size: () => 5 };
  assert.equal(Hazards.dodgeTick(core, body, big, Date.now()), true);
  const [bx, by] = walks.pop();
  assert.ok(bx < 2298 || bx > 2302 || by < 3000 || by > 3004, `off the body, to ${bx},${by}`);
});

test('hazards: a dodge keeps the monster targeted and walks as the combat\'s own movement; with time, it swings first', () => {
  const Hazards = require('../plugins/spp-bots/Hazards.SppBots');
  const loc = (x, y, z = 0) => ({ getX: () => x, getY: () => y, getZ: () => z });
  const area = { getObjects: () => [] };
  const calls = [];
  let target = null;
  let delay = 3;
  const combat = {
    getTarget: () => target, getAttackDelay: () => delay,
    attack: (npc) => { target = npc; calls.push('attack'); },
    preserveMovementForTicks: (ticks) => calls.push(`preserve ${ticks}`),
  };
  const player = {
    getLocation: () => loc(2100, 5600), getPrivateArea: () => area, getCombat: () => combat,
    getMovementQueue: () => ({ reset: () => calls.push('reset'), requestWalk: () => calls.push('plain walk') }),
  };
  const core = {
    Location: function Location(x, y, z) { this.x = x; this.y = y; this.z = z; },
    RegionManager: { getClipping: () => 0, BLOCKED_MASK: 0x100 },
    World: { getNpcs: () => ({ forEach() {} }) },
    PathFinder: { calculateWalkRoute: (p, x, y) => calls.push(`route ${x},${y}`) },
  };
  const gorilla = { getId: () => 7144, getHitpoints: () => 300, getCurrentDefinition: () => ({ getName: () => 'Demonic gorilla' }), getLocation: () => loc(2103, 5600) };
  // A boulder landing on it in 3 ticks, the attack not ready: off, the gorilla targeted first.
  Hazards.onShot({ projectileId: 856, end: loc(2100, 5600), privateArea: area, landsInTicks: 3 });
  const entry = { player };
  assert.equal(Hazards.dodgeTick(core, entry, gorilla, Date.now()), true);
  assert.deepEqual(calls.slice(0, 2), ['attack', 'reset']);
  assert.ok(calls[2].startsWith('route '), calls[2]);
  assert.ok(calls[3].startsWith('preserve '), 'the walk is the combat\'s own, after the target');
  assert.ok(!calls.includes('plain walk'));
  // Held off the tile: still targeted, no walk back.
  calls.length = 0;
  target = null;
  assert.equal(Hazards.dodgeTick(core, entry, gorilla, Date.now()), true);
  assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['attack', 'preserve']);
  // Another boulder, the attack ready and 3 ticks to the landing: it swings first.
  delay = 0;
  const fresh = { player };
  Hazards.onShot({ projectileId: 856, end: loc(2100, 5600), privateArea: area, landsInTicks: 4 });
  assert.equal(Hazards.dodgeTick(core, fresh, gorilla, Date.now()), false);
});

test('zulrah: the rotation is told from the phases seen, and each phase has the Wiki chart\'s stand spot', () => {
  const { planFor, tailSafeNear, STAND, PLANS } = require('../plugins/spp-bots/ZulrahPlay.SppBots');
  const { ROTATIONS } = require('../plugins/bosses/zulrah/Rotations.Zulrah');
  // A spot per phase: the opening and each of the rotation's phases.
  PLANS.forEach((plan, r) => assert.equal(plan.length, ROTATIONS[r].length + 1, `rotation ${r}`));
  // The pillar spots are the server's tail-safe tiles.
  assert.deepEqual(STAND.PILLAR_WEST_INSIDE, { x: 2264, y: 3072 });
  assert.deepEqual(STAND.PILLAR_WEST_OUTSIDE, { x: 2263, y: 3072 });
  assert.deepEqual(STAND.PILLAR_EAST_INSIDE, { x: 2272, y: 3072 });
  assert.deepEqual(STAND.TOP_EAST, { x: 2274, y: 3077 }, 'the server\'s first-swing safe tile');
  const p = (at, form) => ({ at, form });
  let plan = planFor([p('middle', 'green')]);
  assert.deepEqual(plan.rotations, [0, 1, 2, 3]);
  assert.equal(plan.stand, 'TOP_EAST');
  assert.equal(plan.next, 'TOP_EAST', 'every rotation\'s second spot');
  // Middle red: a Crimson; A and B part on the next spot.
  plan = planFor([p('middle', 'green'), p('middle', 'red')]);
  assert.deepEqual(plan.rotations, [0, 1]);
  assert.equal(plan.next, null);
  // South green fourth: Crimson A.
  plan = planFor([p('middle', 'green'), p('middle', 'red'), p('middle', 'blue'), p('south', 'green')]);
  assert.deepEqual(plan.rotations, [0]);
  assert.equal(plan.stand, 'PILLAR_WEST_INSIDE');
  // East green second: Serp; its red third phase from TOP_WEST.
  plan = planFor([p('middle', 'green'), p('east', 'green')]);
  assert.deepEqual(plan.rotations, [2]);
  assert.equal(plan.next, 'TOP_WEST');
  // East blue second: Tanz.
  assert.deepEqual(planFor([p('middle', 'green'), p('east', 'blue')]).rotations, [3]);
  // Crimson A's Jad phase starts with ranged; Serp's with magic.
  const crimsonA = [p('middle', 'green'), ...ROTATIONS[0].map((ph) => p(ph.at, ph.form))];
  plan = planFor(crimsonA.slice(0, 9));
  assert.equal(plan.jad, 'ranged');
  assert.equal(plan.stand, 'TOP_WEST');
  const serp = [p('middle', 'green'), ...ROTATIONS[2].map((ph) => p(ph.at, ph.form))];
  assert.equal(planFor(serp.slice(0, 10)).jad, 'magic');
  // A rotation's last phase: it ends, and the closing is fought from TOP_EAST.
  plan = planFor(crimsonA);
  assert.equal(plan.ends, true);
  assert.equal(plan.next, 'TOP_EAST');
  // The red form: the tail-safe tile nearest the spot.
  assert.deepEqual(tailSafeNear(STAND.TOP_EAST), { x: 2273, y: 3072 });
  // The form to gear for while it dives: Serp's 5th phase (south green) after the west blue.
  const { nextForm } = require('../plugins/spp-bots/ZulrahPlay.SppBots');
  assert.equal(nextForm(serp.slice(0, 4)), 'green');
  assert.equal(nextForm(serp.slice(0, 5)), 'blue', 'its east blue next');
  assert.equal(nextForm([p('middle', 'green')]), null, 'the second phase unknown');
  assert.equal(nextForm(crimsonA), 'green', 'a rotation\'s end: the closing green');
});

test('zulrah: a tick of the fight walks to the spot with Zulrah targeted, prays for the form, switches for it', () => {
  const { createController, STAND } = require('../plugins/spp-bots/ZulrahPlay.SppBots');
  const { OPENING } = require('../plugins/bosses/zulrah/Rotations.Zulrah');
  const loc = (x, y) => ({ getX: () => x, getY: () => y, getZ: () => 0 });
  const calls = [];
  const steps = [];
  let target = null;
  const prayers = [];
  const core = {
    Skill: { HITPOINTS: 'hp', PRAYER: 'pray', ATTACK: 'a', STRENGTH: 's', RANGED: 'r', MAGIC: 'm' },
    RegionManager: { getClipping: () => 0, BLOCKED_MASK: 0x100, canProjectileMove: () => true },
    PathFinder: { calculateWalkRoute: (p, x, y) => calls.push(`route ${x},${y}`) },
    Location: class { constructor(x, y) { this.x = x; this.y = y; } getX() { return this.x; } getY() { return this.y; } getZ() { return 0; } },
    CacheDefinitions: { getItem: () => ({ name: '', inventoryActions: ['Wield'] }) },
    CombatFactory: { getMethod: () => ({ type: () => 1 }) },
    Equipment: { WEAPON_SLOT: 3, SHIELD_SLOT: 5, AMMUNITION_SLOT: 13 },
    EquipPacketListener: { equip: (p, id) => calls.push(`wield ${id}`) },
    PrayerHandler: { PRAYER_BY_CHILD: new Map([[1, 17], [2, 16]]), togglePrayer: (p, child) => { const id = child === 1 ? 17 : 16; prayers[id] = !prayers[id]; } },
    ItemDefinition: { forId: () => ({ getName: () => '' }) },
  };
  const player = {
    getLocation: () => loc(2268, 3068),
    getCombat: () => ({ getTarget: () => target, attack: (npc) => { target = npc; calls.push('attack'); }, preserveMovementForTicks: () => calls.push('preserve'), getAutocastSpell: () => null, getPoisonClock: () => null }),
    getMovementQueue: () => ({ reset: () => {}, size: () => 0, canWalkTo: () => true, addFirstStep: (t) => steps.push(t), addSteps: (t) => steps.push(t) }),
    getSkillManager: () => ({ getCurrentLevel: () => 70, getMaxLevel: () => 99 }),
    getInventory: () => ({ getItems: () => [{ getId: () => 12899, getAmount: () => 1 }], contains: () => false }),
    getEquipment: () => ({ getItems: () => [] }),
    getPrayerActive: () => prayers,
    getHitpoints: () => 99,
  };
  const zulrah = { getHitpoints: () => 500, isRegistered: () => true };
  const fight = { stage: 'fight', surfaced: true, attackable: true, phase: OPENING, zulrah, area: null, hazards: { clouds: [], snakelings: new Set() } };
  const sets = { ranged: { style: 'ranged', worn: { WEAPON_SLOT: 861 } }, magic: { style: 'magic', worn: { WEAPON_SLOT: 12899 } } };
  const controller = createController({ api: { core }, player, sets: () => sets });
  controller.tick(fight);
  assert.ok(calls.includes('wield 12899'), 'the trident for the green form');
  assert.ok(prayers[17], 'Protect from Missiles against the green form');
  assert.ok(calls.includes('attack'), 'Zulrah targeted for the walk');
  const last = steps[steps.length - 1];
  assert.deepEqual([last.getX(), last.getY()], [STAND.TOP_EAST.x, STAND.TOP_EAST.y], 'walked to the opening\'s spot');
  assert.deepEqual(controller.seen(), [{ at: 'middle', form: 'green' }]);
});

test('a style switch takes its armour too: the best carried or worn piece per slot by its bonuses; void as a set', () => {
  const { armourFor } = require('../plugins/spp-bots/Tactics.SppBots');
  const b = (o) => { const out = Array(14).fill(0); for (const [k, v] of Object.entries(o)) out[k] = v; return out; };
  const ITEMS = {
    1: { name: 'Bandos chestplate', slot: 4, bonuses: b({ 1: 0, 3: -15, 4: -10, 10: 4 }) },
    2: { name: 'Mystic robe top', slot: 4, bonuses: b({ 3: 20 }) },
    3: { name: "Black d'hide body", slot: 4, bonuses: b({ 4: 30 }) },
    4: { name: 'Occult necklace', slot: 2, bonuses: b({ 3: 12, 12: 10 }) },
    5: { name: 'Amulet of glory', slot: 2, bonuses: b({ 0: 10, 3: 10, 4: 10, 10: 6 }) },
    6: { name: 'Ahrim\'s hood', slot: 0, bonuses: b({ 3: 6 }), req: { 6: 70 } },
    7: { name: 'Dragon defender', slot: 5, bonuses: b({ 0: 25, 10: 6 }) },
  };
  const core = {
    Equipment: { HEAD_SLOT: 0, CAPE_SLOT: 1, AMULET_SLOT: 2, BODY_SLOT: 4, SHIELD_SLOT: 5, LEG_SLOT: 7, HANDS_SLOT: 9, FEET_SLOT: 10, RING_SLOT: 12 },
    Skill: { values: () => ['att', 'def', 'str', 'hp', 'rng', 'pray', 'mag'] },
    ItemDefinition: { forId: (id) => ({
      getName: () => ITEMS[id]?.name ?? '', getBonuses: () => ITEMS[id]?.bonuses ?? [],
      getEquipmentType: () => ({ getSlot: () => ITEMS[id]?.slot ?? -1 }),
      getRequirements: () => { const r = []; for (const [k, v] of Object.entries(ITEMS[id]?.req ?? {})) r[k] = v; return r; },
    }) },
  };
  const stack = (id) => ({ getId: () => id });
  let magicLevel = 99;
  const player = {
    getInventory: () => ({ getItems: () => [2, 3, 4, 6].map(stack) }),
    getEquipment: () => ({ getItems: () => [5, null, null, null, 1, 7].map((id) => (id ? stack(id) : null)) }),
    getSkillManager: () => ({ getMaxLevel: (skill) => (skill === 'mag' ? magicLevel : 99) }),
  };
  assert.deepEqual(armourFor(core, player, 'magic'), { HEAD_SLOT: 6, AMULET_SLOT: 4, BODY_SLOT: 2 }, 'the mystic top for the Bandos, the occult over the glory');
  assert.deepEqual(armourFor(core, player, 'ranged', true), { AMULET_SLOT: 5, BODY_SLOT: 3 }, 'two-handed: no shield');
  assert.equal(armourFor(core, player, 'melee').SHIELD_SLOT, 7);
  magicLevel = 60;
  assert.equal(armourFor(core, player, 'magic').HEAD_SLOT, undefined, 'a hood it lacks the Magic for');
  // Elite void (the cache's "Elite void top"/"robe"), the gloves and both helms carried: the
  // style's own helm with the set, though void pieces have no bonuses.
  Object.assign(ITEMS, {
    20: { name: 'Elite void top', slot: 4, bonuses: b({}) }, 21: { name: 'Elite void robe', slot: 7, bonuses: b({}) },
    22: { name: 'Void knight gloves (or)', slot: 9, bonuses: b({}) }, 23: { name: 'Void ranger helm', slot: 0, bonuses: b({}) },
    24: { name: 'Void mage helm', slot: 0, bonuses: b({}) },
  });
  player.getInventory = () => ({ getItems: () => [20, 21, 22, 23, 24].map(stack) });
  const ranged = armourFor(core, player, 'ranged');
  assert.deepEqual([ranged.HEAD_SLOT, ranged.BODY_SLOT, ranged.LEG_SLOT, ranged.HANDS_SLOT], [23, 20, 21, 22]);
  assert.equal(armourFor(core, player, 'magic').HEAD_SLOT, 24);
});

test('boost potions: forgotten brews and divine potions known, drunk again once the boost wears off', () => {
  const { supplies, boostTick } = require('../plugins/spp-bots/Supplies.SppBots');
  const names = { 1: 'Forgotten brew(4)', 2: 'Divine bastion potion(3)', 3: 'Ancient brew(2)', 4: 'Ranging potion(1)' };
  const used = [];
  let magic = 99;
  const core = {
    Skill: { MAGIC: 'mag', RANGED: 'rng', STRENGTH: 'str' },
    CacheDefinitions: { getItem: (id) => ({ name: names[id], inventoryActions: ['Drink'] }) },
    ItemActionPacketListener: { handleAction: (p, i, id) => used.push(id) },
  };
  const player = {
    getInventory: () => ({ getItems: () => [1, 2, 3, 4].map((id) => ({ getId: () => id, getAmount: () => 1 })) }),
    getSkillManager: () => ({ getCurrentLevel: (s) => (s === 'mag' ? magic : 99), getMaxLevel: () => 99 }),
  };
  const have = supplies(core, player);
  assert.deepEqual(have['boost:magic'].map((e) => e.itemId), [1, 3]);
  assert.deepEqual(have['boost:ranged'].map((e) => e.itemId), [2, 4]);
  const state = {};
  assert.equal(boostTick(core, player, 'magic', have, state, 0), true, 'unboosted: a dose');
  assert.deepEqual(used, [1]);
  magic = 110;
  assert.equal(boostTick(core, player, 'magic', have, state, 10000), false, 'still boosted');
  magic = 100;
  assert.equal(boostTick(core, player, 'magic', have, state, 3000), false, 'not again within the gap');
  assert.equal(boostTick(core, player, 'magic', have, state, 10000), true, 'worn off: again');
});

test('a player\'s kit: what they brought is restocked to; short with no food (under 3) or no prayer restore', () => {
  const { kitOf, kitShort } = require('../plugins/spp-bots/CombatTask.SppBots');
  const names = { 385: 'Shark', 2434: 'Prayer potion(4)', 139: 'Prayer potion(1)', 2552: 'Ring of dueling(8)', 12938: 'Zul-andra teleport', 12899: 'Trident of the Swamp' };
  const actions = { 385: ['Eat'], 2434: ['Drink'], 139: ['Drink'], 12938: ['Teleport'], 2552: ['Rub'], 12899: ['Wield'] };
  const gear = new Set([2552, 12899]);
  const core = {
    CacheDefinitions: { getItem: (id) => ({ name: names[id], inventoryActions: actions[id] ?? [] }) },
    ItemDefinition: { forId: (id) => ({ getEquipmentType: () => ({ getSlot: () => (gear.has(id) ? 3 : -1) }) }) },
  };
  let pack = [[385, 1], [385, 1], [385, 1], [385, 1], [2434, 1], [2434, 1], [2552, 1], [12938, 3], [12899, 1]];
  const player = { getInventory: () => ({ getItems: () => pack.map(([id, n]) => ({ getId: () => id, getAmount: () => n })) }) };
  const kit = kitOf(core, player);
  assert.deepEqual(kit.take, [{ item: 385, amount: 4 }, { item: 2434, amount: 2 }, { item: 12938, amount: 3 }], 'supplies and scrolls, not the gear');
  assert.ok(kit.names.has('ring of dueling') && kit.names.has('prayer potion'), 'its own: dose and charge left off');
  assert.equal(kitShort(core, player, kit), null);
  pack = [[385, 1], [385, 1], [139, 1], [2552, 1]];
  assert.equal(kitShort(core, player, kit), 'food', 'two sharks left of four');
  pack = [[385, 1], [385, 1], [385, 1], [2552, 1]];
  assert.equal(kitShort(core, player, kit), 'prayer');
  // Its boosting potions too.
  names[27629] = 'Forgotten brew(4)'; actions[27629] = ['Drink'];
  pack = [[385, 1], [385, 1], [385, 1], [2434, 1], [27629, 1]];
  const withBrew = kitOf(core, player);
  assert.equal(withBrew.boost, 1);
  pack = [[385, 1], [385, 1], [385, 1], [2434, 1]];
  assert.equal(kitShort(core, player, withBrew), 'boost potions');
});

test('geared up from where it stands: the worn weapon is the set, other styles in the pack are switches', () => {
  const { onHandSets, weaponStyle } = require('../plugins/spp-bots/CombatTask.SppBots');
  assert.equal(weaponStyle(12926).style, 'ranged'); // toxic blowpipe
  assert.equal(weaponStyle(12926).ammo, false); // darts are inside it
  assert.equal(weaponStyle(12006).style, 'melee'); // abyssal tentacle
  assert.equal(weaponStyle(861).ammo, true); // magic shortbow needs arrows
  const SLOT = { WEAPON_SLOT: 3, BODY_SLOT: 4, LEG_SLOT: 7, HEAD_SLOT: 0, SHIELD_SLOT: 5, FEET_SLOT: 10, HANDS_SLOT: 9, AMULET_SLOT: 2, CAPE_SLOT: 1, AMMUNITION_SLOT: 13 };
  const item = (id, amount = 1) => ({ getId: () => id, getAmount: () => amount });
  const names = { 12926: 'Toxic blowpipe', 12006: 'Abyssal tentacle', 12954: 'Dragon defender', 2434: 'Prayer potion(4)', 861: 'Magic shortbow' };
  const container = (list) => ({ getItems: () => list, contains: (id) => list.some((i) => i?.getId?.() === id) });
  const player = (wornList, packList) => ({
    getEquipment: () => container(wornList), getInventory: () => container(packList),
    getCombat: () => ({ getAutocastSpell: () => null }),
  });
  const core = { Equipment: SLOT, CacheDefinitions: { getItem: (id) => ({ name: names[id] ?? `item ${id}` }) }, ItemIds: {} };
  const worn = []; worn[3] = item(12926);
  const gorillas = { style: 'melee', switch: ['ranged'], food: 20 };
  // Cronky's setup: blowpipe worn, tentacle and defender in the pack, no food.
  const cronky = onHandSets(core, player(worn, [item(12006), item(12954), item(2434)]), gorillas);
  assert.equal(cronky.ok, true);
  assert.equal(cronky.main.style, 'ranged');
  assert.deepEqual(cronky.switches.map((set) => [set.style, set.worn.WEAPON_SLOT, set.worn.SHIELD_SLOT]), [['melee', 12006, 12954]]);
  // Only the blowpipe: the task wants melee too, so not ready (it banks for a set).
  assert.equal(onHandSets(core, player(worn, [item(2434)]), gorillas).ok, false);
  // A bow without arrows worn isn't ready; with them it is.
  const bow = []; bow[3] = item(861);
  assert.equal(onHandSets(core, player(bow, []), { style: 'auto' }).ok, false);
  bow[13] = item(892, 500);
  assert.equal(onHandSets(core, player(bow, []), { style: 'auto' }).ok, true);
});
