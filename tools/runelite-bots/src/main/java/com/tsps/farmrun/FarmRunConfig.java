package com.tsps.farmrun;

import net.runelite.client.config.Config;
import net.runelite.client.config.ConfigGroup;
import net.runelite.client.config.ConfigItem;

@ConfigGroup(FarmRunConfig.GROUP)
public interface FarmRunConfig extends Config
{
	String GROUP = "tspsfarmrun";

	enum CompostType
	{
		NONE("None"), COMPOST("Compost"), SUPERCOMPOST("Supercompost"), ULTRACOMPOST("Ultracompost");

		final String item;

		CompostType(String item)
		{
			this.item = item;
		}
	}

	@ConfigItem(keyName = "autoStart", name = "Start when nothing is planted",
		description = "Start a run on its own when none of your patches have anything growing", position = 0)
	default boolean autoStart()
	{
		return true;
	}

	@ConfigItem(keyName = "notifyReady", name = "Notify when ready",
		description = "Send a notification when your herbs are ready to pick", position = 1)
	default boolean notifyReady()
	{
		return true;
	}

	@ConfigItem(keyName = "compost", name = "Compost", description = "The compost to put on patches before planting", position = 2)
	default CompostType compost()
	{
		return CompostType.ULTRACOMPOST;
	}

	@ConfigItem(keyName = "compostAll", name = "Compost every patch",
		description = "Compost the flower and allotment patches too, not just herbs (as inventory room allows)", position = 3)
	default boolean compostAll()
	{
		return false;
	}

	@ConfigItem(keyName = "falador", name = "Falador", description = "Include the Falador patches", position = 10)
	default boolean falador()
	{
		return true;
	}

	@ConfigItem(keyName = "catherby", name = "Catherby", description = "Include the Catherby patches", position = 11)
	default boolean catherby()
	{
		return true;
	}

	@ConfigItem(keyName = "ardougne", name = "Ardougne", description = "Include the Ardougne patches", position = 12)
	default boolean ardougne()
	{
		return true;
	}

	@ConfigItem(keyName = "morytania", name = "Morytania", description = "Include the Morytania patches", position = 13)
	default boolean morytania()
	{
		return true;
	}

	@ConfigItem(keyName = "hosidius", name = "Hosidius", description = "Include the Hosidius patches", position = 14)
	default boolean hosidius()
	{
		return true;
	}
}
