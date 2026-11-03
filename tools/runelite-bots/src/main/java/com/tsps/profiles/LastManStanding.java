package com.tsps.profiles;

import com.tsps.botcore.Actions;
import com.tsps.botcore.Bot;
import com.tsps.botcore.Profile;
import java.util.List;
import net.runelite.api.NPC;
import net.runelite.api.coords.WorldPoint;

/**
 * Last Man Standing (server/plugins/minigames/LastManStanding.plugin.js; docs/last-man-standing.md),
 * game after game:
 *
 * - In the Ferox Enclave lobby: talk to Lisa, "I'd like to play." then the mode (Competitive,
 *   else Casual when Competitive is refused); a first-timer hears her introduction first.
 * - In a waiting area: wait (the server's bots fill it).
 * - In a game (varbit br_ingame): back inside the safe zone when the fog has us, else the PvP
 *   fight with LMS rules ("Fight" on anyone), heading for the safe zone's centre when idle.
 * - After the game it's back in the lobby, and queues again.
 */
public final class LastManStanding implements Profile
{
	static final int BR_INGAME = 5314;
	static final int BR_SAFECOORD_X = 5320;
	static final int BR_SAFECOORD_Z = 5316;
	static final int BR_SAFERADIUS = 5317;
	/** The Ferox Enclave lobby (last-man-standing.json "lobby.bounds"). */
	static final int[] LOBBY = {3123, 3626, 3150, 3650};
	/** The waiting areas (the modes' "waiting"): x and y bounds, any floor. */
	static final int[] WAITING = {3138, 3639, 3145, 3645};
	/** Steps back inside the safe zone when this close to its edge. */
	static final int FOG_MARGIN = 3;

	static final int CHEST = 29069;
	static final int CRATE = 29081;
	static final int BLOODY_KEY = 20526;
	static final int BLOODIER_KEY = 20608;
	/** How far to go for a chest or crate, and how long one gets before it's given up on. */
	static final int LOOT_RADIUS = 25;
	static final int LOOT_WAIT_TICKS = 12;
	private final java.util.ArrayDeque<Integer> toWear = new java.util.ArrayDeque<>();
	private java.util.Set<Integer> before;
	private int lootClickAt = -20;

	private final PvpFighter fighter = new PvpFighter(PvpFighter.ARENA).roamTo(LastManStanding::safeCentre);
	private String mode = "Competitive";
	private boolean inGame;
	private int games;
	private int lastTalk = -20;
	private int talks;

	@Override
	public String key()
	{
		return "lms";
	}

	@Override
	public String name()
	{
		return "TSPS Last Man Standing";
	}

	static WorldPoint safeCentre(Bot bot)
	{
		int radius = bot.client.getVarbitValue(BR_SAFERADIUS);
		WorldPoint at = bot.position();
		if (radius <= 0 || at == null)
		{
			return null;
		}
		return new WorldPoint(bot.client.getVarbitValue(BR_SAFECOORD_X), bot.client.getVarbitValue(BR_SAFECOORD_Z), at.getPlane());
	}

	static boolean within(WorldPoint at, int[] box)
	{
		return at.getX() >= box[0] && at.getY() >= box[1] && at.getX() <= box[2] && at.getY() <= box[3];
	}

	@Override
	public String tick(Bot bot)
	{
		WorldPoint at = bot.position();
		if (at == null)
		{
			return null;
		}
		if (bot.client.getVarbitValue(BR_INGAME) == 1)
		{
			if (!inGame)
			{
				inGame = true;
				games++;
				bot.log("game " + games + " started (" + mode + ")");
				// A new load-out isn't loot: forget any chest still being watched from the last game.
				before = null;
				toWear.clear();
				fighter.start(bot);
			}
			return inGame(bot, at);
		}
		if (inGame)
		{
			inGame = false;
			bot.log("game " + games + " over");
			fighter.stop(bot);
		}
		if (within(at, WAITING))
		{
			talks = 0;
			return null;
		}
		if (within(at, LOBBY))
		{
			return joinGame(bot);
		}
		return "go to the Last Man Standing lobby in the Ferox Enclave first";
	}

	private String inGame(Bot bot, WorldPoint at)
	{
		// The fog first: inside the safe zone, or it eats the fight.
		WorldPoint centre = safeCentre(bot);
		int radius = bot.client.getVarbitValue(BR_SAFERADIUS);
		if (centre != null && at.distanceTo2D(centre) > radius - FOG_MARGIN && bot.client.getLocalDestinationLocation() == null)
		{
			if (bot.actions.walkStep(centre))
			{
				bot.log("back into the safe zone (radius " + radius + ")");
				return null;
			}
		}
		// Nobody on us: spend a key on a chest, or search a crate that's near, then wear what's better.
		if (!underAttack(bot) && loot(bot))
		{
			return null;
		}
		return fighter.tick(bot);
	}

	/** Whether a player or an NPC is attacking us, or we're attacking a player. */
	private static boolean underAttack(Bot bot)
	{
		net.runelite.api.Player self = bot.self();
		if (self.getInteracting() instanceof net.runelite.api.Player)
		{
			return true;
		}
		for (net.runelite.api.Player player : bot.client.getTopLevelWorldView().players())
		{
			if (player != null && player != self && player.getInteracting() == self)
			{
				return true;
			}
		}
		for (NPC npc : bot.client.getTopLevelWorldView().npcs())
		{
			if (npc != null && npc.getInteracting() == self)
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * Keys and crates (Loot.LastManStanding.js): a bloody key opens a chest (br_loot_chest_closed,
	 * first op), an announced crate (br_lootcrate) is searched. Armour that comes out is worn; a
	 * weapon joins the fight's weapon switching from the inventory.
	 */
	private boolean loot(Bot bot)
	{
		Actions act = bot.actions;
		// Wear new armour from the last chest or crate, a piece a tick.
		while (!toWear.isEmpty())
		{
			int slot = act.slotOf(toWear.peekFirst());
			toWear.pollFirst();
			if (slot >= 0 && act.equip(slot))
			{
				bot.log("wear " + bot.client.getItemDefinition(act.inventory()[slot].getId()).getName() + " from the loot");
				return true;
			}
		}
		if (before != null)
		{
			java.util.Set<Integer> now = inventoryIds(act);
			for (int id : now)
			{
				net.runelite.api.ItemComposition item = bot.client.getItemDefinition(id);
				if (!before.contains(id) && Actions.hasOption(item, "Wear"))
				{
					toWear.add(id);
				}
			}
			if (!now.equals(before) || bot.tickCount() - lootClickAt > LOOT_WAIT_TICKS)
			{
				before = null;
			}
			return !toWear.isEmpty();
		}
		boolean key = act.slotOf(BLOODY_KEY) >= 0 || act.slotOf(BLOODIER_KEY) >= 0;
		net.runelite.api.TileObject target = key ? bot.nearestObject(new int[]{CHEST}, LOOT_RADIUS) : null;
		if (target == null)
		{
			// A crate in reach is worth it whenever we're free; the broadcast only says one is coming.
			target = bot.nearestObject(new int[]{CRATE}, LOOT_RADIUS);
		}
		if (target == null || bot.tickCount() - lootClickAt < LOOT_WAIT_TICKS)
		{
			return false;
		}
		lootClickAt = bot.tickCount();
		before = inventoryIds(act);
		bot.log((target.getId() == CHEST ? "open a chest" : "search the crate") + " at " + target.getWorldLocation());
		act.objectOption(target, 0);
		return true;
	}

	private static java.util.Set<Integer> inventoryIds(Actions act)
	{
		java.util.Set<Integer> ids = new java.util.HashSet<>();
		for (net.runelite.api.Item item : act.inventory())
		{
			if (item.getId() > 0)
			{
				ids.add(item.getId());
			}
		}
		return ids;
	}

	/** Lisa: "I'd like to play." then the mode; her introduction first if it's never been heard. */
	private String joinGame(Bot bot)
	{
		Actions act = bot.actions;
		if (act.continueDialogue())
		{
			return null;
		}
		List<String> options = act.dialogueOptions();
		if (!options.isEmpty())
		{
			if (act.chooseOption(mode) || act.chooseOption("I'd like to play") || act.chooseOption("Tell me more"))
			{
				return null;
			}
			act.chooseOption("Cancel");
			return null;
		}
		if (bot.tickCount() - lastTalk < 8)
		{
			return null;
		}
		NPC lisa = bot.npc("Lisa", 25);
		if (lisa == null)
		{
			return "Lisa isn't nearby";
		}
		// Refusals can come as a message box the chat never sees: after three tries, Casual.
		if (++talks > 3 && mode.equals("Competitive"))
		{
			bot.log("Competitive didn't take after 3 tries: Casual instead");
			mode = "Casual";
			talks = 0;
		}
		lastTalk = bot.tickCount();
		bot.log("talk to Lisa (" + mode + ")");
		act.npcOption(lisa, "Talk-to");
		return null;
	}

	@Override
	public void message(Bot bot, String text)
	{
		if (inGame)
		{
			if (text.contains("find some loot"))
			{
				bot.log(text.replaceAll("<[^>]*>", ""));
			}
			if (text.contains("loot crate has appeared"))
			{
				bot.log("a loot crate appeared");
			}
			fighter.message(bot, text);
			return;
		}
		// Refused Competitive (requirements, members): Casual has none.
		if (mode.equals("Competitive") && (text.contains("total level") || text.contains("quest points")
			|| text.contains("members") || text.contains("forfeited")))
		{
			bot.log("Competitive refused (" + text + "): Casual instead");
			mode = "Casual";
		}
	}

	@Override
	public void stop(Bot bot)
	{
		fighter.stop(bot);
		bot.log(games + " games");
	}
}
