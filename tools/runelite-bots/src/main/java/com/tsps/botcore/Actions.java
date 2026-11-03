package com.tsps.botcore;

import com.tsps.fakemouse.FakeMouse;
import java.awt.Rectangle;
import java.awt.Shape;
import java.util.function.Predicate;
import net.runelite.api.Client;
import net.runelite.api.Item;
import net.runelite.api.ItemComposition;
import net.runelite.api.ItemContainer;
import net.runelite.api.MenuAction;
import net.runelite.api.NPC;
import net.runelite.api.NPCComposition;
import net.runelite.api.Player;
import net.runelite.api.Perspective;
import net.runelite.api.Point;
import net.runelite.api.Prayer;
import net.runelite.api.Tile;
import net.runelite.api.TileItem;
import net.runelite.api.coords.LocalPoint;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.api.widgets.Widget;

/**
 * What a profile can do, as a player's clicks: the fake mouse glides onto the target and the menu
 * action fires when it arrives (at once when there is nothing on screen to aim at, such as a
 * closed tab). Call on the client thread; while busy(), a click is still on its way.
 */
public final class Actions
{
	static final int INVENTORY = 93;
	static final int EQUIPMENT = 94;
	/** Inventory item ops 1-5 are widget ops 2, 3, 4, 6 and 7; op 5 is Use (the server's ItemActionPacketListener). */
	private static final int[] INVENTORY_OPS = {2, 3, 4, 6, 7};
	private static final MenuAction[] NPC_OPTIONS = {
		MenuAction.NPC_FIRST_OPTION, MenuAction.NPC_SECOND_OPTION, MenuAction.NPC_THIRD_OPTION,
		MenuAction.NPC_FOURTH_OPTION, MenuAction.NPC_FIFTH_OPTION,
	};

	private final Client client;

	public Actions(Client client)
	{
		this.client = client;
	}

	public boolean busy()
	{
		FakeMouse mouse = FakeMouse.get();
		return mouse != null && mouse.busy();
	}

	private void act(Shape target, Runnable click)
	{
		FakeMouse mouse = FakeMouse.get();
		if (mouse == null || target == null || target.getBounds().isEmpty())
		{
			click.run();
			return;
		}
		mouse.glideTo(target.getBounds(), click);
	}

	// --- Items ---

	public Item[] inventory()
	{
		ItemContainer items = client.getItemContainer(INVENTORY);
		return items == null ? new Item[0] : items.getItems();
	}

	public boolean wearing(int itemId)
	{
		ItemContainer worn = client.getItemContainer(EQUIPMENT);
		return worn != null && worn.contains(itemId);
	}

	/** The first inventory slot holding an item that satisfies `test` (by its definition), or -1. */
	public int slotWhere(Predicate<ItemComposition> test)
	{
		Item[] items = inventory();
		for (int slot = 0; slot < items.length; slot++)
		{
			if (items[slot].getId() > 0 && test.test(client.getItemDefinition(items[slot].getId())))
			{
				return slot;
			}
		}
		return -1;
	}

	public int slotOf(int itemId)
	{
		return slotWhere(item -> item.getId() == itemId);
	}

	/** An inventory item whose name starts with one of `names` (a potion family's doses), or -1. */
	public int slotNamed(String... names)
	{
		return slotWhere(item ->
		{
			String name = item.getName();
			for (String prefix : names)
			{
				if (name != null && name.startsWith(prefix))
				{
					return true;
				}
			}
			return false;
		});
	}

	public static boolean hasOption(ItemComposition item, String option)
	{
		for (String action : item.getInventoryActions())
		{
			if (option.equalsIgnoreCase(action))
			{
				return true;
			}
		}
		return false;
	}

	/** Clicks the inventory item in `slot`'s option ("Eat", "Drink", "Wield", "Break"); false if it has none. */
	public boolean itemOption(int slot, String option)
	{
		Item[] items = inventory();
		if (slot < 0 || slot >= items.length || items[slot].getId() <= 0)
		{
			return false;
		}
		int itemId = items[slot].getId();
		ItemComposition item = client.getItemDefinition(itemId);
		String[] actions = item.getInventoryActions();
		for (int i = 0; i < actions.length && i < INVENTORY_OPS.length; i++)
		{
			if (option.equalsIgnoreCase(actions[i]))
			{
				int op = INVENTORY_OPS[i];
				act(inventorySlot(slot), () -> client.menuAction(slot, InterfaceID.Inventory.ITEMS,
					op > 5 ? MenuAction.CC_OP_LOW_PRIORITY : MenuAction.CC_OP, op, itemId, option, item.getName()));
				return true;
			}
		}
		return false;
	}

	/** Wields or wears an inventory item. */
	public boolean equip(int slot)
	{
		return itemOption(slot, "Wield") || itemOption(slot, "Wear");
	}

	private Rectangle inventorySlot(int slot)
	{
		Widget inventory = client.getWidget(InterfaceID.Inventory.ITEMS);
		Widget item = inventory == null || inventory.isHidden() ? null : inventory.getChild(slot);
		return item == null || item.isHidden() ? null : item.getBounds();
	}

	public int freeSlots()
	{
		int used = 0;
		for (Item item : inventory())
		{
			if (item.getId() > 0)
			{
				used++;
			}
		}
		return 28 - used;
	}

	// --- Ground items ---

	/** Takes a ground item ("Take" is a ground item's third option). */
	public void take(Tile tile, TileItem item)
	{
		Point scene = tile.getSceneLocation();
		LocalPoint local = tile.getLocalLocation();
		Point onScreen = local == null ? null : Perspective.localToCanvas(client, local, tile.getPlane());
		Rectangle target = onScreen == null ? null : new Rectangle(onScreen.getX() - 8, onScreen.getY() - 8, 16, 16);
		String name = client.getItemDefinition(item.getId()).getName();
		act(target, () -> client.menuAction(scene.getX(), scene.getY(), MenuAction.GROUND_ITEM_THIRD_OPTION, item.getId(), -1, "Take", name));
	}

	// --- Widgets ---

	/** The first visible widget in `group` (or a dynamic child of one) with an op whose label satisfies `label`. */
	public Widget findByOp(int group, java.util.function.Predicate<String> label)
	{
		for (int child = 0; child < 200; child++)
		{
			Widget widget = client.getWidget(group, child);
			if (widget == null || widget.isHidden())
			{
				continue;
			}
			if (opIndex(widget, label) >= 0)
			{
				return widget;
			}
			Widget[] dynamic = widget.getDynamicChildren();
			for (int i = 0; dynamic != null && i < dynamic.length; i++)
			{
				if (dynamic[i] != null && !dynamic[i].isHidden() && opIndex(dynamic[i], label) >= 0)
				{
					return dynamic[i];
				}
			}
		}
		return null;
	}

	static int opIndex(Widget widget, java.util.function.Predicate<String> label)
	{
		String[] actions = widget.getActions();
		for (int i = 0; actions != null && i < actions.length; i++)
		{
			if (actions[i] != null && label.test(actions[i].replaceAll("<[^>]*>", "").trim()))
			{
				return i;
			}
		}
		return -1;
	}

	/** Clicks the op of `widget` whose label satisfies `label`; false if it has none. */
	public boolean clickOp(Widget widget, java.util.function.Predicate<String> label)
	{
		int index = widget == null ? -1 : opIndex(widget, label);
		if (index < 0)
		{
			return false;
		}
		boolean dynamic = widget.getParent() != null && widget.getParent().getDynamicChildren() != null
			&& java.util.Arrays.asList(widget.getParent().getDynamicChildren()).contains(widget);
		int childIndex = dynamic ? widget.getIndex() : -1;
		int widgetId = widget.getId();
		String option = widget.getActions()[index];
		act(widget.getBounds(), () -> client.menuAction(childIndex, widgetId, MenuAction.CC_OP, index + 1, -1, option, ""));
		return true;
	}

	/** Clicks a static widget's op `op` (1-based), aiming at it when it's on screen. */
	public void widgetOp(int widgetId, int op, String option)
	{
		Widget widget = client.getWidget(widgetId);
		Rectangle bounds = widget == null || widget.isHidden() ? null : widget.getBounds();
		act(bounds, () -> client.menuAction(-1, widgetId, MenuAction.CC_OP, op, -1, option, ""));
	}

	// --- Objects ---

	private static final MenuAction[] OBJECT_OPTIONS = {
		MenuAction.GAME_OBJECT_FIRST_OPTION, MenuAction.GAME_OBJECT_SECOND_OPTION, MenuAction.GAME_OBJECT_THIRD_OPTION,
		MenuAction.GAME_OBJECT_FOURTH_OPTION, MenuAction.GAME_OBJECT_FIFTH_OPTION,
	};

	/** Clicks an object's option number `op` (0 = first); the server walks the player to it. */
	public void objectOption(net.runelite.api.TileObject object, int op)
	{
		Point at = object instanceof net.runelite.api.GameObject
			? ((net.runelite.api.GameObject) object).getSceneMinLocation()
			: new Point(object.getLocalLocation().getSceneX(), object.getLocalLocation().getSceneY());
		net.runelite.api.ObjectComposition composition = client.getObjectDefinition(object.getId());
		if (composition != null && composition.getImpostorIds() != null && composition.getImpostor() != null)
		{
			composition = composition.getImpostor();
		}
		String[] actions = composition == null ? null : composition.getActions();
		String option = actions != null && op < actions.length && actions[op] != null ? actions[op] : "";
		String name = composition == null ? "" : composition.getName();
		act(object.getClickbox(), () -> client.menuAction(at.getX(), at.getY(), OBJECT_OPTIONS[op], object.getId(), -1, option, name));
	}

	// --- Spells ---

	static final int SPELLBOOK_GROUP = 218;

	/** The spellbook button named `spell` ("Ice Barrage"), by the name it shows; null if it isn't in the book. */
	public Widget spellButton(String spell)
	{
		for (int child = 0; child < 250; child++)
		{
			Widget widget = client.getWidget(SPELLBOOK_GROUP, child);
			String name = widget == null || widget.getName() == null ? "" : widget.getName().replaceAll("<[^>]*>", "").trim();
			if (name.equalsIgnoreCase(spell))
			{
				return widget;
			}
		}
		return null;
	}

	/** Casts `spell` on a player: select it in the spellbook, then click them. False if the book hasn't it. */
	public boolean castOn(String spell, Player player)
	{
		Widget button = spellButton(spell);
		if (button == null)
		{
			return false;
		}
		int widgetId = button.getId();
		Rectangle bounds = button.isHidden() ? null : button.getBounds();
		act(bounds, () ->
		{
			client.menuAction(-1, widgetId, MenuAction.WIDGET_TARGET, 0, -1, "Cast", spell);
			act(player.getConvexHull(), () ->
				client.menuAction(0, 0, MenuAction.WIDGET_TARGET_ON_PLAYER, player.getId(), -1, "Cast", player.getName()));
		});
		return true;
	}

	// --- Dialogue ---

	private static final int[] CONTINUE_WIDGETS = {
		InterfaceID.ChatLeft.CONTINUE, InterfaceID.ChatRight.CONTINUE, InterfaceID.LevelupDisplay.CONTINUE,
		InterfaceID.Messagebox.CONTINUE,
	};

	/** Clicks "Click here to continue" on any open chat box; true if there was one. */
	public boolean continueDialogue()
	{
		for (int id : CONTINUE_WIDGETS)
		{
			Widget widget = client.getWidget(id);
			if (widget != null && !widget.isHidden())
			{
				act(widget.getBounds(), () -> client.menuAction(-1, id, MenuAction.WIDGET_CONTINUE, 0, -1, "Continue", ""));
				return true;
			}
		}
		return false;
	}

	/** The options of an open "Select an option" menu (219:1), as shown; empty when none is open. */
	public java.util.List<String> dialogueOptions()
	{
		java.util.List<String> options = new java.util.ArrayList<>();
		Widget menu = client.getWidget(InterfaceID.Chatmenu.OPTIONS);
		if (menu == null || menu.isHidden() || menu.getDynamicChildren() == null)
		{
			return options;
		}
		for (Widget child : menu.getDynamicChildren())
		{
			options.add(child == null || child.getText() == null ? "" : child.getText().replaceAll("<[^>]*>", "").trim());
		}
		return options;
	}

	/** Picks the dialogue option whose text starts with `text` (ignoring case); false if there's none. */
	public boolean chooseOption(String text)
	{
		Widget menu = client.getWidget(InterfaceID.Chatmenu.OPTIONS);
		if (menu == null || menu.isHidden() || menu.getDynamicChildren() == null)
		{
			return false;
		}
		Widget[] children = menu.getDynamicChildren();
		for (int i = 0; i < children.length; i++)
		{
			Widget child = children[i];
			String shown = child == null || child.getText() == null ? "" : child.getText().replaceAll("<[^>]*>", "").trim();
			if (shown.toLowerCase().startsWith(text.toLowerCase()))
			{
				int index = i;
				int menuId = menu.getId();
				act(child.getBounds(), () -> client.menuAction(index, menuId, MenuAction.WIDGET_CONTINUE, 0, -1, "Continue", ""));
				return true;
			}
		}
		return false;
	}

	// --- Walking ---

	private net.runelite.api.coords.WorldPoint hoverAim;

	/**
	 * One step of walking towards `target`, as the farm run walks: the client's "Walk here" goes to
	 * the tile under the mouse, so the first call glides the fake mouse onto the target (or a nearer
	 * point on the way that is on screen), and the next, once the client shows that tile hovered,
	 * walks. Returns false when nothing on the way is on screen.
	 */
	public boolean walkStep(net.runelite.api.coords.WorldPoint target)
	{
		Player self = client.getLocalPlayer();
		if (self == null)
		{
			return false;
		}
		if (hoverAim != null)
		{
			Tile hovered = client.getTopLevelWorldView().getSelectedSceneTile();
			net.runelite.api.coords.WorldPoint aim = hoverAim;
			hoverAim = null;
			if (hovered != null && hovered.getWorldLocation().distanceTo2D(aim) <= 1)
			{
				client.menuAction(0, 0, MenuAction.WALK, 0, 0, "Walk here", "");
				return true;
			}
		}
		net.runelite.api.coords.WorldPoint from = self.getWorldLocation();
		for (int reach : new int[]{Integer.MAX_VALUE, 10, 7, 5, 3})
		{
			int dx = target.getX() - from.getX();
			int dy = target.getY() - from.getY();
			int distance = Math.max(Math.abs(dx), Math.abs(dy));
			net.runelite.api.coords.WorldPoint aim = distance <= reach ? target
				: new net.runelite.api.coords.WorldPoint(from.getX() + dx * reach / distance, from.getY() + dy * reach / distance, target.getPlane());
			LocalPoint local = LocalPoint.fromWorld(client.getTopLevelWorldView(), aim);
			Point onScreen = local == null ? null : Perspective.localToCanvas(client, local, aim.getPlane());
			if (onScreen == null)
			{
				continue;
			}
			int x = onScreen.getX() - client.getViewportXOffset();
			int y = onScreen.getY() - client.getViewportYOffset();
			if (x > 4 && y > 4 && x < client.getViewportWidth() - 4 && y < client.getViewportHeight() - 4)
			{
				FakeMouse mouse = FakeMouse.get();
				if (mouse == null)
				{
					return false;
				}
				hoverAim = aim;
				mouse.glideTo(onScreen, null);
				return true;
			}
		}
		return false;
	}

	// --- Prayers ---

	static final int PRAYERBOOK_GROUP = 541;

	/** The prayer's name as its button shows it ("Protect from Melee"). */
	static String label(Prayer prayer)
	{
		String[] words = prayer.name().toLowerCase().split("_");
		StringBuilder label = new StringBuilder();
		for (String word : words)
		{
			if (label.length() > 0)
			{
				label.append(' ');
			}
			label.append(word.equals("from") || word.equals("of") ? word : Character.toUpperCase(word.charAt(0)) + word.substring(1));
		}
		return label.toString();
	}

	/**
	 * The prayer book button for `prayer`, found by the name it shows: the book's components are
	 * not in the order their gameval names suggest (Protect from Melee is 541:23 on this cache,
	 * and 541:27, "PRAYER19", is Sharp Eye).
	 */
	private Widget prayerButton(Prayer prayer)
	{
		String wanted = label(prayer);
		for (int child = 0; child < 60; child++)
		{
			Widget widget = client.getWidget(PRAYERBOOK_GROUP, child);
			String name = widget == null || widget.getName() == null ? "" : widget.getName().replaceAll("<[^>]*>", "").trim();
			if (name.equalsIgnoreCase(wanted))
			{
				return widget;
			}
		}
		return null;
	}

	/** Turns `prayer` on or off if it isn't already; true if it clicked (false too when the book has no button for it). */
	public boolean prayer(Prayer prayer, boolean on)
	{
		if (client.isPrayerActive(prayer) == on)
		{
			return false;
		}
		Widget widget = prayerButton(prayer);
		if (widget == null)
		{
			// Not in this book right now (an arena's own prayer rules, say): nothing to click.
			return false;
		}
		int widgetId = widget.getId();
		Rectangle bounds = widget.isHidden() ? null : widget.getBounds();
		act(bounds, () -> client.menuAction(-1, widgetId, MenuAction.CC_OP, 1, -1, on ? "Activate" : "Deactivate", label(prayer)));
		return true;
	}

	// --- Players ---

	private static final MenuAction[] PLAYER_OPTIONS = {
		MenuAction.PLAYER_FIRST_OPTION, MenuAction.PLAYER_SECOND_OPTION, MenuAction.PLAYER_THIRD_OPTION,
		MenuAction.PLAYER_FOURTH_OPTION, MenuAction.PLAYER_FIFTH_OPTION, MenuAction.PLAYER_SIXTH_OPTION,
		MenuAction.PLAYER_SEVENTH_OPTION, MenuAction.PLAYER_EIGHTH_OPTION,
	};

	/** Clicks a player's option by name ("Attack" exists where the server offers it, as in the Wilderness). */
	public boolean playerOption(Player player, String option)
	{
		String[] options = client.getPlayerOptions();
		for (int i = 0; options != null && i < options.length && i < PLAYER_OPTIONS.length; i++)
		{
			if (options[i] != null && options[i].replaceAll("<[^>]*>", "").equalsIgnoreCase(option))
			{
				MenuAction action = PLAYER_OPTIONS[i];
				act(player.getConvexHull(), () -> client.menuAction(0, 0, action, player.getId(), -1, option, player.getName()));
				return true;
			}
		}
		return false;
	}

	/** Attacks an NPC or a player. */
	public boolean npcOrPlayerAttack(net.runelite.api.Actor actor)
	{
		if (actor instanceof Player)
		{
			return playerOption((Player) actor, "Attack");
		}
		return actor instanceof NPC && npcOption((NPC) actor, "Attack");
	}

	// --- NPCs ---

	public static NPCComposition composition(NPC npc)
	{
		NPCComposition composition = npc.getComposition();
		if (composition != null && composition.getConfigs() != null)
		{
			composition = composition.transform();
		}
		return composition;
	}

	/** Clicks one of an NPC's options ("Attack", "Talk-to"); false if it hasn't that option. */
	public boolean npcOption(NPC npc, String option)
	{
		NPCComposition composition = composition(npc);
		String[] actions = composition == null ? null : composition.getActions();
		if (actions == null)
		{
			return false;
		}
		for (int i = 0; i < actions.length && i < NPC_OPTIONS.length; i++)
		{
			if (option.equalsIgnoreCase(actions[i]))
			{
				MenuAction action = NPC_OPTIONS[i];
				String name = composition.getName();
				act(npc.getConvexHull(), () -> client.menuAction(0, 0, action, npc.getIndex(), -1, option, name));
				return true;
			}
		}
		return false;
	}
}
