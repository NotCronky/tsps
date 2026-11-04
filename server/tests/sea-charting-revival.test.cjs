// Real startup, boats, players, NPCs, hit queues and death tasks; only the network and RNG are controlled.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');
const { Server } = require('../dist/Server'); Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, effects, nextIndex = 2700;
let sparedNpc = null;
const deaths = [];
before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(ROOT);
  PluginManager.createApi('ChartingEarlierDeathObserverTest').onNpcBeforeDeath(event => {
    if (event.npc === sparedNpc) { event.preventDeath = true; event.npc.setHitpoints(1); }
  });
  PluginManager.loadFromDirectory(path.join(ROOT, 'plugins'));
  core = PluginManager.getCoreApi();
  new (require('../dist/game/definition/loader/impl/NpcDefinitionLoader').NpcDefinitionLoader)().load();
  core.RegionManager.init(); PluginManager.emitServerStartup({});
  effects = require('../plugins/skills/sailing/charting/DrinkEffects.Charting');
  core = PluginManager.getCoreApi();
  PluginManager.createApi('ChartingRevivalTest').onNpcDeath(event => deaths.push(event));
});
function ticks(n = 1) { for (let i = 0; i < n; i++) { core.World.processCycle++; core.TaskManager.process(); } }
function captain(t) {
  const player = new Player(null), messages = [];
  player.setIndex(nextIndex++); player.setRegistered(true); player.setUsername('Revival' + player.getIndex());
  player.getSession = () => ({ sendClientPacket() { return true; }, write() { return true; }, getChannel() { return null; } });
  player.setAttribute('bot-skip-persistence', true); player.sendMessage = text => messages.push(text);
  player.getSkillManager().setCurrentLevel(core.Skill.SAILING, 99); player.getSkillManager().setMaxLevel(core.Skill.SAILING, 99);
  core.Sailing.giveBoat(player, 'skiff', 'the_pandemonium'); assert.equal(core.Sailing.board(player, 'the_pandemonium'), null);
  const boat = core.Sailing.instanceAboard(player);
  t.after(() => { PluginManager.emitPlayerLogout({ player, username: player.getUsername() }); core.BoatManager.dispose(boat); player.setRegistered(false); });
  return { player, boat, messages };
}
function drink(f, key) {
  const id = core.CacheDefinitions.getObjId('sailing_charting_drink_crate_' + key);
  f.player.setAttribute('charting:drink-no-warning', true); f.player.getInventory().add(new core.Item(id));
  const slot = f.player.getInventory().getSlotForItemId(id);
  const { ClientConnection } = require('../dist/net/NetworkBuilder');
  ClientConnection.prototype.inventoryAction.call({ player: f.player }, { type: 'inventory_action', widgetId: core.CacheDefinitions.getComponentId('inventory:items'), slot, itemId: id, option: 'Drink' });
  ticks(2);
  return [...effects.effects.get(f.player).get('drink_crate_' + key).npcs][0];
}
function budget(t, n) { t.mock.method(core.Misc, 'randomInclusive', (min, max) => min === 0 && max === 9 ? n : max); }
function damage(npc, amounts, source) {
  npc.getCombat().getHitQueue().addPendingDamage(amounts.map(n => new core.HitDamage(n, core.HitMask.RED).setSource(source)));
  npc.getCombat().getHitQueue().process(++core.World.processCycle);
}
test('nine revival budget keeps same owned NPC, full HP, combat deadline and no death observers until final defeat', t => {
  budget(t, 9); const f = captain(t), npc = drink(f, 'corpse_reviver'), deck = npc.getArea();
  npc.getCombat().setAttackDelay(4);
  for (let i = 0; i < 9; i++) {
    damage(npc, [900], f.player);
    assert.equal(npc.getHitpoints(), 90); assert.equal(!!npc.isDyingFunction(), false);
    assert.equal(npc.getOwner(), f.player); assert.equal(npc.getArea(), deck); assert.equal(npc.isRegistered(), true);
    assert.equal(npc.getCombat().getTarget(), f.player); assert.equal(npc.getCombat().getAttackDelay(), Math.max(0, 3 - i));
    assert.equal(deaths.filter(e => e.npc === npc).length, 0);
  }
  assert.equal(f.messages.filter(s => s === 'The corpse seems to regenerate again!').length, 9);
  assert.equal(npc.getForcedChat(), 'Urrrrr...');
  npc.getCombat().addDamage(f.player, 90); damage(npc, [900], f.player); assert.equal(npc.isDyingFunction(), true);
  ticks(20); assert.equal(deaths.filter(e => e.npc === npc).length, 1);
  ticks(20); assert.equal(deaths.filter(e => e.npc === npc).length, 1);
});
test('zero budget permits ordinary death without any regeneration', t => {
  budget(t, 0); const f = captain(t), npc = drink(f, 'corpse_reviver'); damage(npc, [90], f.player);
  assert.equal(npc.getHitpoints(), 0); assert.equal(npc.isDyingFunction(), true); assert.equal(f.messages.includes('The corpse seems to regenerate again!'), false);
});
test('several lethal queued splats consume bounded lives then enter death once', t => {
  budget(t, 2); const f = captain(t), npc = drink(f, 'corpse_reviver'); damage(npc, [90, 90, 90, 90], f.player);
  assert.equal(f.messages.filter(s => s === 'The corpse seems to regenerate again!').length, 2);
  assert.equal(npc.getHitpoints(), 0); assert.equal(npc.isDyingFunction(), true);
});
test('revival lethal damage reports actual health lost to applied observers', t => {
  budget(t, 1); const f = captain(t), npc = drink(f, 'corpse_reviver'); const observed = [];
  npc.getCombat().getHitQueue().addPendingDamage([new core.HitDamage(90, core.HitMask.RED).onApplied(n => observed.push(n))]);
  npc.getCombat().getHitQueue().process(++core.World.processCycle);
  assert.deepEqual(observed, [90]); assert.equal(npc.getHitpoints(), 90);
});
for (const transition of ['logout', 'leave', 'teleport', 'replacement']) test(`${transition} invalidates corpse revival without affecting another owner's encounter`, t => {
  budget(t, 9); const f = captain(t), g = captain(t), npc = drink(f, 'corpse_reviver'), other = drink(g, 'corpse_reviver');
  if (transition === 'logout') PluginManager.emitPlayerLogout({ player: f.player, username: f.player.getUsername() });
  if (transition === 'leave') assert.equal(core.Sailing.disembark(f.player, 'the_pandemonium'), null);
  if (transition === 'teleport') core.BoatManager.teleport(f.boat, { fineX: 3000 * 128, fineY: 3000 * 128 });
  if (transition === 'replacement') drink(f, 'corpse_reviver');
  ticks(1); npc.setHitpoints(0);
  assert.equal(npc.isRegistered(), false); assert.equal(f.messages.includes('The corpse seems to regenerate again!'), false);
  damage(other, [90], g.player); assert.equal(other.getHitpoints(), 90); assert.equal(other.isRegistered(), true);
});
test('Dinky max51 is per-instance while protection prayer and ordinary accuracy still use shared combat', t => {
  const f = captain(t), npc = drink(f, 'fish_stoutier');
  t.mock.method(core.Misc, 'randomInclusive', (_min, max) => max);
  assert.equal(core.CombatFactory.rollHitDamage(npc, f.player, core.CombatType.MELEE).getDamage(), 51);
  const control = core.NPC.create(npc.getId(), npc.getLocation().clone());
  assert.notEqual(control.getCurrentDefinition().getMaxHit(), 51);
  f.player.getSkillManager().setMaxLevel(core.Skill.PRAYER, 99); f.player.getSkillManager().setCurrentLevel(core.Skill.PRAYER, 99);
  core.PrayerHandler.activatePrayerPrayerId(f.player, core.PrayerHandler.PROTECT_FROM_MELEE);
  assert.equal(core.CombatFactory.rollHitDamage(npc, f.player, core.CombatType.MELEE).getDamage(), 0);
});




test('actual pending combat hits revive then award final death to the real damage owner once', t => {
  budget(t, 1); const f = captain(t), npc = drink(f, 'corpse_reviver');
  const method = core.CombatFactory.getMethod(f.player), queue = npc.getCombat().getHitQueue();
  const first = new core.PendingHit(f.player, npc, method, { damage: 90, rollAccuracy: false, experience: false });
  queue.addPendingHit(first, ++core.World.processCycle); queue.process(core.World.processCycle);
  assert.equal(npc.getHitpoints(), 90); assert.equal(!!npc.isDyingFunction(), false);
  ticks(10); assert.equal(deaths.some(e => e.npc === npc), false);
  const last = new core.PendingHit(f.player, npc, method, { damage: 90, rollAccuracy: false, experience: false });
  queue.addPendingHit(last, ++core.World.processCycle); queue.process(core.World.processCycle);
  assert.equal(npc.isDyingFunction(), true); ticks(20);
  const events = deaths.filter(e => e.npc === npc); assert.equal(events.length, 1); assert.equal(events[0].killer, f.player);
});
test('existing preventDeath observers cannot spend a corpse life', t => {
  budget(t, 1); const f = captain(t), npc = drink(f, 'corpse_reviver');
  const state = effects.effects.get(f.player).get('drink_crate_corpse_reviver');
  sparedNpc = npc; t.after(() => { sparedNpc = null; });
  damage(npc, [90], f.player);
  assert.equal(npc.getHitpoints(), 1); assert.equal(state.corpse.remaining, 1);
  assert.equal(f.messages.includes('The corpse seems to regenerate again!'), false);
  sparedNpc = null;
  damage(npc, [90], f.player); assert.equal(npc.getHitpoints(), 90);
});
test('actual damage observers retain overkill caps, mitigation, dead, locked HP and developer damage rules', t => {
  const f = captain(t), npc = drink(f, 'fish_stoutier'), observed = [];
  const hit = n => new core.HitDamage(n, core.HitMask.RED).onApplied(taken => observed.push(taken));
  npc.setHitpoints(20); npc.getCombat().getHitQueue().addPendingDamage([hit(50), hit(50)]);
  npc.getCombat().getHitQueue().process(++core.World.processCycle); assert.deepEqual(observed.splice(0), [20, 0]);
  const other = drink(f, 'fish_stoutier'); other.setHitpointsLocked(true);
  other.getCombat().getHitQueue().addPendingDamage([hit(50)]); other.getCombat().getHitQueue().process(++core.World.processCycle);
  assert.deepEqual(observed.splice(0), [0]); assert.equal(other.getHitpoints(), 140);
  // Developers take damage like anyone; only their items are safe on death.
  f.player.setRights(core.PlayerRights.DEVELOPER); f.player.setHitpoints(50);
  f.player.getCombat().getHitQueue().addPendingDamage([hit(20)]); f.player.getCombat().getHitQueue().process(++core.World.processCycle);
  assert.deepEqual(observed.splice(0), [20]); assert.equal(f.player.getHitpoints(), 30);
  f.player.setHitpoints(50);
  f.player.setRights(core.PlayerRights.PLAYER);
  const api = PluginManager.createApi('ChartingDamageObserverTest');
  api.onCustomEvent('combat:damage-apply', ({ target, hit }) => { if (target === f.player) hit.setDamage(7); });
  f.player.getCombat().getHitQueue().addPendingDamage([hit(50)]); f.player.getCombat().getHitQueue().process(++core.World.processCycle);
  assert.deepEqual(observed.splice(0), [7]); assert.equal(f.player.getHitpoints(), 43);
});
