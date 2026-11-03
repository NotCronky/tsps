package com.tsps.farmrun;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.ToIntFunction;

/**
 * What a run needs, worked out before it leaves the Grand Exchange: the best seeds for the
 * player's Farming level, compost, tools and one way to reach each farming spot.
 */
public final class Plan
{
	/** Slots kept free for harvests between visits to the leprechaun. */
	static final int SPARE_SLOTS = 6;

	public final List<GameData.Location> locations;
	/** Spots left out because the player owns no way there and the GE sells none. */
	public final List<GameData.Location> unreachable = new ArrayList<>();
	public final GameData.Crop herb;
	public final GameData.Crop flower;
	public final GameData.Crop allotment;
	public final int compostId;
	/** Item id -> how many the run carries. */
	public final Map<Integer, Integer> needs = new LinkedHashMap<>();
	/** Items the run carries one of each of and doesn't use up (tools, jewellery). */
	public final List<Integer> keep = new ArrayList<>();
	/** Compost buckets carried: herb patches get them first, then the rest as inventory room allows. */
	public final int compostCount;
	/** A filled bottomless compost bucket replaces the buckets: one slot, every patch. */
	public final boolean bottomless;
	/** Compost the flower and allotment patches too (a setting). */
	public final boolean compostEverything;

	/**
	 * @param owned how many of an item the player has in their bank and inventory together
	 * @param compost the compost item to use, or -1 for none
	 */
	public Plan(GameData data, List<GameData.Location> locations, int farmingLevel, int compost, boolean compostAll, ToIntFunction<Integer> owned)
	{
		this.locations = new ArrayList<>();
		for (GameData.Location location : locations)
		{
			(teleportFor(location, owned) == null ? unreachable : this.locations).add(location);
		}
		this.herb = CropPicker.best(data, "HERB", farmingLevel);
		this.flower = CropPicker.best(data, "FLOWER", farmingLevel);
		this.allotment = CropPicker.best(data, "ALLOTMENT", farmingLevel);
		int filledBucket = data.supply("Bottomless compost bucket (filled)");
		this.bottomless = compost >= 0 && owned.applyAsInt(filledBucket) > 0;
		this.compostId = bottomless ? filledBucket : compost;
		this.compostEverything = compostAll;
		int spots = this.locations.size();
		// A Varrock teleport tablet stays in the inventory, so the next run can start anywhere.
		for (String tool : new String[]{"Rake", "Seed dibber", "Spade", "Varrock teleport"})
		{
			keep.add(data.supply(tool));
		}
		if (bottomless)
		{
			keep.add(filledBucket);
		}
		if (herb != null)
		{
			needs.merge(herb.seedId, spots * herb.seedCount, Integer::sum);
		}
		if (flower != null)
		{
			needs.merge(flower.seedId, spots * flower.seedCount, Integer::sum);
		}
		if (allotment != null)
		{
			needs.merge(allotment.seedId, 2 * spots * allotment.seedCount, Integer::sum);
		}
		for (GameData.Location location : this.locations)
		{
			GameData.Teleport teleport = teleportFor(location, owned);
			int item = teleport.items.stream().filter(id -> owned.applyAsInt(id) > 0).findFirst().orElse(teleport.items.get(0));
			if ("tablet".equals(teleport.kind))
			{
				needs.merge(item, 1, Integer::sum);
			}
			else if (!keep.contains(item))
			{
				keep.add(item);
			}
		}
		int used = keep.size() + needs.size();
		int room = Math.max(0, 28 - SPARE_SLOTS - used);
		int wanted = compost < 0 || bottomless ? 0 : spots * (compostAll ? 4 : 1);
		compostCount = Math.min(room, wanted);
		if (compostCount > 0)
		{
			needs.put(compost, compostCount);
		}
	}

	/**
	 * The spot's first teleport the player owns the item for, else its first teletab the Grand
	 * Exchange sells, else null: the run can't get there.
	 */
	static GameData.Teleport teleportFor(GameData.Location location, ToIntFunction<Integer> owned)
	{
		for (GameData.Teleport teleport : location.teleports)
		{
			if (teleport.items.stream().anyMatch(id -> owned.applyAsInt(id) > 0))
			{
				return teleport;
			}
		}
		return location.teleports.stream().filter(t -> "tablet".equals(t.kind) && t.buyable).findFirst().orElse(null);
	}

	/** The crop a patch type gets this run. */
	public GameData.Crop cropFor(String patchType)
	{
		switch (patchType)
		{
			case "HERB":
				return herb;
			case "FLOWER":
				return flower;
			default:
				return allotment;
		}
	}
}
