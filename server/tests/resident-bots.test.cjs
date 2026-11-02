// Run: node --test tests/resident-bots.test.cjs
// Residents' decisions: pure, so no server is needed.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { bestByMode, pickGoal, pickWeighted, rollProfile, rollStart } = require("../plugins/bots/residents/Goals.PlayerBots");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugins/bots/data/resident-goals.json"), "utf8"));
const places = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugins/bots/data/ai-places.json"), "utf8")).places;
const entry = (id, mode, level) => ({ id, level, activity: { id, mode } });
const entries = [
  entry("normal_trees", "woodcutting", 1), entry("willow_trees", "woodcutting", 30),
  entry("iron_rocks", "mining", 15), entry("net_fishing", "fishing", 1), entry("combat_training", "combat_training", 0),
];
const hangAround = { id: "roam", mode: "roaming" };
const sequence = (...values) => { let at = 0; return () => values[at++ % values.length]; };

test("every place residents use is a real place outside the Wilderness", () => {
  const known = new Map(places.map((place) => [place.id, place]));
  for (const list of Object.values(data.places)) {
    for (const id of list) {
      assert.ok(known.has(id), `${id} is in ai-places.json`);
      const { x, y } = known.get(id);
      assert.ok(!(x >= 2940 && x <= 3392 && y >= 3520), `${id} is outside the Wilderness`);
    }
  }
  for (const focus of data.focuses) assert.ok(data.places[focus]?.length > 0, `${focus} has somewhere to go`);
});

test("a kind of work uses the best activity the resident can do", () => {
  assert.equal(bestByMode(entries).get("woodcutting").id, "willow_trees");
  const goal = pickGoal({ data, focus: "woodcutting", entries, hangAround: null, lastMode: null, random: () => 0 });
  assert.equal(goal.mode, "woodcutting");
  assert.equal(goal.activity.id, "willow_trees");
});

test("residents mostly do what they care about, but not only that", () => {
  const counts = {};
  for (let i = 0; i < 4000; i++) {
    const { mode } = pickGoal({ data, focus: "mining", entries, hangAround, lastMode: null });
    counts[mode] = (counts[mode] ?? 0) + 1;
  }
  assert.ok(counts.mining > counts.fishing * 2, JSON.stringify(counts));
  assert.ok(counts.fishing > 0 && counts.woodcutting > 0 && counts.hang_around > 0, JSON.stringify(counts));
});

test("the same work twice in a row is avoided, unless it's all there is", () => {
  for (let i = 0; i < 200; i++) {
    assert.notEqual(pickGoal({ data, focus: "mining", entries, hangAround, lastMode: "mining" }).mode, "mining");
  }
  const only = [entry("iron_rocks", "mining", 15)];
  assert.equal(pickGoal({ data, focus: "mining", entries: only, hangAround: null, lastMode: "mining" }).mode, "mining");
});

test("no open activity and nowhere to hang around is no goal", () => {
  assert.equal(pickGoal({ data, focus: "mining", entries: [], hangAround: null, lastMode: null }), null);
});

test("a new resident's start is drawn from the data", () => {
  const profile = rollProfile(data, sequence(0.1, 0.1, 0.1));
  assert.ok(data.focuses.includes(profile.focus));
  assert.ok(profile.tier in data.tierWeights);
  assert.ok(data.places[profile.focus].includes(profile.home));
  assert.equal(pickWeighted({ a: 0, b: 1 }, () => 0), "b");
});

test("about session / (session + break) of residents start online, with timers inside their range", () => {
  const config = { sessionMinutes: [60, 60], breakMinutes: [30, 30] };
  let online = 0;
  for (let i = 0; i < 4000; i++) {
    const start = rollStart(config);
    if (start.online) online++;
    assert.ok(start.minutes >= 0 && start.minutes <= (start.online ? 60 : 30));
  }
  assert.ok(online > 2500 && online < 2850, `${online} of 4000 online`);
});
