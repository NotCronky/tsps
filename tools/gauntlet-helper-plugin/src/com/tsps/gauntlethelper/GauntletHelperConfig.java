package com.tsps.gauntlethelper;

import net.runelite.client.config.Config;
import net.runelite.client.config.ConfigGroup;
import net.runelite.client.config.ConfigItem;
import net.runelite.client.config.ConfigSection;
import net.runelite.client.config.Range;

@ConfigGroup("gauntlethelper")
public interface GauntletHelperConfig extends Config
{
	enum ArmourTier
	{
		NONE, BASIC, ATTUNED, PERFECTED
	}

	enum WeaponTier
	{
		BASIC, ATTUNED, PERFECTED
	}

	@ConfigSection(name = "Preparation", description = "The kit the checklist plans for", position = 0)
	String prep = "prep";

	@ConfigSection(name = "Hunllef", description = "The boss fight", position = 1)
	String boss = "boss";

	@ConfigItem(keyName = "showPrep", name = "Show prep checklist", description = "What's left to gather for your kit", section = prep, position = 0)
	default boolean showPrep()
	{
		return true;
	}

	@ConfigItem(keyName = "armourTier", name = "Armour", description = "Armour tier to make", section = prep, position = 1)
	default ArmourTier armourTier()
	{
		return ArmourTier.ATTUNED;
	}

	@ConfigItem(keyName = "weaponTier", name = "Weapons", description = "Weapon tier to make", section = prep, position = 2)
	default WeaponTier weaponTier()
	{
		return WeaponTier.PERFECTED;
	}

	@ConfigItem(keyName = "bow", name = "Bow", description = "Make a bow", section = prep, position = 3)
	default boolean bow()
	{
		return true;
	}

	@ConfigItem(keyName = "staff", name = "Staff", description = "Make a staff", section = prep, position = 4)
	default boolean staff()
	{
		return true;
	}

	@ConfigItem(keyName = "halberd", name = "Halberd", description = "Make a halberd", section = prep, position = 5)
	default boolean halberd()
	{
		return false;
	}

	@Range(max = 10)
	@ConfigItem(keyName = "potions", name = "Egniol potions", description = "Potions to make", section = prep, position = 6)
	default int potions()
	{
		return 3;
	}

	@Range(max = 28)
	@ConfigItem(keyName = "fish", name = "Paddlefish", description = "Fish to catch", section = prep, position = 7)
	default int fish()
	{
		return 16;
	}

	@ConfigItem(keyName = "showBoss", name = "Show fight info", description = "What to pray, what to hit with, and counters", section = boss, position = 0)
	default boolean showBoss()
	{
		return true;
	}

	@ConfigItem(keyName = "highlightTornadoes", name = "Highlight tornadoes", description = "Outline the tornadoes' tiles", section = boss, position = 1)
	default boolean highlightTornadoes()
	{
		return true;
	}

	@ConfigItem(keyName = "highlightFloor", name = "Highlight floor", description = "Mark tiles about to burn and burning", section = boss, position = 2)
	default boolean highlightFloor()
	{
		return true;
	}
}
