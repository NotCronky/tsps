package com.tsps.gauntlethelper;

import com.tsps.gauntlethelper.GauntletIds.Items;
import com.tsps.gauntlethelper.GauntletIds.Mode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * What's still to gather for a chosen kit, from what the player holds (inventory and worn).
 * Armour costs are the Singing Bowl's; a weapon needs a frame, 50 shards to attune and its
 * demi-boss component to perfect; an Egniol potion needs a vial (10 shards), a grym leaf and
 * 10 dust (10 shards).
 */
final class PrepPlan
{
	static final class Row
	{
		final String label;
		final int have;
		final int need;

		Row(String label, int have, int need)
		{
			this.label = label;
			this.have = have;
			this.need = need;
		}

		boolean done()
		{
			return have >= need;
		}
	}

	/** Armour tier: 0 none, 1 basic, 2 attuned, 3 perfected. Weapons likewise (1-3). */
	static List<Row> plan(Mode mode, Map<Integer, Integer> held, int armourTier, int weaponTier,
		boolean bow, boolean staff, boolean halberd, int potions, int fish)
	{
		Items items = GauntletIds.items(mode);
		int shards = 0;
		int each = 0;
		int frames = 0;
		List<Row> components = new ArrayList<>();

		int[][] armour = {items.helm, items.body, items.legs};
		for (int piece = 0; piece < 3; piece++)
		{
			for (int tier = tierHeld(held, armour[piece]) + 1; tier <= armourTier; tier++)
			{
				each += GauntletIds.ARMOUR_COST[piece][tier - 1][0];
				shards += GauntletIds.ARMOUR_COST[piece][tier - 1][1];
			}
		}

		Object[][] weapons = {
			{bow, items.bow, items.bowstring, "Bowstring (dark beast)"},
			{staff, items.staff, items.orb, "Orb (dragon)"},
			{halberd, items.halberd, items.spike, "Spike (bear)"},
		};
		for (Object[] weapon : weapons)
		{
			if (!(Boolean) weapon[0])
			{
				continue;
			}
			int held0 = tierHeld(held, (int[]) weapon[1]);
			if (held0 < 1)
			{
				frames++;
			}
			if (weaponTier >= 2 && held0 < 2)
			{
				shards += GauntletIds.WEAPON_ATTUNE_SHARDS;
			}
			if (weaponTier >= 3 && held0 < 3)
			{
				components.add(new Row((String) weapon[3], count(held, (int) weapon[2]), 1));
			}
		}

		int potionsHeld = 0;
		for (int id = GauntletIds.EGNIOL_FIRST; id <= GauntletIds.EGNIOL_LAST; id++)
		{
			potionsHeld += count(held, id);
		}
		int potionsToMake = Math.max(0, potions - potionsHeld);
		int unfinished = count(held, GauntletIds.GRYM_POTION_UNF);
		int vialsHeld = count(held, items.vial) + count(held, GauntletIds.WATER_VIAL) + unfinished;
		shards += Math.max(0, potionsToMake - vialsHeld) * GauntletIds.SHARDS_PER_VIAL;
		shards += Math.max(0, potionsToMake * GauntletIds.DUST_PER_POTION - count(held, items.dust));
		int leaves = Math.max(0, potionsToMake - unfinished);

		int fishHeld = count(held, GauntletIds.RAW_PADDLEFISH) + count(held, GauntletIds.PADDLEFISH)
			+ count(held, mode == Mode.CORRUPTED ? GauntletIds.COMBO_FISH_CORRUPTED : GauntletIds.COMBO_FISH_REGULAR);

		List<Row> rows = new ArrayList<>();
		rows.add(new Row("Crystal shards", count(held, items.shards), shards));
		rows.add(new Row("Ore", count(held, items.ore), each));
		rows.add(new Row("Phren bark", count(held, items.bark), each));
		rows.add(new Row("Linum tirinum", count(held, items.linum), each));
		rows.add(new Row("Weapon frames", count(held, items.frame), frames));
		rows.addAll(components);
		rows.add(new Row("Grym leaves", count(held, items.grymLeaf), leaves));
		rows.add(new Row("Egniol potions", potionsHeld, potions));
		rows.add(new Row("Paddlefish", fishHeld, fish));
		return rows;
	}

	/** The highest tier held of a piece: 0 none, 1-3. */
	static int tierHeld(Map<Integer, Integer> held, int[] tiers)
	{
		for (int tier = tiers.length; tier >= 1; tier--)
		{
			if (count(held, tiers[tier - 1]) > 0)
			{
				return tier;
			}
		}
		return 0;
	}

	static int count(Map<Integer, Integer> held, int id)
	{
		Integer value = held.get(id);
		return value == null ? 0 : value;
	}
}
