package com.tsps.farmrun;

import com.google.gson.Gson;
import com.google.inject.Provides;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.List;
import javax.inject.Inject;
import javax.swing.SwingUtilities;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.ChatMessageType;
import net.runelite.api.Client;
import net.runelite.api.GameState;
import net.runelite.api.Skill;
import net.runelite.api.events.ChatMessage;
import net.runelite.api.events.CommandExecuted;
import net.runelite.api.events.GameStateChanged;
import net.runelite.api.events.GameTick;
import net.runelite.client.Notifier;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import com.tsps.fakemouse.FakeMouse;
import net.runelite.client.ui.ClientToolbar;
import net.runelite.client.ui.NavigationButton;

/**
 * Herb and allotment runs for the TSPS server: tells you when your herbs are ready, and runs the
 * farm run itself (buying, banking, teleporting, raking, planting and noting), starting on its own
 * when nothing is planted. Does nothing on any other server.
 */
@Slf4j
@PluginDescriptor(name = "TSPS Farm Run", description = "Herb and allotment runs on the TSPS server", tags = {"farming", "herb", "tsps"})
public class FarmRunPlugin extends Plugin
{
	static final String MOUSE_OWNER = "TSPS Farm Run";
	private static final int CHECK_EVERY_TICKS = 10;

	@Inject
	private Client client;
	@Inject
	private ClientThread clientThread;
	@Inject
	private ClientToolbar clientToolbar;
	@Inject
	private ConfigManager configManager;
	@Inject
	private Notifier notifier;
	@Inject
	private Gson gson;
	@Inject
	private FarmRunConfig config;

	private GameData data;
	private Tracker tracker;
	private Game game;
	private FarmRunPanel panel;
	private NavigationButton navigation;
	private FarmRun run;
	private int ticks;
	private boolean autoStartedThisLogin;
	private long notifiedFor;

	@Provides
	FarmRunConfig provideConfig(ConfigManager configManager)
	{
		return configManager.getConfig(FarmRunConfig.class);
	}

	@Override
	protected void startUp()
	{
		data = GameData.load(gson);
		tracker = new Tracker(configManager, gson);
		tracker.load();
		game = new Game(client);
		panel = new FarmRunPanel(() -> clientThread.invoke(() -> start(false)), () -> clientThread.invoke(() -> stop("Stopped.")));
		navigation = NavigationButton.builder().tooltip("TSPS Farm Run").icon(icon()).priority(7).panel(panel).build();
		clientToolbar.addNavigation(navigation);
	}

	private static void releaseMouse()
	{
		FakeMouse mouse = FakeMouse.get();
		if (mouse != null)
		{
			mouse.release(MOUSE_OWNER);
		}
	}

	@Override
	protected void shutDown()
	{
		run = null;
		releaseMouse();
		clientToolbar.removeNavigation(navigation);
	}

	private static BufferedImage icon()
	{
		BufferedImage image = new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB);
		Graphics2D g = image.createGraphics();
		g.setColor(new Color(0x3c8c2f));
		g.fillOval(2, 2, 12, 12);
		g.setColor(new Color(0x6b4a2b));
		g.fillRect(7, 9, 2, 6);
		g.dispose();
		return image;
	}

	private void status(String text)
	{
		SwingUtilities.invokeLater(() -> panel.setStatus(text));
	}

	private List<GameData.Location> enabledLocations()
	{
		List<GameData.Location> enabled = new ArrayList<>();
		for (GameData.Location location : data.locations)
		{
			boolean on;
			switch (location.key)
			{
				case "falador": on = config.falador(); break;
				case "catherby": on = config.catherby(); break;
				case "ardougne": on = config.ardougne(); break;
				case "morytania": on = config.morytania(); break;
				case "hosidius": on = config.hosidius(); break;
				default: on = false;
			}
			if (on)
			{
				enabled.add(location);
			}
		}
		return enabled;
	}

	/** Starts a run (client thread). */
	private void start(boolean automatic)
	{
		if (!ServerGuard.onTsps(client))
		{
			status("This plugin only runs on the TSPS server.");
			return;
		}
		if (run != null)
		{
			return;
		}
		FakeMouse mouse = FakeMouse.get();
		if (mouse == null)
		{
			status("Turn on the TSPS Fake Mouse plugin: runs walk with it.");
			return;
		}
		if (mouse.held())
		{
			status(mouse.owner() + " has the mouse; stop it first.");
			return;
		}
		List<GameData.Location> locations = enabledLocations();
		if (locations.isEmpty())
		{
			status("No farming spots are enabled in the plugin's settings.");
			return;
		}
		int compost = config.compost() == FarmRunConfig.CompostType.NONE ? -1 : data.supply(config.compost().item);
		java.util.function.Supplier<Plan> planner = () -> new Plan(data, locations, client.getBoostedSkillLevel(Skill.FARMING), compost,
			config.compostAll(), id -> game.count(Game.BANK, id) + game.count(Game.INVENTORY, id));
		try
		{
			run = new FarmRun(game, data, tracker, planner, this::status, this::log);
			mouse.take(MOUSE_OWNER, why -> clientThread.invoke(() -> stop("Stopped: " + why + ".")));
			log("---- run started (" + (automatic ? "automatic" : "Start button") + ") at " + game.position());
			status((automatic ? "Nothing is planted: starting a run. " : "Starting a run. ") + describe(planner.get()));
		}
		catch (FarmRun.Failed failed)
		{
			status(failed.getMessage());
		}
	}

	private static String describe(Plan plan)
	{
		List<String> crops = new ArrayList<>();
		for (GameData.Crop crop : new GameData.Crop[]{plan.herb, plan.flower, plan.allotment})
		{
			if (crop != null)
			{
				crops.add(crop.name);
			}
		}
		return "Planting " + String.join(", ", crops) + (plan.bottomless ? ", with your bottomless compost bucket." : ".");
	}

	private void stop(String why)
	{
		run = null;
		releaseMouse();
		status(why);
		log("stopped: " + why);
	}

	/** Appends to ~/.rlcustom/tsps-farm-run.log, so a run that goes wrong can be read back. */
	private void log(String line)
	{
		java.nio.file.Path file = java.nio.file.Paths.get(System.getProperty("user.home"), ".rlcustom", "tsps-farm-run.log");
		try
		{
			java.nio.file.Files.createDirectories(file.getParent());
			java.nio.file.Files.write(file, (java.time.LocalTime.now().withNano(0) + " " + line + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8),
				java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
		}
		catch (java.io.IOException e)
		{
			log.debug("couldn't write the farm run log", e);
		}
	}

	/** "::tspsbot farm start" / "::tspsbot farm stop" from the chat box (the server has its own ::bot). */
	@Subscribe
	public void onCommandExecuted(CommandExecuted event)
	{
		String[] args = event.getArguments();
		if (!"tspsbot".equalsIgnoreCase(event.getCommand()) || args.length < 2 || !"farm".equalsIgnoreCase(args[0]))
		{
			return;
		}
		if ("start".equalsIgnoreCase(args[1]) || "on".equalsIgnoreCase(args[1]))
		{
			start(false);
		}
		else
		{
			stop("Stopped.");
		}
	}

	@Subscribe
	public void onGameStateChanged(GameStateChanged event)
	{
		if (event.getGameState() == GameState.LOGIN_SCREEN || event.getGameState() == GameState.HOPPING)
		{
			autoStartedThisLogin = false;
			if (run != null)
			{
				stop("Logged out; the run stopped.");
			}
		}
	}

	@Subscribe
	public void onChatMessage(ChatMessage event)
	{
		if (run != null && (event.getType() == ChatMessageType.GAMEMESSAGE || event.getType() == ChatMessageType.SPAM))
		{
			run.gameMessage(event.getMessage());
		}
	}

	@Subscribe
	public void onGameTick(GameTick event)
	{
		if (!ServerGuard.onTsps(client))
		{
			if (run != null)
			{
				stop("Not on the TSPS server; the run stopped.");
			}
			return;
		}
		if (run != null)
		{
			try
			{
				if (run.tick())
				{
					run = null;
					releaseMouse();
					log("run complete");
					notifier.notify("Farm run complete.");
				}
			}
			catch (FarmRun.Failed failed)
			{
				stop("Stopped: " + failed.getMessage());
				notifier.notify("Farm run stopped: " + failed.getMessage());
			}
			catch (RuntimeException e)
			{
				log.warn("farm run failed", e);
				stop("Stopped after an error: " + e);
			}
			return;
		}
		if (++ticks % CHECK_EVERY_TICKS != 0)
		{
			return;
		}
		long now = System.currentTimeMillis();
		SwingUtilities.invokeLater(() -> panel.setPatches(timers(now)));
		long ready = tracker.herbsReadyAt(data);
		if (config.notifyReady() && ready > 0 && ready <= now && notifiedFor != ready)
		{
			notifiedFor = ready;
			notifier.notify("Your herbs are ready: time for a farm run.");
		}
		// The bots' test client sets tsps.bots.noautostart: tests start each bot themselves.
		if (config.autoStart() && !autoStartedThisLogin && tracker.nothingPlanted() && !Boolean.getBoolean("tsps.bots.noautostart"))
		{
			autoStartedThisLogin = true;
			start(true);
		}
	}

	private String timers(long now)
	{
		StringBuilder text = new StringBuilder();
		for (GameData.Location location : enabledLocations())
		{
			text.append(location.name).append('\n');
			for (GameData.Patch patch : location.patches)
			{
				Tracker.Planted planted = tracker.get(location, patch);
				text.append("  ").append(patch.type.charAt(0)).append(patch.type.substring(1).toLowerCase()).append(": ");
				if (planted == null)
				{
					text.append("nothing planted");
				}
				else
				{
					GameData.Crop crop = data.crop(planted.crop);
					long minutes = (planted.readyAt - now + 59_999) / 60_000;
					text.append(crop == null ? planted.crop : crop.name).append(minutes <= 0 ? ", ready" : ", ready in " + minutes + " min");
				}
				text.append('\n');
			}
		}
		return text.toString();
	}
}
