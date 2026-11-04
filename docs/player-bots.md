# Player bots

Bots that play like people: saved accounts that log in and out, train what their levels allow,
and earn everything they own. The same brain can play any player's own character in bot mode.

Code: `server/plugins/bots/`. Tests: `server/tests/bot-agent.test.cjs`, `bot-brain.test.cjs`.

## How a character decides what to do

- **Tasks** (`tasks/`) are what a character can be doing: Tutorial Island; every gathering tier
  as its own task (Woodcutting: trees, oak, willow, maple, yew, magic; Mining: copper and tin, iron,
  silver, coal, gold, mithril, adamantite, runite; Fishing by main fish: shrimps, sardines, mackerel,
  trout, pike, tuna, lobsters, sharks), each with its level, tool and places; Firemaking (burn
  logs, Wintertodt), Cooking, Smithing (smelting) and Combat training.
  The gathering tiers come from `server/data/definitions/bot-activities.json`, so a tier added there
  is a task; its places go in `data/task-places.json` under its activity id. Each says what it needs
  (`check`: levels, a tool owned or affordable, materials in the bank) and builds the activity that
  does it from the actions in `brain/actions/` (`build`).
- **The brain** (`agent/Brain.PlayerBots.js`) scores every task the character can do right now
  and draws one by score:
  - its profile: a skiller avoids fighting, a fighter prefers it, a focus skill comes up three times
    as often;
  - its levels: skills behind the rest come up more, as players even their stats out;
  - variety: what it just did comes up less;
  - a skill's open tiers share that skill's weight, each tier up twice as likely as the one below,
    so a miner mostly mines the best ore it can without Mining crowding out other skills;
  - processing what it banked is worth a little more.
- **The agent** (`agent/Agent.PlayerBots.js`) runs the chosen task:
  - it takes the character to the nearest of the task's places first (`data/task-places.json`).
    More than 60 tiles away, it teleports when that gets it at least 40 tiles nearer, then walks
    the rest (`brain/actions/TravelTo.PlayerBots.js`). The teleports come from the plugins that own
    them, through `teleport:options` ({ player, options }): spellbook teleports it has the
    spellbook, level and carried runes for (standard, Ancient, Lunar, Arceuus), teleport tablets
    and charged jewellery it carries or wears, its home teleport and the minigame teleports off
    cooldown. The one landing nearest wins, with a small cost for what it uses up. Each is used
    through its plugin's own code, so runes, charges, tablets, XP, cooldowns and Wilderness limits apply.
    Banked teleports count too: when one in the bank (runes for a spell, a tablet, jewellery) lands at
    least 40 tiles nearer than anything carried, it stops at a bank for it first, once a trip;
  - it runs the task for 15-45 minutes, then asks the brain again;
  - a task that ends within a minute (no tool it can get, out of materials) rests for 5 minutes.
- **The executor** (`brain/Brain.PlayerBots.js`) carries out the activity one action a tick:
  walking, doors, stairs, shortcuts, banking, gathering.

## Minigames as tasks

- **Wintertodt** is a Firemaking task (50 Firemaking). The character gets its kit (axe,
  tinderbox, knife, hammer, a games necklace for the trip) from what it owns or can
  buy, travels to the camp and plays rounds through the Wintertodt plugin's own play
  (`wintertodt:play`), brewing its own rejuvenation potions inside, until it can't keep warm. The Wintertodt plugin's own crowd plays the same way, and fills the game when
  a real player goes into the prison (`Wintertodt:bots` in the world config sets how many; see
  docs/wintertodt.md). A task character isn't part of that count.
- **Tempoross** isn't a task yet: it needs a Tempoross play of its own (there's no Tempoross bot
  to reuse). Tempoross stays solo for now.

## Tutorial Island

A brand-new account on Tutorial Island gets the Tutorial Island task before anything else. For now
it takes the Gielinor Guide's skip, through the Tutorial Island plugin's `tutorial:skip` event: the
starter kit, Lumbridge, and Learning the Ropes completed. It then closes the welcome boxes and the
brain carries on. A world with `TutorialIsland:allowSkip` off locks the task. Playing the island
through step by step is still to come.

## Real progression

Nothing is conjured. A tool, bait, food, gear or runes come from the character's own inventory,
equipment or bank (`lib/Supplies.PlayerBots.js`), or are bought with its own coins at a shop that
stocks them (`brain/actions/BuyItems.PlayerBots.js`, through the normal shop code). A character
that can't get what a task needs doesn't get that task. Combat trainers wear the best gear they own
and carry, and only cast with their own runes. Gathered goods are dropped, sold, processed or
banked, and processing tasks work through what's banked.

## The population

`population/`, on with `"PlayerBots:population": { "enabled": true }` in the world config's
`pluginConfig` (`server/data/definitions/world.local.json`). Options: `count` (default 110),
`sessionMinutes` and `breakMinutes` (`[min, max]`, defaults `[45, 150]` and `[20, 90]`).

- **Accounts:** each bot is a normal saved account with a realistic name (`lib/Names.PlayerBots.js`)
  and a locked password. The roster is `server/data/saves/player-bots.json`; levels and items are in
  the player save.
- **Stages:** a new account starts early, mid or late game (`data/stages.json`): rolled levels, the
  best gear and tools its levels allow, food, and coins in the bank. After its first login, it earns
  everything.
- **Profiles:** balanced, skiller or fighter, with a focus skill.
- **Sessions:** about two thirds are online at once. Each logs in and out on its own timers.
- **As real players:**
  - they count towards the world's population (`World.getPopulation`, through `world:population`);
  - they show online in friends lists;
  - a private message gets a short reply a few seconds later.
- **Owner command:** `::bots [name]` lists who is online, their stage and profile, and what they're
  doing.

## Bot mode

Any player can let their own character play itself while they watch:

- `::botmode` opens a picker: **Let the brain choose**, a task group, or **Resume** the last task.
  Gathering lists its skills, then each skill's tiers three to a page (**More...** for the rest).
  Locked tasks show as locked and say why when picked.
- `::botmode <task>` starts a task directly (`::botmode list` shows the ids and what's locked).
- `::botmode brain` lets the brain choose and rotate tasks.
- `::botmode status` shows what it's doing. `::botmode off` stops.

Any click of the player's own in the world takes back control at once (`player:world-input`). It
also stops on logout, or when a picked task can't go on (with the reason). The character stays an
ordinary player: it isn't flagged as a bot, so it keeps its sounds and full updates.

## Adding a task

1. Write the task object (`tasks/Common.PlayerBots.js` describes it). Give it `id`, `name`, a
   `group` (Gathering, Processing, Combat), `skill`, `places`, `minutes`, `check` and `build`.
   Build activities from the registry (`registry.byId.get(id)` for one in
   `server/data/definitions/bot-activities.json`, or `registry.compile({ ... })` for its own).
2. Add it to `tasks/Catalogue.PlayerBots.js`, and its places to `data/task-places.json`.
3. It appears in the brain's choices and in the bot mode picker. Test `check` and `build` in
   `bot-agent.test.cjs`.

## What else is here

- **Wilderness PvP bots:** the PvP hotspots in `server/data/definitions/bot-sites.json`, still run
  by the PvP controller.
- **Minigame bots:** Castle Wars, Pest Control, Bounty Hunter, Soul Wars, Wintertodt and LMS build
  on the shared pieces kept here: the bot player factory, names, PvP loadouts.
- **Removed:** the old skilling sites, the residents and the language-model AI chat bots.

## Next

1. **Every skill:** Thieving, Agility (the course data is there), anvil smithing, Crafting,
   Fletching, Herblore, Runecraft, Prayer, Magic, Hunter, Farming, Construction, Slayer.
2. **Quests:** a task that plays a quest through its plugin's real dialogue and steps. The quest
   plugins' bot checks (mostly owner-only NPC spawns) need lifting.
3. **Minigames:** rebuild the minigame bots as tasks on the agent, starting with Wintertodt.
4. **Hiscores:** there are none yet; the bots are saved accounts, so they'll appear when one exists.
