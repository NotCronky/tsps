package com.tsps.farmrun;

import com.google.gson.Gson;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * The run's game data: farming spots, their patches and teleports, the walking waypoints from
 * each teleport, crops and patch states. Generated from the server's own data by
 * scripts/generate-data.cjs; never edited by hand.
 */
public final class GameData
{
	public static final class Route
	{
		public int[] from;
		public int steps;
		public List<int[]> waypoints;
	}

	public static final class Teleport
	{
		/** "tablet" (a teletab) or "item-op" (jewellery or a cloak with its own option). */
		public String kind;
		public String option;
		public int[] landing;
		public Route route;
		public List<Integer> items;
		/** Whether the Grand Exchange sells its item (the Hosidius tablet, a redirected house tab, isn't tradeable). */
		public boolean buyable;
	}

	public static final class Patch
	{
		public String type;
		public int objectId;
		public int varbit;
		public int[] tile;
	}

	public static final class Location
	{
		public String key;
		public String name;
		public int[] target;
		public List<Patch> patches;
		public List<Teleport> teleports;
	}

	public static final class Place
	{
		public int[] target;
		public List<Teleport> teleports;
	}

	public static final class Crop
	{
		public String key;
		public String name;
		public String type;
		public int level;
		public int seedId;
		public int seedCount;
		public int produceId;
		public int minutesPerStage;
		public int stages;

		/** Minutes from planting to harvest. */
		public int growMinutes()
		{
			return minutesPerStage * stages;
		}
	}

	public Place grandExchange;
	public List<Location> locations;
	public List<Crop> crops;
	public Map<String, Integer> supplies;
	/** Patch type -> crop key (or WEEDS) -> stage name -> varbit values. */
	public Map<String, Map<String, Map<String, List<Integer>>>> states;

	public static GameData load(Gson gson)
	{
		try (Reader reader = new InputStreamReader(GameData.class.getResourceAsStream("farm-run-data.json"), StandardCharsets.UTF_8))
		{
			return gson.fromJson(reader, GameData.class);
		}
		catch (Exception e)
		{
			throw new IllegalStateException("farm-run-data.json is missing or unreadable", e);
		}
	}

	public int supply(String name)
	{
		Integer id = supplies.get(name);
		if (id == null)
		{
			throw new IllegalArgumentException("unknown supply " + name);
		}
		return id;
	}

	public Crop crop(String key)
	{
		return crops.stream().filter(c -> c.key.equals(key)).findFirst().orElse(null);
	}
}
