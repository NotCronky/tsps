package com.tsps.gauntlethelper;

import com.tsps.gauntlethelper.GauntletIds.Style;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.util.ArrayList;
import java.util.List;
import javax.inject.Inject;
import net.runelite.api.Client;
import net.runelite.api.GroundObject;
import net.runelite.api.coords.WorldPoint;
import net.runelite.client.ui.overlay.OverlayPanel;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.ui.overlay.components.LineComponent;
import net.runelite.client.ui.overlay.components.TitleComponent;

/** The side panel: the prep checklist during preparation, the fight's counters at the Hunllef. */
class InfoOverlay extends OverlayPanel
{
	private static final Color GOOD = new Color(0x55d655);
	private static final Color BAD = new Color(0xff5a4a);
	private static final Color MAGIC = new Color(0x4fa3ff);
	private static final Color RANGED = new Color(0x68d14f);
	private static final Color MELEE = new Color(0xe8b84a);

	private final Client client;
	private final GauntletHelperPlugin plugin;
	private final GauntletHelperConfig config;

	@Inject
	InfoOverlay(Client client, GauntletHelperPlugin plugin, GauntletHelperConfig config)
	{
		super(plugin);
		this.client = client;
		this.plugin = plugin;
		this.config = config;
		setPosition(OverlayPosition.TOP_LEFT);
	}

	@Override
	public Dimension render(Graphics2D graphics)
	{
		if (plugin.fighting() && config.showBoss())
		{
			renderFight();
		}
		else if (plugin.inPrep() && config.showPrep())
		{
			renderPrep();
		}
		else
		{
			return null;
		}
		panelComponent.setPreferredSize(new Dimension(190, 0));
		return super.render(graphics);
	}

	private void renderPrep()
	{
		panelComponent.getChildren().add(TitleComponent.builder().text("Gauntlet prep").color(Color.WHITE).build());
		boolean ready = true;
		for (PrepPlan.Row row : plugin.prepRows())
		{
			if (row.need <= 0 && row.have <= 0)
			{
				continue;
			}
			ready &= row.done();
			panelComponent.getChildren().add(LineComponent.builder()
				.left(row.label)
				.right(row.have + " / " + row.need)
				.rightColor(row.done() ? GOOD : Color.WHITE)
				.build());
		}
		if (ready)
		{
			line("Kit's ready: craft it at the bowl.", GOOD);
		}
	}

	private void renderFight()
	{
		HunllefTracker t = plugin.tracker;
		String name = plugin.mode == GauntletIds.Mode.CORRUPTED ? "Corrupted Hunllef" : "Crystalline Hunllef";
		panelComponent.getChildren().add(TitleComponent.builder().text(name).color(Color.WHITE).build());

		if (plugin.tick() < plugin.prayersDisabledUntil)
		{
			line("Prayers disabled: turn them back on!", BAD);
		}
		panelComponent.getChildren().add(LineComponent.builder()
			.left("Next attack: pray")
			.right(t.attackStyle == Style.MAGIC ? "Magic" : "Missiles")
			.rightColor(colour(t.attackStyle))
			.build());
		panelComponent.getChildren().add(LineComponent.builder()
			.left("Attacks before it switches")
			.right(String.valueOf(t.attacksLeft))
			.rightColor(t.attacksLeft == 1 ? BAD : Color.WHITE)
			.build());
		if (t.attacksLeft == GauntletIds.ATTACKS_PER_STYLE && t.attacked)
		{
			line("It just switched: change prayer once the last hit lands.", MELEE);
		}

		panelComponent.getChildren().add(LineComponent.builder()
			.left("It protects against")
			.right(t.protecting == null ? "?" : t.protecting.label)
			.rightColor(colour(t.protecting))
			.build());
		if (t.blocked(plugin.weapon))
		{
			line("Your " + plugin.weapon.label.toLowerCase() + " hits are blocked: switch weapon!", BAD);
		}
		else
		{
			line("Hit with: " + useInstead(t.protecting), Color.WHITE);
		}
		panelComponent.getChildren().add(LineComponent.builder()
			.left("Your hits until it switches")
			.right(String.valueOf(t.hitsLeft))
			.rightColor(t.hitsLeft <= 1 ? MELEE : Color.WHITE)
			.build());
		int ticks = t.ticksToTornadoes(plugin.tick());
		panelComponent.getChildren().add(LineComponent.builder()
			.left("Tornadoes in")
			.right(String.format("~%.1fs", ticks * 0.6))
			.rightColor(ticks <= 5 ? BAD : Color.WHITE)
			.build());
		if (standingOnBurningFloor())
		{
			line("Move! You're on a burning tile.", BAD);
		}
	}

	private boolean standingOnBurningFloor()
	{
		if (client.getLocalPlayer() == null)
		{
			return false;
		}
		WorldPoint here = client.getLocalPlayer().getWorldLocation();
		for (java.util.Map.Entry<GroundObject, Integer> tile : plugin.floor.entrySet())
		{
			if (tile.getValue() == 2 && tile.getKey().getWorldLocation().equals(here))
			{
				return true;
			}
		}
		return false;
	}

	private static String useInstead(Style protecting)
	{
		List<String> styles = new ArrayList<>();
		if (protecting != Style.RANGED)
		{
			styles.add("bow");
		}
		if (protecting != Style.MAGIC)
		{
			styles.add("staff");
		}
		if (protecting != Style.MELEE)
		{
			styles.add("halberd");
		}
		return String.join(" or ", styles);
	}

	private void line(String text, Color colour)
	{
		panelComponent.getChildren().add(LineComponent.builder().left(text).leftColor(colour).build());
	}

	private static Color colour(Style style)
	{
		if (style == null)
		{
			return Color.WHITE;
		}
		switch (style)
		{
			case MAGIC:
				return MAGIC;
			case RANGED:
				return RANGED;
			default:
				return MELEE;
		}
	}
}
