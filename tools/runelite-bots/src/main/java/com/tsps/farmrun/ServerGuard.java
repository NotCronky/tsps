package com.tsps.farmrun;

import net.runelite.api.Client;
import net.runelite.api.GameState;
import net.runelite.api.World;

/**
 * The plugin only acts on the TSPS server. Official worlds are numbered from 301; the TSPS
 * gateway serves world 1 with the activity "tsps". When the client has the world list loaded,
 * the current world must also be listed as tsps.
 */
public final class ServerGuard
{
	static final int FIRST_OFFICIAL_WORLD = 301;
	static final String ACTIVITY = "tsps";

	private ServerGuard()
	{
	}

	public static boolean onTsps(Client client)
	{
		if (client.getGameState() != GameState.LOGGED_IN && client.getGameState() != GameState.LOADING)
		{
			return false;
		}
		return allowed(client.getWorld(), client.getWorldList());
	}

	static boolean allowed(int world, World[] worldList)
	{
		if (world <= 0 || world >= FIRST_OFFICIAL_WORLD)
		{
			return false;
		}
		if (worldList == null || worldList.length == 0)
		{
			return true;
		}
		for (World listed : worldList)
		{
			if (listed != null && listed.getId() == world)
			{
				return ACTIVITY.equalsIgnoreCase(String.valueOf(listed.getActivity()).trim());
			}
		}
		return true;
	}
}
