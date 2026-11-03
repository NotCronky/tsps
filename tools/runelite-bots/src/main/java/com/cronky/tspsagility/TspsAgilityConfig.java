package com.cronky.tspsagility;

import net.runelite.client.config.Config;
import net.runelite.client.config.ConfigGroup;
import net.runelite.client.config.ConfigItem;

@ConfigGroup(TspsAgilityConfig.GROUP)
public interface TspsAgilityConfig extends Config
{
	String GROUP = "tspsagility";
	String RUNNING = "running";

	@ConfigItem(
		keyName = RUNNING,
		name = "Run laps",
		description = "Stand near a course and tick this. It unticks itself when it stops.",
		position = 0
	)
	default boolean running()
	{
		return false;
	}

	@ConfigItem(
		keyName = "marks",
		name = "Pick up marks of grace",
		description = "Picks up marks near you between obstacles",
		position = 1
	)
	default boolean marks()
	{
		return true;
	}

	@ConfigItem(
		keyName = "stopHitpoints",
		name = "Stop at Hitpoints",
		description = "Stops when your Hitpoints reach this",
		position = 2
	)
	default int stopHitpoints()
	{
		return 5;
	}
}
