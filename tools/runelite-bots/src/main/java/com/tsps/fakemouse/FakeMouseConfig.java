package com.tsps.fakemouse;

import net.runelite.client.config.Config;
import net.runelite.client.config.ConfigGroup;
import net.runelite.client.config.ConfigItem;

@ConfigGroup("tspsfakemouse")
public interface FakeMouseConfig extends Config
{
	@ConfigItem(keyName = "speed", name = "Mouse speed",
		description = "How fast the bot's hand is: Relaxed, Human, or Fast (about twice Human, for quick reactions)")
	default MousePath.Speed speed()
	{
		return MousePath.Speed.HUMAN;
	}
}
