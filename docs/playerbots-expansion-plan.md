# Player bots expansion plan

Goal: turn the bots from groups tied to one spot into a small population of "players" who move
around the world and progress.

## Where the bots stand

Already there:

- 16 activities: chopping, mining, fishing, combat training, PvP, roaming, following and banking trips
- Pathing through doors, stairs, shortcuts and the Wilderness ditch
- Level ranges per site, and activity switching on a timer
- Bot support in Castle Wars, Pest Control and Bounty Hunter
- AI bots that chat, trade, follow players and remember things

Main gaps:

- Switching only happens between activities at one site, so non-AI bots never travel anywhere new.
- Site and PvP bots get fresh levels each startup, so they don't keep progress. Only AI bots did
  before Phase 2.
- There are no activities yet for popular skills like Thieving, Agility or Runecraft.
- No bot use of the Grand Exchange was found. That search was rough, so it needs checking.

## Phases

### Phase 1: Fill the world (small, config only)

- Turn on Lumbridge and add sites at Draynor, Varrock, Falador, Seers' Village and Catherby, with
  level ranges that suit each area.
- Measure server performance as the count rises, to find a safe number before adding anything else.
  There is already a bot cap to check.

### Phase 2: Bots with routines (medium, the core of this plan)

- Give each bot a saved profile: name, main skill, levels that grow through real XP, personality.
- Add a simple goal system ("chop until the bank has 200 logs, then go to Seers"), so bots travel
  between sites.
- Add play sessions, so bots log in and out through the day and the population changes over time.

### Phase 3: More activities (medium, one at a time)

- Start with what is most visible: Agility courses, Thieving, Smithing at Varrock, Crafting,
  Runecraft and Slayer tasks.
- Each becomes a new activity using the existing template system.

### Phase 4: A working economy (medium, optional)

- Bots sell what they gather on the Grand Exchange and buy their supplies, which makes the GE useful
  on a mostly solo server.
- Needs limits so bots can't flood the market or crash prices.

### Phase 5: Social life (small to medium)

- Simple pre-written chat for ordinary bots, such as level-up reactions and area chatter, with no AI
  calls.
- A few AI bots as the "real conversation" characters.
- Later, bots could join group bosses, which would be a large project of its own.

## Progress

### Phase 1: done, 2026-11-01

Six skilling sites are on in `server/data/definitions/world.local.json` (`PlayerBots:sites`):
Lumbridge 15, Draynor 13, Varrock 14, Falador 10, Seers' Village 11 and Catherby 11. That is 74
skilling bots plus the 25 PvP bots, 99 in total.

Load test, one logged-in player, 30-second sample after a 75-second settle (a tick has 600 ms):

| Bots | Average tick | Slowest tick |
| --- | --- | --- |
| 25 | 16 ms | 45 ms |
| 54 | 34 ms | 138 ms |
| 99 | 57 ms | 177 ms |
| 146 | 62 ms | 128 ms |

No errors at any size, and no skilling bots were inside the Wilderness. These were short samples,
so they say nothing yet about memory or behaviour over hours, or about the cost of several real
players. The configured bots are named `DevBot1` and so on; realistic names belong in Phase 2.

### Phase 2: done, 2026-11-01

Residents replace the Phase 1 sites (`server/plugins/bots/residents/`, on with
`"PlayerBots:residents": { "enabled": true }` in `world.local.json`). There are 110 of them, with
about two thirds online at once, and no language model is involved.

- **Profiles:** a saved account with a locked password, a realistic name, a focus skill, a starting
  tier and a persona for Phase 5. Levels and items last; a first login sets them, then they earn XP.
  The list is in `server/data/saves/resident-bots.json`.
- **Goals:** work weighted to the focus skill, the best activity their levels allow, and a town from
  `server/plugins/bots/data/resident-goals.json`. They walk there, work 20-45 minutes and move on.
- **Sessions:** 45-150 minutes online, then 20-90 away, each on its own timers.
- **Wilderness:** a resident that strays in is given a new goal in town.
- **Owner command:** `::residents [name]` shows who is online and what they're doing.

Load test, one logged-in player, 45-second samples: 95 bots (70 residents and 25 PvP) averaged 50 ms
a tick, slowest 338 ms; 102 bots (77 and 25) averaged 31 ms, slowest 69 ms. No errors, nobody in the
Wilderness. Across clean restarts, no resident lost XP, and 56 of 107 earned some in 8 minutes.
Short-timer tests covered logging out and back in.

Still unproven: behaviour over many hours, whether long walks ever get stuck, and resources getting
crowded. Tools are still free through the existing bot actions, which Phase 4 should revisit.

## Risks

- **Performance:** the biggest limit, so each phase gets a load test.
- **Crowded resources:** bots could occupy every rock near a player. Sites need limits per resource.
- **Wilderness:** roaming bots shouldn't wander in by accident and die, and PvP bots stay separate.
- **Updates:** keep the work inside `server/plugins/bots/` so pulling new project versions stays easy.

## Decisions

1. **Population:** aim for 50-100 bots online, subject to the Phase 1 measurements.
2. **Economy:** include Phase 4. It makes the GE useful, but bots then affect prices.
3. **AI chat:** start with free pre-written chat, then add 3 AI bots through Ollama if real
   conversation is wanted. Needs a machine that can run a local model well.

Start with Phase 1, then Phase 2, because everything else depends on the profile and goal system.
