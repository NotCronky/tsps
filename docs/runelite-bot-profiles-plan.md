# RuneLite bot profiles: plan

Goal: a set of RuneLite plugin "profiles" that play the TSPS server on their own: one per boss on
the server, a Wilderness PvP profile and a Castle Wars profile. They run only on TSPS (world 1,
listed as `tsps`), never on official worlds.

Status (2 November 2026):

- **Done:** TSPS Fake Mouse (human-like movement, real mouse blocked while a bot holds it), TSPS
  Agility (laps and marks of grace, working). All in `tools/runelite-bots`, one jar
  (`tsps-bots.jar`).
- **Paused:** TSPS Farm Run (herb and allotment runs). It reaches Falador but stalled on an
  allotment.
- **Done:** the test loop (section 2). An agent can launch RuneLite on a virtual screen against its own
  test server, log in, set up the account, run a bot and check it. The agility plugin's first proof
  run completed a Draynor rooftop lap and stopped on Escape.
- **Done:** the first cut of the shared bot core (section 3) and the first boss profile, King Black
  Dragon (`::tspsbot kbd on`). On the test server it killed the dragon repeatedly at full Hitpoints:
  Protect from Melee, anti-dragon shield and super antifire held. Between kills it loots, turns
  prayer off and waits for the respawn.
- **Working:** Wilderness PvP (`::tspsbot pvp on`). On the test server it beat the level-126 PvP bots
  (two kills, staying at full Hitpoints):
  - Protection prayer follows their weapon; its weapon switches against their overhead (Ghrazi
    rapier, Armadyl crossbow). Piety or Rigour to match.
  - Dragon claws special attack when they drop under 55%, then back to the main weapon.
  - Combo eats (food plus karambwan), brews, restores (prayer or drained Attack), poison cures.
  - Wilderness rules: the level range, single-way combat, NPCs on you first.
  - Walks back to where it started when there's nobody to fight. Untested: the bots kept coming.
- **Working:** Last Man Standing (`::tspsbot lms on`, started in the Ferox Enclave lobby). On the test
  server it played game after game:
  - Joins through Lisa ("I'd like to play.", then the mode). Competitive falls back to Casual when
    it's refused (it was: too many forfeits that day from test restarts).
  - Fights with the PvP profile on LMS rules ("Fight" on anyone): prayer and weapon switching,
    Ice Barrage with a staff, Dragon crossbow specials.
  - Handles freezes: a ranged or magic weapon, and only targets within its reach until the freeze ends.
  - Walks back inside the safe zone when the fog has it.
  - When nobody's on it: spends bloody keys on the nearest chest, searches loot crates in reach, and
    wears the armour that comes out (Ahrim's, Lightbearer). Weapons join its switching.
  - Four kills in two games on the test server (a likely Casual win), queueing again after each.
- **Escaping** (PvP and LMS): under 30% Hitpoints with no food, brews or karambwans left, it stops
  attacking and runs, keeping its prayer up. It runs towards the LMS safe zone, or away from the
  opponent; in the Wilderness at level 20 or below it breaks a teleport tablet. It fights again over
  half Hitpoints. Not yet seen in a test game (it was never that low).
- **Next for PvP:** magic (freezes, barrage), smarter eating (tick-eating, brew limits), escaping when
  losing, then more bosses and Castle Wars.

## 1. What exists

`tools/runelite-bots` builds `tsps-bots.jar`, installed into `~/.rlcustom/sideloaded-plugins` (where
the RSProx-launched RuneLite loads sideloaded plugins). RuneLite gives each sideloaded jar its own
class loader, so plugins that share the fake mouse ship in this one jar.

- **TSPS Fake Mouse.** While a plugin holds it, a first-in-line mouse listener swallows real mouse
  events, so the game sees only the bot's. Movement follows Fitts's law timing, a minimum-jerk speed
  profile, a curved path with fading tremor, and occasional overshoot and correction. Speed is
  Relaxed, Human or Fast. Points are scaled for stretched mode. Escape gives control back. A cursor
  and banner show who holds it.
- **TSPS Agility.** Runs supported courses and picks up marks of grace it can walk to (a collision
  search, so marks on another rooftop section wait until the player is there). It retries each
  mark up to three times per lap.
- **TSPS Farm Run.** Banks and buys on the GE, teleports, walks generated routes, rakes, plants and
  notes produce at the tool leprechaun. Its data (`farm-run-data.json`) is generated from the
  server's own farming tables and pathfinder.

### Lessons so far

These shape everything below:

- **Menu actions work for objects, NPCs, widgets and items.** `client.menuAction` produces the same
  packets a player's click does, and the gateway translates them for the server.
- **Walking needs the mouse.** The client's "Walk here" goes to the tile under the mouse and ignores
  the menu action's coordinates, so walking is: move the fake mouse onto the tile, check
  `getSelectedSceneTile()`, then "Walk here".
- **Synthetic input must be scaled.** Stretched mode halves window coordinates back to game pixels;
  unscaled events landed at half the intended position.
- **Plugins can't send packets from scripts.** `client.runScript` of a script that sends a packet
  (for example `resume_objdialog`) is refused. Use the interface the way a player does.
- **Read the logs, not guesses.** RuneLite logs to `~/.runelite/logs/client.log`; the farm run logs
  every step to `~/.rlcustom/tsps-farm-run.log`. Each bug so far was found there.
- **Logging in inside the Wilderness lost the Attack option** (a gateway bug that affected every
  official-client player, not just bots). The gateway sent Attack with the login packets and the client
  didn't keep it, so there was no Attack until you left the Wilderness and came back. Fixed in
  `gateway/src/main/kotlin/gateway/session/GatewaySession.kt`: Attack is sent again on the first three
  ticks after login.
- **The gateway decides what the client sees.** For example, GE offers arrive as stock-market
  packets (not the server's varps). Check `gateway/COVERAGE.md` before reading game state.

## 2. Test loop

The farm run took many rounds because every change needed a human to log in and try it. A test loop
lets changes be checked first.

1. **A test server in its own worktree.** `scripts/wt new test/bots` gives a slot with private ports
   (game 43700+N, gateway 43900+N), its own `server/data` and its own accounts. The user's server
   (main checkout, 43594/43595) is never touched.
2. **RuneLite on a virtual screen.** Xvfb (installed) gives an invisible X display that is separate
   from the Wayland desktop. Screenshots come from `import -window root`.
3. **A client that talks to the test gateway.** RSProx's patched client is keyed to RSProx's own
   proxy, so it can't be pointed elsewhere. The repo's isolated client tooling
   (`tools/runelite-client/PatchClient.java`, `StartClient.java`, documented in
   `docs/runelite-gateway.md`) patches stock RuneLite with the test gateway's RSA key and port. Its
   scripts are PowerShell; a bash launcher for Linux is part of this step.
4. **Driving it.**
   - Log in a test account by typing into the login screen (xdotool on the virtual display).
   - Enable the bot plugins via the isolated RuneLite profile's config.
   - Prepare the account with the server's agent MCP or admin commands (stats, gear, position).
5. **Checking it.** Screenshots, the plugins' own logs, RuneLite's log, and the server's view
   through the agent MCP (position, inventory, NPC state).

### Using it

The test worktree is `../tsps-test-bots` (branch `test/bots`, slot 5). Your RSProx holds 43701-43704,
the game ports of slots 1-4, so the test server uses slot 5.

```bash
# 1. The test server and its gateway, from the worktree (ports come from its .env).
cd ../tsps-test-bots/server && npx tsc --build && DEV_USERNAME=botdev node ../scripts/run-with-env.mjs - ./dist/Server.js
cd ../tsps-test-bots && gateway/gradlew -p gateway run --console=plain

# 2. RuneLite on virtual display :77, patched for that gateway, with tsps-bots.jar (built fresh).
#    With a user and password, the TSPS Test Login plugin logs in (retrying while an old session
#    lingers) and presses Play.
tools/runelite-bots/test-client/test-client.sh ../tsps-test-bots :77 botdev <password>

# 3. Drive and look.
tools/runelite-bots/test-client/drive.sh say "::setlevel agility 99"
tools/runelite-bots/test-client/drive.sh say "::tele 3103 3277 0"
tools/runelite-bots/test-client/drive.sh say "::tspsbot agility on"
tools/runelite-bots/test-client/drive.sh shot /tmp/shot.png
```

- `DEV_USERNAME=botdev` makes `botdev` the developer account, so its `::` commands work.
- The client's files (home, logs, patched jars) are in `../tsps-test-bots/.bot-client`. Its RuneLite
  log is `.bot-client/.runelite/logs/client.log`.
- `test-client.sh` stops an earlier test client for the same worktree before it starts.
- `::tspsbot agility on|off`, `::tspsbot farm start|stop` and `::tspsbot <profile> on|off` (for
  example `kbd`) control the bots from chat. (The server has its own `::bot` command.)
- The test client is isolated:
  - No Discord: the patched properties and `-Drunelite.discord.enable=false`. It must never show in
    the user's Discord status.
  - Its config fallbacks point at the test server, not Jagex or RuneLite.
  - The farm run doesn't auto-start (`-Dtsps.bots.noautostart`).
- Bot profiles log to `.bot-client/.rlcustom/tsps-bots.log` (on the user's client,
  `~/.rlcustom/tsps-bots.log`).
- Expected noise in the client log: "Unable to create lambda" warnings for sideloaded plugins (RuneLite
  falls back to reflection), and DevTools failing to start (the runtime API jar lacks its gameval
  classes).

## 3. Shared bot core

Profiles share one core, so each new boss or fight is a small addition.

- **Perception: a per-tick snapshot.**
  - Self: HP, prayer, run energy, inventory, worn gear, spellbook, freeze and venom.
  - The target (NPC or player): animation, graphics, projectiles aimed at us, overhead prayer, worn
    gear, health bar.
  - The ground: hazard tiles (graphics objects), safe tiles, and walkable tiles (the collision
    search agility already uses).
- **Actions through the fake mouse.**
  - Prayer flicks and protection switches; gear sets swapped as one burst of clicks.
  - Eating, drinking and combo eats.
  - Special attacks and spells (including freezes).
  - Attacking, and walking to a tile.
  - Each action reports what it needs: its clicks, and the tick it must land in.
- **Faster decisions.** Bots decide on game events (projectile spawned, animation changed, hitsplat)
  and every client frame, not once per 600 ms tick, so a protection prayer can go up as an attack is
  seen. The Fast mouse speed is for this.
- **Trips.** Banking, restocking (GE), teleporting and walking, built from the farm run's working
  pieces (bank, GE buying, teleports, generated routes, hover-and-walk).
- **Safety.**
  - It stops on low supplies or when it can't keep HP up, and teleports out when a fight is lost.
  - It acts only on TSPS (`ServerGuard`).
  - Escape always gives the mouse back.

### What the core is today

`tools/runelite-bots/src/main/java/com/tsps/botcore`:

- **`BotProfilesPlugin`** hosts the profiles. It handles `::tspsbot <key> on|off`, holds the fake
  mouse, ticks the running profile each game tick (unless a click is still on its way), passes it game
  messages, and logs.
- **`Bot`** is what a profile sees: Hitpoints, prayer, poison (varp 102), its target, NPCs by name,
  ground items, item values (GE guide, else high alchemy) and the log.
- **`Actions`** is what a profile does, through the fake mouse:
  - Inventory items by slot and option (Eat, Drink, Wield, Break).
  - Prayers, found by the name their button shows. The prayer book's components are not in gameval
    order: Protect from Melee is 541:23 on this cache, and 541:27 ("PRAYER19") is Sharp Eye.
  - NPC options, and ground item Take.
- **`Profile`**: `tick` returns null to carry on or why it stopped; `start`, `stop` and `message`
  are hooks.

## 4. Profiles

A profile is a plugin, or a mode of one plugin, built on the core. It has two parts:

- **Data:** gear sets, inventory, travel route and the boss's attacks. Taken from the server's own
  boss plugin (`server/plugins/bosses/`), which defines the mechanics the server enforces, so a
  profile plays against the same rules. Generated where possible, as the farm run's data is.
- **Logic:** what to do each moment of the fight: which prayer, where to stand, when to eat or spec.

Order, easiest first, each one proving more of the core:

1. **King Black Dragon or Giant Mole.** Prayer, eating, a single target, a trip. This proves the core.
2. **Wilderness PvP vs the server's own PvP bots.** They already fight at fixed gear tiers, which
   makes them a repeatable opponent. Prayer and gear switching, freezes, eat timing.
3. **More bosses,** roughly by difficulty, adding mechanics as needed: hazard tiles (Vorkath,
   Zulrah), phases and rotations (Zulrah), multiple targets (Dagannoth Kings).
4. **Castle Wars:** objectives (flags, barricades), team play, plus the PvP fight engine.

PvP against real players on the server is a separate decision for the server owner.

## 5. Rules carried over

- Bot plugins act only on TSPS (`ServerGuard`), never official worlds.
- The server stays faithful to OSRS. Bots adapt to the server, not the other way round. A server
  change made for a bot must be a real OSRS fix (with its Wiki source).
- Generated JSON from `osrsreboxed-db` is never edited by hand (repository rule). Bot data is
  generated from server sources by scripts in `tools/runelite-bots/scripts`.
- Testing uses a worktree server on its own ports, never the user's running server.
- When unsure about a design choice or a behaviour, stop and ask.
