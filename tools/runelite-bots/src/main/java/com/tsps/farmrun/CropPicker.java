package com.tsps.farmrun;

import java.util.Comparator;
import java.util.Set;

/** The best crop a Farming level can plant in each patch type: the highest-level one. */
public final class CropPicker
{
	/** Crops a run's patches can't grow: goutweed only grows in the Trollheim herb patch. */
	private static final Set<String> EXCLUDED = Set.of("GOUTWEED");

	private CropPicker()
	{
	}

	/** The highest-level crop of `type` at or below `level`, or null when none is plantable. */
	public static GameData.Crop best(GameData data, String type, int level)
	{
		return data.crops.stream()
			.filter(c -> c.type.equals(type) && c.level <= level && !EXCLUDED.contains(c.key))
			.max(Comparator.comparingInt((GameData.Crop c) -> c.level))
			.orElse(null);
	}
}
