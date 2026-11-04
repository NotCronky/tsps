package com.tsps.gauntlethelper;

import com.google.inject.Provides;
import com.tsps.gauntlethelper.GauntletIds.Mode;
import com.tsps.gauntlethelper.GauntletIds.Style;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import javax.inject.Inject;
import net.runelite.api.ChatMessageType;
import net.runelite.api.Client;
import net.runelite.api.EquipmentInventorySlot;
import net.runelite.api.GameState;
import net.runelite.api.GroundObject;
import net.runelite.api.InventoryID;
import net.runelite.api.Item;
import net.runelite.api.ItemContainer;
import net.runelite.api.NPC;
import net.runelite.api.Projectile;
import net.runelite.api.events.AnimationChanged;
import net.runelite.api.events.ChatMessage;
import net.runelite.api.events.GameStateChanged;
import net.runelite.api.events.GameTick;
import net.runelite.api.events.GroundObjectDespawned;
import net.runelite.api.events.GroundObjectSpawned;
import net.runelite.api.events.HitsplatApplied;
import net.runelite.api.events.ItemContainerChanged;
import net.runelite.api.events.NpcChanged;
import net.runelite.api.events.NpcDespawned;
import net.runelite.api.events.NpcSpawned;
import net.runelite.api.events.ProjectileMoved;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.ui.overlay.OverlayManager;

@PluginDescriptor(
	name = "Gauntlet Helper",
	description = "Learning aid for the Gauntlet: a prep checklist, and the Hunllef's attack and protection counters",
	tags = {"gauntlet", "corrupted", "hunllef", "prifddinas", "learn"}
)
public class GauntletHelperPlugin extends Plugin
{
	@Inject
	private Client client;

	@Inject
	private ClientThread clientThread;

	@Inject
	private OverlayManager overlayManager;

	@Inject
	private GauntletHelperConfig config;

	@Inject
	private InfoOverlay infoOverlay;

	@Inject
	private ArenaOverlay arenaOverlay;

	final HunllefTracker tracker = new HunllefTracker();
	/** Inventory and worn items, by id. */
	Map<Integer, Integer> held = Collections.emptyMap();
	NPC hunllef;
	Mode mode;
	Style weapon = Style.MELEE;
	final Set<NPC> tornadoes = new HashSet<>();
	final Map<GroundObject, Integer> floor = new HashMap<>();
	/** Game tick until which the "prayers disabled" warning shows. */
	int prayersDisabledUntil = -1;
	private final Set<Projectile> seenProjectiles = Collections.newSetFromMap(new WeakHashMap<>());

	@Provides
	GauntletHelperConfig provideConfig(ConfigManager configManager)
	{
		return configManager.getConfig(GauntletHelperConfig.class);
	}

	@Override
	protected void startUp()
	{
		overlayManager.add(infoOverlay);
		overlayManager.add(arenaOverlay);
		// Items and NPCs can only be read on the client thread (startUp runs on Swing's).
		clientThread.invokeLater(() ->
		{
			readItems();
			if (client.getGameState() == GameState.LOGGED_IN)
			{
				for (NPC npc : client.getNpcs())
				{
					onNpcSpawned(new NpcSpawned(npc));
				}
			}
		});
	}

	@Override
	protected void shutDown()
	{
		overlayManager.remove(infoOverlay);
		overlayManager.remove(arenaOverlay);
		hunllef = null;
		tornadoes.clear();
		floor.clear();
		held = Collections.emptyMap();
	}

	int tick()
	{
		return client.getTickCount();
	}

	/** The Hunllef fight is on: it is in sight and has attacked (it waits in its room until then). */
	boolean fighting()
	{
		return hunllef != null && tracker.attacked;
	}

	/** In a run's preparation: carrying Gauntlet items, the fight not started. */
	boolean inPrep()
	{
		return !fighting() && GauntletIds.modeOf(held) != null;
	}

	/** Its first attack comes 2 ticks into the fight; tornadoes are timed from the fight's start. */
	private void beforeAttack()
	{
		if (!tracker.attacked)
		{
			tracker.tornadoTick = tick() - 2;
		}
	}

	List<PrepPlan.Row> prepRows()
	{
		Mode prepMode = GauntletIds.modeOf(held);
		return PrepPlan.plan(prepMode == null ? Mode.REGULAR : prepMode, held,
			config.armourTier().ordinal(), config.weaponTier().ordinal() + 1,
			config.bow(), config.staff(), config.halberd(), config.potions(), config.fish());
	}

	@Subscribe
	public void onGameStateChanged(GameStateChanged event)
	{
		if (event.getGameState() == GameState.LOADING || event.getGameState() == GameState.LOGIN_SCREEN)
		{
			// The maze is an instance: a region load clears what was tracked in it.
			tornadoes.clear();
			floor.clear();
			if (event.getGameState() == GameState.LOGIN_SCREEN)
			{
				hunllef = null;
			}
		}
	}

	@Subscribe
	public void onItemContainerChanged(ItemContainerChanged event)
	{
		if (event.getContainerId() == InventoryID.INVENTORY.getId() || event.getContainerId() == InventoryID.EQUIPMENT.getId())
		{
			readItems();
		}
	}

	private void readItems()
	{
		Map<Integer, Integer> counts = new HashMap<>();
		for (InventoryID id : new InventoryID[]{InventoryID.INVENTORY, InventoryID.EQUIPMENT})
		{
			ItemContainer container = client.getItemContainer(id);
			if (container == null)
			{
				continue;
			}
			for (Item item : container.getItems())
			{
				if (item.getId() > 0 && item.getQuantity() > 0)
				{
					counts.merge(item.getId(), item.getQuantity(), Integer::sum);
				}
			}
		}
		held = counts;
		ItemContainer equipment = client.getItemContainer(InventoryID.EQUIPMENT);
		Item wielded = equipment == null ? null : equipment.getItem(EquipmentInventorySlot.WEAPON.getSlotIdx());
		weapon = GauntletIds.weaponStyle(wielded == null ? -1 : wielded.getId());
	}

	@Subscribe
	public void onNpcSpawned(NpcSpawned event)
	{
		NPC npc = event.getNpc();
		Style protecting = GauntletIds.hunllefProtection(npc.getId());
		if (protecting != null)
		{
			hunllef = npc;
			mode = GauntletIds.hunllefMode(npc.getId());
			tracker.start(protecting, tick());
		}
		else if (GauntletIds.isTornado(npc.getId()))
		{
			tornadoes.add(npc);
		}
	}

	@Subscribe
	public void onNpcDespawned(NpcDespawned event)
	{
		if (event.getNpc() == hunllef)
		{
			hunllef = null;
		}
		tornadoes.remove(event.getNpc());
	}

	@Subscribe
	public void onNpcChanged(NpcChanged event)
	{
		if (event.getNpc() != hunllef)
		{
			return;
		}
		Style protecting = GauntletIds.hunllefProtection(hunllef.getId());
		if (protecting != null)
		{
			tracker.onProtection(protecting);
		}
	}

	@Subscribe
	public void onProjectileMoved(ProjectileMoved event)
	{
		Projectile projectile = event.getProjectile();
		if (hunllef == null || !seenProjectiles.add(projectile))
		{
			return;
		}
		Style style = GauntletIds.projectileStyle(projectile.getId());
		if (style != null)
		{
			beforeAttack();
			tracker.onAttack(style);
		}
	}

	@Subscribe
	public void onAnimationChanged(AnimationChanged event)
	{
		if (event.getActor() == hunllef && hunllef.getAnimation() == GauntletIds.ANIM_TORNADO)
		{
			beforeAttack();
			tracker.onTornadoes(tick());
		}
	}

	@Subscribe
	public void onHitsplatApplied(HitsplatApplied event)
	{
		// The Gauntlet is solo: every hit on the Hunllef is the player's.
		if (fighting() && event.getActor() == hunllef)
		{
			tracker.onPlayerHit(weapon);
		}
	}

	@Subscribe
	public void onChatMessage(ChatMessage event)
	{
		if (event.getType() == ChatMessageType.GAMEMESSAGE && event.getMessage().contains("Your prayers have been disabled"))
		{
			prayersDisabledUntil = tick() + 5;
		}
	}

	@Subscribe
	public void onGroundObjectSpawned(GroundObjectSpawned event)
	{
		int look = GauntletIds.floorLook(event.getGroundObject().getId());
		if (look > 0)
		{
			floor.put(event.getGroundObject(), look);
		}
	}

	@Subscribe
	public void onGroundObjectDespawned(GroundObjectDespawned event)
	{
		floor.remove(event.getGroundObject());
	}

	@Subscribe
	public void onGameTick(GameTick event)
	{
		if (hunllef != null && (hunllef.isDead() || hunllef.getId() < 0))
		{
			hunllef = null;
		}
	}
}
