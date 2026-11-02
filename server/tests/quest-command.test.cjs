// Run after `yarn build`: node --test tests/quest-command.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const QuestRuntime = require("../plugins/quests/QuestRuntime");
const QuestCommand = require("../plugins/quests/QuestCommand.plugin");

const api = new Proxy({}, { get: () => () => {} });
const grandTree = QuestRuntime.registerQuest(api, { key: "the_grand_tree", name: "The Grand Tree", varpId: 150, completionValue: 160, questPoints: 5 });
QuestRuntime.registerQuest(api, { key: "tree_gnome_village", name: "Tree Gnome Village", varpId: 111, completionValue: 9, questPoints: 2 });

function createPlayer() {
  const attributes = new Map();
  const messages = [];
  const varps = new Map();
  const sender = new Proxy({}, {
    get: (_target, method) => (method === "sendConfig" ? (id, value) => { varps.set(id, value); return sender; } : () => sender),
  });
  return {
    messages,
    varps,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    sendMessage: (message) => messages.push(message),
    getPacketSender: () => sender,
    getInventory: () => ({ adds() {} }),
  };
}

const run = (player, command) => QuestCommand._test.questCommand({ player, parts: command.split(" ") });

test("::quest grand tree complete completes it as the quest does, with its points", () => {
  const player = createPlayer();
  run(player, "quest grand tree complete");
  assert.ok(grandTree.isComplete(player));
  assert.equal(player.getAttribute("quest.points"), 5);
  assert.equal(player.varps.get(150), 160, "the quest's varp follows");
  assert.equal(player.messages.at(-1), "The Grand Tree: stage 160 (complete; completes at 160).");
});

test("reset and a stage number set the stage, and quest points follow completion", () => {
  const player = createPlayer();
  run(player, "quest the_grand_tree 160");
  assert.equal(player.getAttribute("quest.points"), 5);
  run(player, "quest The Grand Tree 40");
  assert.equal(grandTree.getStage(player), 40);
  assert.equal(player.getAttribute("quest.points"), 0);
  run(player, "quest grand tree reset");
  assert.equal(grandTree.getStage(player), 0);
  assert.equal(player.messages.at(-1), "The Grand Tree: stage 0 (not started; completes at 160).");
});

test("names: a partial name must match one quest", () => {
  const player = createPlayer();
  run(player, "quest tree");
  assert.equal(player.messages.at(-1), '"tree" matches 2 quests: The Grand Tree, Tree Gnome Village.');
  run(player, "quest dragon slayer ii");
  assert.equal(player.messages.at(-1), 'No quest matches "dragon slayer ii".');
  run(player, "quest");
  assert.match(player.messages.at(-1), /^Usage/);
});

/** A container as the command uses it: copies, a reset and a put-back. */
function createContainer(items = []) {
  return {
    items,
    getItems() { return this.items; },
    getCopiedItems() { return [...this.items]; },
    setItems(next) { this.items = next; return this; },
    resetItems() { this.items = []; return this; },
    refreshItems() { return this; },
  };
}

function createCarryingPlayer() {
  const player = createPlayer();
  const inventory = createContainer(["held sword"]);
  const equipment = createContainer(["worn hat"]);
  const bank = createContainer(["banked coins"]);
  return Object.assign(player, {
    inventory, equipment, bank,
    getInventory: () => inventory,
    getEquipment: () => equipment,
    getBanks: () => [bank, null],
  });
}

test("::completeallquests completes every quest but keeps only the unlocks a reward sets", () => {
  const seen = [];
  const rewarding = QuestRuntime.registerQuest(api, {
    key: "complete_all_reward", name: "Complete All Reward", varpId: 9001, completionValue: 5, questPoints: 2, rewardItemId: 995,
    onReward(player, _quest, options) {
      seen.push(options);
      player.setAttribute("test:unlocked", true);
      player.getInventory().items.push("reward item");
      player.bank.items.push("reward in the bank");
      player.equipment.items.push("reward worn");
      const experience = { player, allow: null };
      QuestCommand._test.refuseExperience(experience);
      player.setAttribute("test:experience-allowed", experience.allow);
    },
  });
  const player = createCarryingPlayer();
  player.getInventory().adds = () => {};
  player.getInventory().isFull = () => false;
  player.bank.items = ["banked coins"];
  QuestCommand._test.completeAllQuests({ player });

  assert.ok(rewarding.isComplete(player));
  assert.ok(grandTree.isComplete(player), "every quest, not only the one with a reward");
  assert.equal(player.getAttribute("test:unlocked"), true, "what the reward unlocks stays");
  assert.equal(player.getAttribute("test:experience-allowed"), false, "experience is refused during the run");
  assert.equal(seen[0].experience, false, "and held back from anything the reward would pay later");
  assert.deepEqual(player.inventory.items, ["held sword"]);
  assert.deepEqual(player.equipment.items, ["worn hat"]);
  assert.deepEqual(player.bank.items, ["banked coins"]);
  assert.equal(player.getAttribute("quest.points") > 0, true, "quest points are the quests', not a reward");

  const after = { player, allow: null };
  QuestCommand._test.refuseExperience(after);
  assert.equal(after.allow, null, "experience works again once it ends");
});

test("::completeallquests puts the items back when a reward throws, and names the quest", () => {
  const broken = QuestRuntime.registerQuest(api, {
    key: "complete_all_broken", name: "Complete All Broken", varpId: 9002, completionValue: 2,
    onReward() { throw new Error("reward failed"); },
  });
  const player = createCarryingPlayer();
  player.getInventory().adds = () => {};
  player.getInventory().isFull = () => false;
  const warn = console.warn;
  console.warn = () => {};
  try {
    QuestCommand._test.completeAllQuests({ player });
  } finally {
    console.warn = warn;
  }
  assert.ok(broken.isComplete(player));
  assert.deepEqual(player.inventory.items, ["held sword"]);
  assert.match(player.messages.at(-1), /failed: .*Complete All Broken/);
});
