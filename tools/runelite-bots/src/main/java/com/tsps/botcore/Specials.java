package com.tsps.botcore;

import java.util.LinkedHashMap;
import java.util.Map;

/** Special attack weapons a profile may use, by name, and the energy (out of 100) each costs. */
public final class Specials
{
	/** Varp 300: special attack energy, 0-1000. */
	public static final int ENERGY_VARP = 300;
	/**
	 * The combat tab's special attack bar (593:41). The server arms specs from this bar (and from
	 * varp 301), not from the minimap orb (160:36), so the bar is what gets clicked.
	 */
	public static final int SPEC_BAR = net.runelite.api.gameval.InterfaceID.CombatInterface.SPECIAL_ATTACK;

	static final Map<String, Integer> COSTS = new LinkedHashMap<>();

	static
	{
		COSTS.put("Armadyl godsword", 50);
		COSTS.put("Dragon claws", 50);
		COSTS.put("Voidwaker", 50);
		COSTS.put("Granite maul", 50);
		COSTS.put("Dragon warhammer", 50);
		COSTS.put("Dragon dagger", 25);
		COSTS.put("Abyssal dagger", 25);
		COSTS.put("Dark bow", 55);
		COSTS.put("Armadyl crossbow", 40);
		COSTS.put("Dragon crossbow", 60);
	}

	private Specials()
	{
	}

	/** The energy a weapon's special attack costs, or -1 if it isn't one we use. */
	public static int cost(String weapon)
	{
		if (weapon == null)
		{
			return -1;
		}
		for (Map.Entry<String, Integer> special : COSTS.entrySet())
		{
			if (weapon.startsWith(special.getKey()))
			{
				return special.getValue();
			}
		}
		return -1;
	}
}
