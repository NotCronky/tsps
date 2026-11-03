package com.tsps.farmrun;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import net.runelite.api.World;
import org.junit.jupiter.api.Test;

class FarmRunTest
{
	private static final GameData DATA = GameData.load(new Gson());

	private static World world(int id, String activity)
	{
		return (World) Proxy.newProxyInstance(World.class.getClassLoader(), new Class<?>[]{World.class}, (proxy, method, args) ->
		{
			switch (method.getName())
			{
				case "getId": return id;
				case "getActivity": return activity;
				default: return null;
			}
		});
	}

	@Test
	void decodesPatchVarbitsWithTheServersStateTable()
	{
		assertEquals(PatchState.Stage.WEEDS, PatchState.decode(DATA, "HERB", 0).stage);
		assertEquals(PatchState.Stage.EMPTY, PatchState.decode(DATA, "HERB", 3).stage);
		PatchState growing = PatchState.decode(DATA, "HERB", 32);
		assertEquals(PatchState.Stage.GROWING, growing.stage);
		assertEquals("RANARR", growing.crop);
		assertEquals(PatchState.Stage.HARVESTABLE, PatchState.decode(DATA, "HERB", 38).stage);
		assertEquals(PatchState.Stage.DISEASED, PatchState.decode(DATA, "HERB", 140).stage);
		assertEquals(PatchState.Stage.DEAD, PatchState.decode(DATA, "ALLOTMENT", 199).stage);
		assertEquals(PatchState.Stage.GROWING, PatchState.decode(DATA, "ALLOTMENT", 70).stage, "watered counts as growing");
		assertEquals(PatchState.Stage.HARVESTABLE, PatchState.decode(DATA, "FLOWER", 12).stage);
	}

	@Test
	void picksTheHighestLevelCropAtTheFarmingLevel()
	{
		assertEquals("RANARR", CropPicker.best(DATA, "HERB", 32).key);
		assertEquals("HARRALANDER", CropPicker.best(DATA, "HERB", 31).key, "goutweed only grows at Trollheim");
		assertEquals("TORSTOL", CropPicker.best(DATA, "HERB", 99).key);
		assertNull(CropPicker.best(DATA, "HERB", 8));
		assertEquals("SNAPE_GRASS", CropPicker.best(DATA, "ALLOTMENT", 99).key);
		assertEquals("POTATO", CropPicker.best(DATA, "ALLOTMENT", 1).key);
		assertEquals("WHITE_LILY", CropPicker.best(DATA, "FLOWER", 70).key);
		assertNull(CropPicker.best(DATA, "FLOWER", 1));
	}

	@Test
	void geQuantityButtonsFollowTheServersPanel()
	{
		assertEquals(List.of(), GeButtons.quantityPresses(1));
		assertEquals(List.of(2, 2, 2, 2), GeButtons.quantityPresses(5));
		assertEquals(List.of(4, 2, 2, 2, 2, 2), GeButtons.quantityPresses(15));
		assertEquals(List.of(5, 4, 4), GeButtons.quantityPresses(120));
		assertEquals(List.of(4, 4, 4), GeButtons.quantityPresses(30));
	}

	@Test
	void onlyRunsOnTheTspsWorld()
	{
		assertTrue(ServerGuard.allowed(1, null));
		assertTrue(ServerGuard.allowed(1, new World[]{world(1, "tsps")}));
		assertFalse(ServerGuard.allowed(1, new World[]{world(1, "Trade - Members")}));
		assertFalse(ServerGuard.allowed(302, null), "official worlds start at 301");
		assertFalse(ServerGuard.allowed(0, null));
	}

	@Test
	void everySpotHasItsFourPatchesAndAWalkableRouteFromEachTeleport()
	{
		assertEquals(List.of("falador", "catherby", "ardougne", "morytania", "hosidius"),
			DATA.locations.stream().map(l -> l.key).collect(Collectors.toList()));
		for (GameData.Location location : DATA.locations)
		{
			Map<String, Long> types = location.patches.stream().collect(Collectors.groupingBy(p -> p.type, Collectors.counting()));
			assertEquals(Map.of("HERB", 1L, "FLOWER", 1L, "ALLOTMENT", 2L), types, location.name);
			assertTrue(location.teleports.stream().anyMatch(t -> "tablet".equals(t.kind)), location.name + " has a teletab");
			for (GameData.Teleport teleport : location.teleports)
			{
				assertRoute(location.name, teleport, location.target);
			}
		}
		for (GameData.Teleport teleport : DATA.grandExchange.teleports)
		{
			assertRoute("Grand Exchange", teleport, DATA.grandExchange.target);
		}
	}

	private static void assertRoute(String name, GameData.Teleport teleport, int[] target)
	{
		List<int[]> waypoints = teleport.route.waypoints;
		assertFalse(waypoints.isEmpty(), name);
		int[] previous = teleport.landing;
		for (int[] waypoint : waypoints)
		{
			int step = Math.max(Math.abs(waypoint[0] - previous[0]), Math.abs(waypoint[1] - previous[1]));
			assertTrue(step <= FarmRun.MINIMAP_REACH - 2, name + ": a waypoint " + step + " tiles on is past a minimap click");
			previous = waypoint;
		}
		int[] last = waypoints.get(waypoints.size() - 1);
		assertTrue(Math.max(Math.abs(last[0] - target[0]), Math.abs(last[1] - target[1])) <= 1, name + " ends at its patches");
	}

	@Test
	void planBuysSeedsCompostAndTabsAndPrefersJewelleryYouOwn()
	{
		int explorersRing = 13127;
		int ultracompost = DATA.supply("Ultracompost");
		Plan plan = new Plan(DATA, DATA.locations, 32, ultracompost, false, id -> id == explorersRing ? 1 : 0);
		assertEquals(List.of("Hosidius"), plan.unreachable.stream().map(l -> l.name).collect(Collectors.toList()),
			"Hosidius tablets can't be bought, and none are owned");
		assertEquals(4, plan.needs.get(5295), "a ranarr seed per herb patch");
		assertEquals(4, plan.needs.get(5100), "a limpwurt seed per flower patch");
		assertEquals(24, plan.needs.get(5323), "three strawberry seeds per allotment, two allotments per spot");
		assertEquals(4, plan.needs.get(ultracompost), "compost for the herbs");
		assertFalse(plan.needs.containsKey(19651), "never tries to buy the Hosidius tablet");
		assertTrue(plan.keep.contains(explorersRing), "the ring the player owns takes them to Falador");
		assertFalse(plan.needs.containsKey(8009), "so no Falador teletab");
		assertEquals(1, plan.needs.get(8010), "a Camelot teletab for Catherby");
		assertTrue(plan.keep.containsAll(List.of(DATA.supply("Rake"), DATA.supply("Seed dibber"), DATA.supply("Spade"))));
		int slots = plan.keep.size() + plan.needs.size() - 1 + plan.compostCount;
		assertTrue(slots <= 28 - Plan.SPARE_SLOTS, "leaves room for harvests: " + slots);
	}

	@Test
	void compostIsCutToTheInventoryRoom()
	{
		Plan plan = new Plan(DATA, DATA.locations, 99, DATA.supply("Ultracompost"), true, id -> 0);
		int other = plan.keep.size() + plan.needs.size() - 1;
		assertEquals(28 - Plan.SPARE_SLOTS - other, plan.compostCount);
	}

	@Test
	void aFilledBottomlessBucketReplacesTheCompostBuckets()
	{
		int filled = DATA.supply("Bottomless compost bucket (filled)");
		int empty = DATA.supply("Bottomless compost bucket (empty)");
		int ultracompost = DATA.supply("Ultracompost");
		Plan withBucket = new Plan(DATA, DATA.locations, 32, ultracompost, true, id -> id == filled ? 1 : 0);
		assertTrue(withBucket.bottomless);
		assertEquals(filled, withBucket.compostId);
		assertTrue(withBucket.keep.contains(filled), "the bucket comes along");
		assertFalse(withBucket.needs.containsKey(ultracompost), "no compost buckets bought or carried");
		assertEquals(0, withBucket.compostCount);

		Plan emptyBucket = new Plan(DATA, DATA.locations, 32, ultracompost, false, id -> id == empty ? 1 : 0);
		assertFalse(emptyBucket.bottomless, "an empty bucket has no compost to give");
		assertEquals(4, emptyBucket.needs.get(ultracompost));

		Plan noCompost = new Plan(DATA, DATA.locations, 32, -1, false, id -> id == filled ? 1 : 0);
		assertFalse(noCompost.bottomless, "compost turned off in the settings leaves the bucket in the bank");
		assertFalse(noCompost.keep.contains(filled));
	}

	@Test
	void hosidiusIsVisitedWhenItsTabletsAreOwned()
	{
		Plan plan = new Plan(DATA, DATA.locations, 32, -1, false, id -> id == 19651 ? 3 : 0);
		assertTrue(plan.unreachable.isEmpty());
		assertEquals(5, plan.locations.size());
		assertEquals(1, plan.needs.get(19651), "one owned tablet comes along");
	}

	@Test
	void walkingAimsAtNearerPointsOnTheWay()
	{
		net.runelite.api.coords.WorldPoint from = new net.runelite.api.coords.WorldPoint(2965, 3379, 0);
		net.runelite.api.coords.WorldPoint to = new net.runelite.api.coords.WorldPoint(2985, 3369, 0);
		assertEquals(to, Game.towards(from, to, Integer.MAX_VALUE));
		assertEquals(new net.runelite.api.coords.WorldPoint(2975, 3374, 0), Game.towards(from, to, 10));
		assertEquals(new net.runelite.api.coords.WorldPoint(2969, 3377, 0), Game.towards(from, to, 4));
	}
}
