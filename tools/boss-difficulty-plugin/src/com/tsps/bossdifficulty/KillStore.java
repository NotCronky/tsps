package com.tsps.bossdifficulty;

import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * Kill counts saved between client restarts, one config key per account. The server sends the
 * counts as varps, which the client forgets on restart; the saved copy shows them until the
 * varps arrive again, and a count never goes down (the higher of saved and live wins).
 * Accounts are told apart by character name: a private server need not send the account hash
 * RuneLite's own per-account profiles rely on.
 */
final class KillStore
{
	static final String GROUP = "bossdifficulty";
	private static final String PREFIX = "kc_";

	private KillStore()
	{
	}

	/** The config key for an account, e.g. "kc_iron_cronky" for "Iron Cronky". */
	static String key(String name)
	{
		String clean = name.replace('\u00A0', ' ').trim().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "_");
		return PREFIX + clean;
	}

	/** "1529:12,1733:3" (varp:count) into a map; anything unreadable is skipped. */
	static Map<Integer, Integer> parse(String saved)
	{
		Map<Integer, Integer> kills = new TreeMap<>();
		if (saved == null || saved.isEmpty())
		{
			return kills;
		}
		for (String pair : saved.split(","))
		{
			String[] parts = pair.split(":");
			if (parts.length != 2)
			{
				continue;
			}
			try
			{
				int varp = Integer.parseInt(parts[0].trim());
				int count = Integer.parseInt(parts[1].trim());
				if (count > 0)
				{
					kills.merge(varp, count, Math::max);
				}
			}
			catch (NumberFormatException ignored)
			{
				// skip it
			}
		}
		return kills;
	}

	static String format(Map<Integer, Integer> kills)
	{
		StringBuilder out = new StringBuilder();
		for (Map.Entry<Integer, Integer> entry : new TreeMap<>(kills).entrySet())
		{
			if (entry.getValue() <= 0)
			{
				continue;
			}
			if (out.length() > 0)
			{
				out.append(',');
			}
			out.append(entry.getKey()).append(':').append(entry.getValue());
		}
		return out.toString();
	}

	/** Merges a live count into the saved ones; true when the saved copy went up and needs writing. */
	static boolean merge(Map<Integer, Integer> saved, int varp, int live)
	{
		int stored = saved.getOrDefault(varp, 0);
		if (live > stored)
		{
			saved.put(varp, live);
			return true;
		}
		return false;
	}
}
