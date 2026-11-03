package com.cronky.tspsagility;

import com.google.inject.Provides;
import java.util.HashMap;
import java.util.Map;
import net.runelite.api.CollisionData;
import javax.inject.Inject;
import net.runelite.api.ChatMessageType;
import net.runelite.api.Client;
import net.runelite.api.DecorativeObject;
import net.runelite.api.GameObject;
import net.runelite.api.GameState;
import net.runelite.api.GroundObject;
import net.runelite.api.MenuAction;
import net.runelite.api.ObjectComposition;
import net.runelite.api.Player;
import net.runelite.api.Point;
import net.runelite.api.Skill;
import net.runelite.api.Tile;
import net.runelite.api.TileItem;
import net.runelite.api.TileObject;
import net.runelite.api.WallObject;
import net.runelite.api.coords.WorldPoint;
import net.runelite.api.events.CommandExecuted;
import net.runelite.api.events.GameTick;
import net.runelite.api.events.StatChanged;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.events.ConfigChanged;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.callback.ClientThread;
import net.runelite.api.Perspective;
import net.runelite.api.coords.LocalPoint;
import com.tsps.fakemouse.FakeMouse;
import java.awt.Rectangle;
import java.awt.Shape;

/**
 * Runs agility courses on the TSPS private server. It only ever acts on that server's world.
 * Each game tick it waits for the player to stop, then clicks the next obstacle; XP moves it on,
 * and an obstacle that gives none is skipped so it can find its place again after a fall.
 */
@PluginDescriptor(
	name = "TSPS Agility",
	description = "Runs agility courses on the TSPS server",
	tags = {"tsps", "agility", "laps"}
)
public class TspsAgilityPlugin extends Plugin
{
	/** How it shows on the fake mouse's banner. */
	private static final String MOUSE_OWNER = "TSPS Agility";
	/** The gateway's only world. Live worlds start at 301, so this is never a live one. */
	private static final int TSPS_WORLD = 1;
	private static final int MARK_OF_GRACE = 11849;
	private static final int IDLE_TICKS = 2;
	/** Ticks standing still after a click before that obstacle counts as missed. */
	private static final int CLICK_TIMEOUT_TICKS = 12;
	private static final int MARK_RANGE = 12;
	/** A reachable mark is walked to within this many steps; any further and it's not this part of the course. */
	private static final int MARK_WALK_STEPS = 24;
	/** Tries at one mark per lap, at least this many ticks apart, before leaving it to the next lap. */
	private static final int MARK_TRIES = 3;
	private static final int MARK_RETRY_TICKS = 10;
	private static final MenuAction[] OBJECT_OPS = {
		MenuAction.GAME_OBJECT_FIRST_OPTION, MenuAction.GAME_OBJECT_SECOND_OPTION, MenuAction.GAME_OBJECT_THIRD_OPTION,
		MenuAction.GAME_OBJECT_FOURTH_OPTION, MenuAction.GAME_OBJECT_FIFTH_OPTION,
	};

	@Inject
	private Client client;

	@Inject
	private TspsAgilityConfig config;

	@Inject
	private ConfigManager configManager;

	@Inject
	private ClientThread clientThread;

	private Courses.Course course;
	private int step;
	private boolean clicked;
	private int idleTicks;
	private int misses;
	private int laps;
	private int lastXp = -1;
	private WorldPoint lastPosition;
	/** Marks tried this lap: tile -> {tries, tick of the last try}. Cleared each lap. */
	private final Map<WorldPoint, int[]> markTries = new HashMap<>();
	private int tick;

	@Provides
	TspsAgilityConfig provideConfig(ConfigManager manager)
	{
		return manager.getConfig(TspsAgilityConfig.class);
	}

	@Override
	protected void shutDown()
	{
		releaseMouse();
		reset();
	}

	private static void releaseMouse()
	{
		FakeMouse mouse = FakeMouse.get();
		if (mouse != null)
		{
			mouse.release(MOUSE_OWNER);
		}
	}

	/**
	 * Holds the fake mouse while running laps, so the real mouse can't get in the way; Escape takes
	 * it back and stops the laps. False (and stopped) when it can't have it.
	 */
	private boolean holdMouse()
	{
		FakeMouse mouse = FakeMouse.get();
		if (mouse == null)
		{
			stop("TSPS Agility needs the TSPS Fake Mouse plugin turned on.");
			return false;
		}
		if (mouse.held() && !MOUSE_OWNER.equals(mouse.owner()))
		{
			stop("TSPS Agility stopped: " + mouse.owner() + " has the mouse.");
			return false;
		}
		mouse.take(MOUSE_OWNER, why -> clientThread.invoke(() -> stop("TSPS Agility stopped: " + why + ".")));
		return true;
	}

	/** Glides the fake mouse onto `target`, then clicks with `click` (at once when there's no target). */
	private void act(Point target, Runnable click)
	{
		FakeMouse mouse = FakeMouse.get();
		if (mouse == null || target == null)
		{
			click.run();
			return;
		}
		mouse.glideTo(target, click);
	}

	/** Glides onto somewhere inside `clickbox` (its size sets the timing), then clicks. */
	private void actOn(Shape clickbox, Runnable click)
	{
		FakeMouse mouse = FakeMouse.get();
		if (mouse == null || clickbox == null)
		{
			click.run();
			return;
		}
		mouse.glideTo(clickbox.getBounds(), click);
	}

	private static Point centre(Shape clickbox)
	{
		if (clickbox == null)
		{
			return null;
		}
		Rectangle bounds = clickbox.getBounds();
		return new Point((int) bounds.getCenterX(), (int) bounds.getCenterY());
	}

	private void reset()
	{
		course = null;
		step = 0;
		clicked = false;
		idleTicks = 0;
		misses = 0;
		laps = 0;
		lastPosition = null;
		markTries.clear();
	}

	/** "::tspsbot agility on" / "::tspsbot agility off" starts and stops laps from the chat box (the server has its own ::bot). */
	@Subscribe
	public void onCommandExecuted(CommandExecuted event)
	{
		String[] args = event.getArguments();
		if (!"tspsbot".equalsIgnoreCase(event.getCommand()) || args.length < 2 || !"agility".equalsIgnoreCase(args[0]))
		{
			return;
		}
		boolean on = "on".equalsIgnoreCase(args[1]) || "start".equalsIgnoreCase(args[1]);
		configManager.setConfiguration(TspsAgilityConfig.GROUP, TspsAgilityConfig.RUNNING, on);
		client.addChatMessage(ChatMessageType.GAMEMESSAGE, "", "TSPS Agility " + (on ? "started." : "stopped."), null);
	}

	@Subscribe
	public void onConfigChanged(ConfigChanged event)
	{
		if (TspsAgilityConfig.GROUP.equals(event.getGroup()) && TspsAgilityConfig.RUNNING.equals(event.getKey()))
		{
			reset();
		}
	}

	@Subscribe
	public void onStatChanged(StatChanged event)
	{
		if (event.getSkill() != Skill.AGILITY)
		{
			return;
		}
		boolean gained = lastXp >= 0 && event.getXp() > lastXp;
		lastXp = event.getXp();
		// One step per click: a lap's last obstacle can pay twice, for itself and the lap bonus.
		if (gained && clicked && course != null)
		{
			clicked = false;
			misses = 0;
			idleTicks = 0;
			step++;
			if (step >= course.steps.length)
			{
				step = 0;
				laps++;
				// A mark missed this lap gets another chance on the next.
				markTries.clear();
			}
		}
	}

	@Subscribe
	public void onGameTick(GameTick event)
	{
		tick++;
		if (!config.running())
		{
			releaseMouse();
			return;
		}
		if (client.getGameState() != GameState.LOGGED_IN)
		{
			return;
		}
		Player player = client.getLocalPlayer();
		if (player == null)
		{
			return;
		}
		if (client.getWorld() != TSPS_WORLD)
		{
			stop("TSPS Agility only runs on the TSPS server.");
			return;
		}
		if (client.getBoostedSkillLevel(Skill.HITPOINTS) <= config.stopHitpoints())
		{
			stop("TSPS Agility stopped: low Hitpoints.");
			return;
		}
		if (!holdMouse())
		{
			return;
		}
		if (course == null && !chooseCourse(player))
		{
			return;
		}
		WorldPoint position = player.getWorldLocation();
		boolean still = position.equals(lastPosition) && player.getAnimation() == -1
			&& player.getPoseAnimation() == player.getIdlePoseAnimation();
		idleTicks = still ? idleTicks + 1 : 0;
		lastPosition = position;
		if (idleTicks < IDLE_TICKS)
		{
			return;
		}
		if (clicked)
		{
			if (idleTicks >= CLICK_TIMEOUT_TICKS)
			{
				clicked = false;
				miss();
			}
			return;
		}
		if (config.marks() && course.marks && takeMark(position))
		{
			idleTicks = 0;
			return;
		}
		if (clickObstacle(player))
		{
			clicked = true;
			idleTicks = 0;
		}
		else
		{
			miss();
		}
	}

	/** Tries the next obstacle; a full pass of the course with nothing working means it's stuck. */
	private void miss()
	{
		misses++;
		if (misses > course.steps.length)
		{
			stop("TSPS Agility stopped: no obstacle worked. Check your level, or that you're on the course.");
			return;
		}
		step = (step + 1) % course.steps.length;
	}

	private void stop(String reason)
	{
		String summary = laps > 0 ? " (" + laps + " laps)" : "";
		releaseMouse();
		switchOff();
		client.addChatMessage(ChatMessageType.GAMEMESSAGE, "", reason + summary, null);
		reset();
	}

	void switchOff()
	{
		configManager.setConfiguration(TspsAgilityConfig.GROUP, TspsAgilityConfig.RUNNING, false);
	}

	/**
	 * The course with the most obstacles on this floor, starting from the nearest one if up on it.
	 * A rooftop course has only its first obstacle on the ground, so one match is enough.
	 */
	private boolean chooseCourse(Player player)
	{
		Courses.Course best = null;
		int bestMatches = 0;
		for (Courses.Course candidate : Courses.ALL)
		{
			int matches = 0;
			for (int[] ids : candidate.steps)
			{
				if (nearest(ids, player.getWorldLocation()) != null)
				{
					matches++;
				}
			}
			if (matches > bestMatches)
			{
				best = candidate;
				bestMatches = matches;
			}
		}
		if (best == null)
		{
			stop("TSPS Agility: stand near a supported course first.");
			return false;
		}
		course = best;
		step = client.getTopLevelWorldView().getPlane() == 0 ? 0 : nearestStep(player.getWorldLocation());
		client.addChatMessage(ChatMessageType.GAMEMESSAGE, "", "TSPS Agility: running " + course.name + ".", null);
		return true;
	}

	private int nearestStep(WorldPoint from)
	{
		int bestStep = 0;
		int bestDistance = Integer.MAX_VALUE;
		for (int index = 0; index < course.steps.length; index++)
		{
			Found found = nearest(course.steps[index], from);
			if (found != null && found.distance < bestDistance)
			{
				bestDistance = found.distance;
				bestStep = index;
			}
		}
		return bestStep;
	}

	private boolean clickObstacle(Player player)
	{
		Found found = nearest(course.steps[step], player.getWorldLocation());
		if (found == null)
		{
			return false;
		}
		ObjectComposition definition = client.getObjectDefinition(found.object.getId());
		if (definition.getImpostorIds() != null && definition.getImpostor() != null)
		{
			definition = definition.getImpostor();
		}
		String[] actions = definition.getActions();
		for (int op = 0; op < OBJECT_OPS.length && op < actions.length; op++)
		{
			if (actions[op] != null)
			{
				MenuAction action = OBJECT_OPS[op];
				String option = actions[op];
				String name = definition.getName();
				actOn(found.object.getClickbox(), () ->
					client.menuAction(found.scene.getX(), found.scene.getY(), action, found.object.getId(), -1, option, name));
				return true;
			}
		}
		return false;
	}

	private boolean takeMark(WorldPoint from)
	{
		for (Tile[] column : tiles())
		{
			for (Tile tile : column)
			{
				if (tile == null || tile.getGroundItems() == null)
				{
					continue;
				}
				for (TileItem item : tile.getGroundItems())
				{
					WorldPoint at = tile.getWorldLocation();
					if (item.getId() == MARK_OF_GRACE && from.distanceTo(at) <= MARK_RANGE && reachable(from, tile) && canTry(at))
					{
						int[] tries = markTries.computeIfAbsent(at, k -> new int[2]);
						tries[0]++;
						tries[1] = tick;
						Point scene = tile.getSceneLocation();
						LocalPoint local = tile.getLocalLocation();
						Point onScreen = local == null ? null : Perspective.localToCanvas(client, local, tile.getPlane());
						act(onScreen, () ->
							client.menuAction(scene.getX(), scene.getY(), MenuAction.GROUND_ITEM_THIRD_OPTION, MARK_OF_GRACE, -1, "Take", "Mark of grace"));
						return true;
					}
				}
			}
		}
		return false;
	}

	/** Whether this lap still allows a try at the mark on `at`: a few, spaced out. */
	private boolean canTry(WorldPoint at)
	{
		int[] tries = markTries.get(at);
		return tries == null || (tries[0] < MARK_TRIES && tick - tries[1] >= MARK_RETRY_TICKS);
	}

	/** Whether the mark's tile can be walked to from here: the same part of the course, not across a gap. */
	private boolean reachable(WorldPoint from, Tile tile)
	{
		CollisionData[] maps = client.getTopLevelWorldView().getCollisionMaps();
		LocalPoint here = LocalPoint.fromWorld(client.getTopLevelWorldView(), from);
		LocalPoint there = tile.getLocalLocation();
		int plane = client.getTopLevelWorldView().getPlane();
		if (maps == null || maps[plane] == null || here == null || there == null)
		{
			return false;
		}
		return Reach.reachable(maps[plane].getFlags(), here.getSceneX(), here.getSceneY(), there.getSceneX(), there.getSceneY(), MARK_WALK_STEPS);
	}

	private Tile[][] tiles()
	{
		return client.getTopLevelWorldView().getScene().getTiles()[client.getTopLevelWorldView().getPlane()];
	}

	/** The closest loc with one of `ids` on the player's plane, or null. */
	private Found nearest(int[] ids, WorldPoint from)
	{
		Found best = null;
		for (Tile[] column : tiles())
		{
			for (Tile tile : column)
			{
				if (tile != null)
				{
					best = closer(best, closest(tile, ids, from));
				}
			}
		}
		return best;
	}

	private Found closest(Tile tile, int[] ids, WorldPoint from)
	{
		Found best = null;
		for (GameObject object : tile.getGameObjects())
		{
			// A big loc is on every tile it covers; its own corner is the one the server expects.
			if (object != null && matches(object, ids) && tile.getSceneLocation().equals(object.getSceneMinLocation()))
			{
				best = closer(best, new Found(object, object.getSceneMinLocation(), from));
			}
		}
		WallObject wall = tile.getWallObject();
		DecorativeObject decoration = tile.getDecorativeObject();
		GroundObject ground = tile.getGroundObject();
		for (TileObject object : new TileObject[]{wall, decoration, ground})
		{
			if (object != null && matches(object, ids))
			{
				best = closer(best, new Found(object, tile.getSceneLocation(), from));
			}
		}
		return best;
	}

	private static boolean matches(TileObject object, int[] ids)
	{
		for (int id : ids)
		{
			if (object.getId() == id)
			{
				return true;
			}
		}
		return false;
	}

	private static Found closer(Found first, Found second)
	{
		if (first == null || second == null)
		{
			return first == null ? second : first;
		}
		return second.distance < first.distance ? second : first;
	}

	private static final class Found
	{
		final TileObject object;
		final Point scene;
		final int distance;

		Found(TileObject object, Point scene, WorldPoint from)
		{
			this.object = object;
			this.scene = scene;
			this.distance = from.distanceTo(object.getWorldLocation());
		}
	}
}
