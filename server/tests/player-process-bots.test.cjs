'use strict';

// onPlayerProcess for bots: only listeners that ask ({ bots: true }) hear bots, and only bots that
// play as players (Player.playsAsPlayer); upstream's bots and every other listener are unchanged.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PluginManager } = require('../dist/plugins/PluginManager');

test('onPlayerProcess reaches a bot that plays as a player only through listeners that opt in', () => {
  const api = PluginManager.createApi('PlayerProcessBotsTest');
  const heard = { all: [], bots: [] };
  api.onPlayerProcess(({ player }) => heard.all.push(player.name));
  api.onPlayerProcess(({ player }) => heard.bots.push(player.name), { bots: true });
  const bot = { name: 'bot', getLocation: () => null };

  PluginManager.emitBotPlayerProcess({ player: bot });
  assert.deepEqual(heard.all, [], 'a listener that did not ask never hears bots');
  assert.deepEqual(heard.bots, ['bot']);

  const human = { name: 'human', getLocation: () => null };
  PluginManager.emitPlayerProcess({ player: human });
  assert.deepEqual(heard.all, ['human']);
  assert.deepEqual(heard.bots, ['bot', 'human'], 'an opted-in listener still hears players');
});
