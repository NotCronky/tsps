package com.tsps.botcore;

import java.util.function.Consumer;
import net.runelite.api.Actor;
import net.runelite.api.Client;
import net.runelite.api.NPC;
import net.runelite.api.Player;
import net.runelite.api.Skill;
import net.runelite.api.Tile;
import net.runelite.api.TileItem;
import net.runelite.api.coords.WorldPoint;

/** What a profile sees and does each tick: the game's state, the actions, and the run's log. */
public final class Bot
{
	/** Varp 102: poison (positive) or venom (1,000,000 and up); 0 when clean. */
	static final int POISON_VARP = 102;

	public final Client client;
	public final Actions actions;
	private final Consumer<String> log;
	private final java.util.function.IntToLongFunction price;
	private int tick;

	Bot(Client client, Actions actions, Consumer<String> log, java.util.function.IntToLongFunction price)
	{
		this.client = client;
		this.actions = actions;
		this.log = log;
		this.price = price;
	}

	/** An item's value: its Grand Exchange guide price, else its high alchemy value. */
	public long value(int itemId)
	{
		long guide = price.applyAsLong(itemId);
		return guide > 0 ? guide : client.getItemDefinition(itemId).getHaPrice();
	}

	/** A ground item and the tile it is on. */
	public static final class Loot
	{
		public final Tile tile;
		public final TileItem item;

		Loot(Tile tile, TileItem item)
		{
			this.tile = tile;
			this.item = item;
		}
	}

	/** Ground items within `radius` tiles of `near` on the player's floor. */
	public java.util.List<Loot> groundItems(WorldPoint near, int radius)
	{
		java.util.List<Loot> found = new java.util.ArrayList<>();
		net.runelite.api.WorldView view = client.getTopLevelWorldView();
		for (Tile[] column : view.getScene().getTiles()[view.getPlane()])
		{
			for (Tile tile : column)
			{
				if (tile == null || tile.getGroundItems() == null || tile.getWorldLocation().distanceTo2D(near) > radius)
				{
					continue;
				}
				for (TileItem item : tile.getGroundItems())
				{
					found.add(new Loot(tile, item));
				}
			}
		}
		return found;
	}

	void tick()
	{
		tick++;
	}

	/** Game ticks since the profile started. */
	public int tickCount()
	{
		return tick;
	}

	public void log(String line)
	{
		log.accept(line);
	}

	public Player self()
	{
		return client.getLocalPlayer();
	}

	public WorldPoint position()
	{
		Player self = self();
		return self == null ? null : self.getWorldLocation();
	}

	public int hitpoints()
	{
		return client.getBoostedSkillLevel(Skill.HITPOINTS);
	}

	public int maxHitpoints()
	{
		return client.getRealSkillLevel(Skill.HITPOINTS);
	}

	public int prayerPoints()
	{
		return client.getBoostedSkillLevel(Skill.PRAYER);
	}

	public boolean poisoned()
	{
		return client.getVarpValue(POISON_VARP) > 0;
	}

	/** What the player is attacking or talking to, or null. */
	public Actor target()
	{
		Player self = self();
		return self == null ? null : self.getInteracting();
	}

	/** The nearest map object (game object, wall, decoration or ground object) with one of `ids`, within `radius`. */
	public net.runelite.api.TileObject nearestObject(int[] ids, int radius)
	{
		WorldPoint at = position();
		net.runelite.api.WorldView view = client.getTopLevelWorldView();
		net.runelite.api.TileObject best = null;
		int bestDistance = Integer.MAX_VALUE;
		if (at == null)
		{
			return null;
		}
		for (Tile[] column : view.getScene().getTiles()[view.getPlane()])
		{
			for (Tile tile : column)
			{
				if (tile == null)
				{
					continue;
				}
				java.util.List<net.runelite.api.TileObject> objects = new java.util.ArrayList<>();
				for (net.runelite.api.GameObject object : tile.getGameObjects())
				{
					if (object != null && object.getSceneMinLocation() != null)
					{
						objects.add(object);
					}
				}
				objects.add(tile.getWallObject());
				objects.add(tile.getDecorativeObject());
				objects.add(tile.getGroundObject());
				for (net.runelite.api.TileObject object : objects)
				{
					if (object == null)
					{
						continue;
					}
					boolean wanted = false;
					for (int id : ids)
					{
						wanted |= object.getId() == id;
					}
					int distance = object.getWorldLocation().distanceTo2D(at);
					if (wanted && distance <= radius && distance < bestDistance)
					{
						best = object;
						bestDistance = distance;
					}
				}
			}
		}
		return best;
	}

	/** The nearest NPC named `name` (exactly, ignoring case) within `radius` tiles, or null. */
	public NPC npc(String name, int radius)
	{
		WorldPoint at = position();
		NPC best = null;
		for (NPC npc : client.getTopLevelWorldView().npcs())
		{
			if (npc == null || npc.getName() == null || !npc.getName().equalsIgnoreCase(name) || at == null)
			{
				continue;
			}
			int distance = npc.getWorldLocation().distanceTo2D(at);
			if (distance <= radius && (best == null || distance < best.getWorldLocation().distanceTo2D(at)))
			{
				best = npc;
			}
		}
		return best;
	}
}
