# Boss Difficulty (RuneLite plugin)

A side panel that ranks about 60 bosses from easiest to hardest in six tiers (Beginner to Master),
with what to bring, tips for learning each fight and a link to its wiki guide. When you're logged
in it shows your kill count for each boss and points at the easiest one you haven't killed yet.
Kill counts are saved per character (RuneLite's config, group `bossdifficulty`, one `kc_<name>`
key each), so they survive a client restart; a count only ever goes up.

```bash
tools/boss-difficulty-plugin/build.sh   # builds and copies the jar to ~/.rlcustom/sideloaded-plugins
```

Restart RuneLite (sideloaded plugins load in developer mode, as RSProx's RuneLite does), then click
the bar-chart icon in the sidebar. The ranking is in `src/com/tsps/bossdifficulty/Bosses.java`:
change a boss's score (1-100) to move it.
