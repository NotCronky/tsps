package com.tsps.farmrun;

import java.util.List;
import java.util.Map;

/** What a patch's varbit value means: the crop in it and its stage. */
public final class PatchState
{
	public enum Stage
	{
		WEEDS, EMPTY, GROWING, HARVESTABLE, DISEASED, DEAD, UNKNOWN
	}

	public final Stage stage;
	/** The crop key, or null for weeds, an empty patch or an unknown value. */
	public final String crop;

	PatchState(Stage stage, String crop)
	{
		this.stage = stage;
		this.crop = crop;
	}

	/**
	 * Decodes a patch varbit with the server's state table. Weeds run 0-2 and 3 is a raked,
	 * empty patch (the WEEDS row lists them 3, 2, 1, 0).
	 */
	public static PatchState decode(GameData data, String patchType, int value)
	{
		Map<String, Map<String, List<Integer>>> table = data.states.get(patchType);
		if (table == null)
		{
			return new PatchState(Stage.UNKNOWN, null);
		}
		if (value >= 0 && value <= 3)
		{
			return new PatchState(value == 3 ? Stage.EMPTY : Stage.WEEDS, null);
		}
		for (Map.Entry<String, Map<String, List<Integer>>> crop : table.entrySet())
		{
			if (crop.getKey().equals("WEEDS"))
			{
				continue;
			}
			for (Map.Entry<String, List<Integer>> stage : crop.getValue().entrySet())
			{
				if (stage.getValue().contains(value))
				{
					return new PatchState(stageOf(stage.getKey()), crop.getKey());
				}
			}
		}
		return new PatchState(Stage.UNKNOWN, null);
	}

	private static Stage stageOf(String name)
	{
		switch (name)
		{
			case "HARVESTABLE":
				return Stage.HARVESTABLE;
			case "DISEASED":
				return Stage.DISEASED;
			case "DEAD":
				return Stage.DEAD;
			default:
				// GROWING and WATERED.
				return Stage.GROWING;
		}
	}

	@Override
	public String toString()
	{
		return crop == null ? stage.name() : stage + " " + crop;
	}
}
