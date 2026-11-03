package com.tsps.farmrun;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import java.util.HashMap;
import java.util.Map;
import net.runelite.client.config.ConfigManager;

/** When each patch was planted and with what, kept between sessions in the RuneLite config. */
public final class Tracker
{
	public static final class Planted
	{
		public String crop;
		public long plantedAt;
		public long readyAt;
	}

	static final String KEY = "patches";
	private final ConfigManager config;
	private final Gson gson;
	private Map<String, Planted> patches = new HashMap<>();

	public Tracker(ConfigManager config, Gson gson)
	{
		this.config = config;
		this.gson = gson;
	}

	public static String key(GameData.Location location, GameData.Patch patch)
	{
		return location.key + ":" + patch.objectId;
	}

	public void load()
	{
		String json = config.getConfiguration(FarmRunConfig.GROUP, KEY);
		Map<String, Planted> loaded = json == null ? null : gson.fromJson(json, new TypeToken<Map<String, Planted>>() {}.getType());
		patches = loaded == null ? new HashMap<>() : loaded;
	}

	private void save()
	{
		config.setConfiguration(FarmRunConfig.GROUP, KEY, gson.toJson(patches));
	}

	public void planted(GameData.Location location, GameData.Patch patch, GameData.Crop crop, long now)
	{
		Planted planted = new Planted();
		planted.crop = crop.key;
		planted.plantedAt = now;
		planted.readyAt = now + crop.growMinutes() * 60_000L;
		patches.put(key(location, patch), planted);
		save();
	}

	/** Seen ready, harvested or empty: what was there no longer needs a timer. */
	public void cleared(GameData.Location location, GameData.Patch patch)
	{
		if (patches.remove(key(location, patch)) != null)
		{
			save();
		}
	}

	/** A crop seen growing that this plugin didn't plant: ready at most a full growth from now. */
	public void seenGrowing(GameData.Location location, GameData.Patch patch, GameData.Crop crop, long now)
	{
		if (crop != null && !patches.containsKey(key(location, patch)))
		{
			planted(location, patch, crop, now);
		}
	}

	public void seenReady(GameData.Location location, GameData.Patch patch, long now)
	{
		Planted planted = patches.get(key(location, patch));
		if (planted != null && planted.readyAt > now)
		{
			planted.readyAt = now;
			save();
		}
	}

	public Planted get(GameData.Location location, GameData.Patch patch)
	{
		return patches.get(key(location, patch));
	}

	public boolean nothingPlanted()
	{
		return patches.isEmpty();
	}

	/** When the last of the tracked herb patches is ready (herbs set the run's pace), or 0 if none. */
	public long herbsReadyAt(GameData data)
	{
		long latest = 0;
		for (GameData.Location location : data.locations)
		{
			for (GameData.Patch patch : location.patches)
			{
				Planted planted = get(location, patch);
				if (planted != null && "HERB".equals(patch.type))
				{
					latest = Math.max(latest, planted.readyAt);
				}
			}
		}
		return latest;
	}
}
