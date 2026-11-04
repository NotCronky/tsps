# Gauntlet Helper (RuneLite plugin)

A learning aid for the Gauntlet and the Corrupted Gauntlet on TSPS. It only shows information;
it never clicks or acts for you.

- **Preparation:** a checklist of what's left to gather for the kit you pick in the plugin's
  settings (armour and weapon tier, which weapons, potions, fish). It counts what you carry and
  wear, so made gear stops needing its resources. Weapon parts show which demi-boss drops them.
- **Hunllef:** which prayer its next attack needs and how many attacks until it switches (it opens
  with Ranged and switches every 4, tornado summons included), what it protects against and what
  to hit it with, a warning when your weapon is the one it blocks, your hits left until it changes
  its protection (6), a rough tornado timer, and a warning when its attack disables your prayers.
- **Arena:** tornado tiles in red; floor tiles about to burn in yellow, and burning ones in red.

```bash
tools/gauntlet-helper-plugin/build.sh   # builds and copies the jar to ~/.rlcustom/sideloaded-plugins
```

Auto-prayer is on the server, not in this plugin: `::gauntletautopray` (or `::gauntletautopray on|off`)
keeps your protection and offensive prayers right against the Hunllef while you learn it.
