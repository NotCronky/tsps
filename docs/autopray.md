# Auto-prayer (`::autopray`)

A learning aid, not part of OSRS. With it on, the server switches your protection prayer for
you against monsters' attacks, and turns on the best offensive prayer you can use for your own
weapon's style.

```
::autopray        toggle
::autopray on
::autopray off
```

Saved per player, off by default. It replaced `::gauntletautopray`.

## How it behaves

- It prays against the attack that is **judged next**. When two attacks are on their way, the
  prayer only switches once the first has been checked. You see it change on the attack
  animation (Jad's ranged and magic, for example), not on the hitsplat.
- If a boss turns your prayers off (the Hunllef's prayer-disabling magic, the Wardens' divine
  attacks, Phosani's third phase), it turns them back on for the next attack.
- **Out of combat it turns them off again.** Once no attack has been aimed at you for 10 ticks
  (6 seconds) and you aren't attacking anything, the prayers it turned on go off. Prayers you
  turned on yourself (Protect Item, say) are left alone. Turning `::autopray off` mid-fight
  leaves your prayers as they are.
- It needs Prayer points and the prayer unlocked. It skips any prayer you can't use. For
  offensive prayers it falls back a tier: Rigour, then Eagle Eye; Augury, then Mystic Might;
  Piety, then Chivalry, then Ultimate Strength with Incredible Reflexes.
- It works against **any monster**, not only bosses.

## Covered

### Bosses using the standard combat hit

These bosses attack through the server's standard combat hit. The game checks your prayer when
that hit lands, and auto-prayer hears about each one as soon as the attack is made, so no
boss-specific code was needed:

- Alchemical Hydra (ranged and magic; its poison, lightning and fire specials aren't prayable)
- Zulrah
- Vorkath's standard attacks
- King Black Dragon
- God Wars: General Graardor, Kree'arra, Commander Zilyana, K'ril Tsutsaroth
- Dagannoth Kings
- Kalphite Queen
- Sarachnis
- Giant Mole
- Chaos Elemental and the archaeologists
- Chaos Fanatic
- Vet'ion and Calvar'ion, Scorpia
- Bryophyta
- The Mimic
- Shellbane Gryphon (while you wear a shield; without one its hits ignore prayer)
- Count Draynor
- Skotizo
- Tormented Demons
- Barrows brothers
- Fortis Colosseum waves

### Bosses that check prayer in their own code

These check your prayer outside the standard hit, so each one sends auto-prayer its attacks
directly.

| Content | Covered attacks |
| --- | --- |
| **TzHaar Fight Cave** | TzTok-Jad's ranged and magic (prayer switched on the animation), all other waves |
| **Inferno** | JalTok-Jad, and every ranged and magic hit from the Inferno's creatures |
| **The Gauntlet** | Crystalline and Corrupted Hunllef |
| **Theatre of Blood** | Every boss's styled attacks; Maiden's blood storm; Bloat's flies; Sotetseg's balls and the split ricochet; Verzik's P1 powerful blast, P2 urn and blood spell, P3 attacks |
| **Chambers of Xeric** | Every styled raid attack (Tekton, Vanguards, Vespula, Muttadiles, Shamans, Mystics, Guardians...); the Great Olm's spheres; Vasa's stomp and crystal blast |
| **Tombs of Amascut** | Every styled raid attack; Akkha's attacks and unstable orbs; Ba-Ba's melee; the Wardens' divine attacks; Zebak's blood barrage; Kephri's fireballs, spitters and arcane scarabs; Crondis' crocodiles |
| **Fractured Archive** | Styled raid attacks; the Guardian's vines; Ocellus' hybrid attack |
| **Nex** | All styled attacks, Shadow/Blood/Smoke/Ice/Zaros magic included |
| **The Nightmare / Phosani's Nightmare** | Her attacks, husks and parasites. Follows her curse: it prays whichever protection actually blocks the attack while the prayers are swapped |
| **Desert Treasure II** | The Leviathan (bite and volley orbs), the Whisperer, Vardorvis (axes, strikes and heads), Duke Sucellus (melee and magic) |
| **Yama** | Styled attacks |
| **Phantom Muspah** | Styled attacks |
| **Doom of Mokhaiotl** | Orbs, the tongue |
| **Cerberus** | The summoned souls |
| **Abyssal Sire** | His melee, the tentacles |
| **Amoxliatl** | Icicles |
| **Corporeal Beast** | Magic and its splits |
| **Araxxor** | Melee, ranged and magic |
| **The Hueycoatl** | Feather rain |
| **Grotesque Guardians** | Dusk's attacks |
| **Royal Titans** | The melee slam |
| **Scurrius** | Melee, and his ranged bolts and magic fur balls |
| **The Mad Angel** | The sweep, the blast and the smite. On a smite, Protect from Magic goes up as the strike lands, which counts as a last-moment switch: if it wasn't already up, the first strike is blocked and your next hit is a max hit. Auto-prayer doesn't turn prayers off mid-fight, so later strikes meet a prayer that was already up and only lose three quarters of their damage |
| **Obor** | Ranged |
| **Wilderness bosses** | Callisto and Artio (melee, ranged, magic knock-back); Venenatis and Spindel (ranged, magic, bite) |

## Not covered

These still need you to pray yourself:

- **Dragonfire:** Vorkath's breath, Elvarg, other dragons. Not a combat style.
- **Monsters that pick their style from your prayer:** the Ice Demon, the Mystics, K'ril's
  slam, Jal-Ak. They read what you're praying and attack around it.
- **Prayer as a dodge:** Araxxor's cleave, Duke Sucellus' eye cones, Kephri's phantom in the
  Wardens' room, Ocellus' cog.
- **Typeless attacks that no prayer stops:** the Kraken, the Thermonuclear smoke devil, the
  Moons of Peril.

The Great Olm still saps your prayer if any protection is up when he fires a sphere, as in
OSRS. Auto-prayer won't turn it off before he fires.

## For developers

Content announces an attack with the custom event `combat:incoming-attack`:

```js
api.emitCustomEvent("combat:incoming-attack", {
  attacker: npc,
  target: player,
  type: "magic",          // a CombatType, or "melee" / "ranged" / "magic"
  cycle: World.getProcessCycle() + ticks, // when the prayer is checked
});
```

When the right prayer isn't simply the attack's style (a curse swapping prayers, partial
blocks), pass `protects: (style) => multiplier` instead of `type`. Auto-prayer picks the
protection that lets least through. `protects(null)` is the damage with no protection up.

`HitQueue.addPendingHit` sends this event for every NPC hit on a player, unless the hit
bypasses protection prayer. A boss that checks prayer itself should announce its attack when it
throws it. The raid shared modules have an `announceAttack(npc, target, style, ticks)` helper
for this. The listener is
[server/plugins/combat/AutoPrayer.plugin.js](../server/plugins/combat/AutoPrayer.plugin.js);
tests are in `server/tests/auto-prayer.test.cjs`.
