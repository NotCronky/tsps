package com.tsps.farmrun;

import com.tsps.fakemouse.FakeMouse;
import java.awt.Canvas;
import java.awt.Rectangle;
import java.awt.Shape;
import java.awt.event.KeyEvent;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.BiPredicate;
import javax.swing.SwingUtilities;
import net.runelite.api.Client;
import net.runelite.api.GameObject;
import net.runelite.api.GameState;
import net.runelite.api.Item;
import net.runelite.api.ItemComposition;
import net.runelite.api.ItemContainer;
import net.runelite.api.MenuAction;
import net.runelite.api.NPC;
import net.runelite.api.NPCComposition;
import net.runelite.api.ObjectComposition;
import net.runelite.api.Player;
import net.runelite.api.Point;
import net.runelite.api.Tile;
import net.runelite.api.TileObject;
import net.runelite.api.WorldView;
import net.runelite.api.coords.LocalPoint;
import net.runelite.api.coords.WorldPoint;
import net.runelite.api.Perspective;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.api.widgets.Widget;

/**
 * Everything the run does in the game, as the menu actions a player's clicks make. Call on the
 * client thread. Walking is the one exception: the API has no walk target, so it clicks the
 * minimap like a player would.
 */
final class Game
{
	static final int INVENTORY = 93;
	static final int BANK = 95;
	/** Inventory item ops 1-5 are widget ops 2, 3, 4, 6 and 7; op 5 is Use (the server's ItemActionPacketListener). */
	private static final int[] INVENTORY_OPS = {2, 3, 4, 6, 7};
	private static final MenuAction[] OBJECT_OPTIONS = {
		MenuAction.GAME_OBJECT_FIRST_OPTION, MenuAction.GAME_OBJECT_SECOND_OPTION, MenuAction.GAME_OBJECT_THIRD_OPTION,
		MenuAction.GAME_OBJECT_FOURTH_OPTION, MenuAction.GAME_OBJECT_FIFTH_OPTION,
	};
	private static final MenuAction[] NPC_OPTIONS = {
		MenuAction.NPC_FIRST_OPTION, MenuAction.NPC_SECOND_OPTION, MenuAction.NPC_THIRD_OPTION,
		MenuAction.NPC_FOURTH_OPTION, MenuAction.NPC_FIFTH_OPTION,
	};
	private static final int[] CONTINUE_WIDGETS = {
		InterfaceID.ChatLeft.CONTINUE, InterfaceID.ChatRight.CONTINUE, InterfaceID.LevelupDisplay.CONTINUE,
		InterfaceID.Messagebox.CONTINUE,
	};

	private final Client client;

	Game(Client client)
	{
		this.client = client;
	}

	Client client()
	{
		return client;
	}

	WorldPoint position()
	{
		Player player = client.getLocalPlayer();
		return player == null ? null : player.getWorldLocation();
	}

	static WorldPoint point(int[] tile)
	{
		return new WorldPoint(tile[0], tile[1], tile[2]);
	}

	int distanceTo(int[] tile)
	{
		WorldPoint at = position();
		return at == null ? Integer.MAX_VALUE : at.distanceTo2D(point(tile));
	}

	boolean animating()
	{
		Player player = client.getLocalPlayer();
		return player != null && player.getAnimation() != -1;
	}

	boolean moving()
	{
		return client.getLocalDestinationLocation() != null;
	}

	// --- Items ---

	Item[] items(int container)
	{
		ItemContainer items = client.getItemContainer(container);
		return items == null ? new Item[0] : items.getItems();
	}

	int count(int container, int itemId)
	{
		return Arrays.stream(items(container)).filter(i -> i.getId() == itemId).mapToInt(Item::getQuantity).sum();
	}

	int slotOf(int itemId)
	{
		Item[] items = items(INVENTORY);
		for (int slot = 0; slot < items.length; slot++)
		{
			if (items[slot].getId() == itemId)
			{
				return slot;
			}
		}
		return -1;
	}

	int freeSlots()
	{
		Item[] items = items(INVENTORY);
		int used = (int) Arrays.stream(items).filter(i -> i.getId() > 0).count();
		return 28 - used;
	}

	String name(int itemId)
	{
		return client.getItemDefinition(itemId).getName();
	}

	/** Clicks an inventory item's option ("Break", "Teleport"); false if it hasn't that option. */
	boolean itemOption(int itemId, String option)
	{
		int slot = slotOf(itemId);
		if (slot < 0)
		{
			return false;
		}
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

	/**
	 * Use item on something: glides to the item and selects it, then glides to `target` and
	 * clicks it with `onTarget`. False if the item isn't in the inventory.
	 */
	private boolean useItem(int itemId, Shape target, Runnable onTarget)
	{
		int slot = slotOf(itemId);
		if (slot < 0)
		{
			return false;
		}
		act(inventorySlot(slot), () ->
		{
			client.menuAction(slot, InterfaceID.Inventory.ITEMS, MenuAction.WIDGET_TARGET, 0, itemId, "Use", name(itemId));
			act(target, onTarget);
		});
		return true;
	}

	// --- Objects ---

	/** The map object with `objectId` nearest `near` (within 12 tiles), or null when it isn't loaded. */
	TileObject object(int objectId, WorldPoint near)
	{
		return nearestObject(near, 12, (object, composition) -> object.getId() == objectId);
	}

	/**
	 * The nearest map object within `radius` of `near` whose name and options satisfy `test`. Every
	 * kind counts: the Grand Exchange's bank booths, for one, are walls (map type 0), not game objects.
	 */
	TileObject nearestObject(WorldPoint near, int radius, BiPredicate<TileObject, ObjectComposition> test)
	{
		WorldView view = client.getTopLevelWorldView();
		Tile[][] plane = view.getScene().getTiles()[view.getPlane()];
		TileObject best = null;
		int bestDistance = Integer.MAX_VALUE;
		for (Tile[] column : plane)
		{
			for (Tile tile : column)
			{
				if (tile == null)
				{
					continue;
				}
				List<TileObject> objects = new ArrayList<>();
				for (GameObject object : tile.getGameObjects())
				{
					if (object != null && object.getSceneMinLocation() != null)
					{
						objects.add(object);
					}
				}
				objects.add(tile.getWallObject());
				objects.add(tile.getDecorativeObject());
				objects.add(tile.getGroundObject());
				for (TileObject object : objects)
				{
					if (object == null)
					{
						continue;
					}
					int distance = object.getWorldLocation().distanceTo2D(near);
					if (distance > radius || distance >= bestDistance || !test.test(object, composition(object.getId())))
					{
						continue;
					}
					best = object;
					bestDistance = distance;
				}
			}
		}
		return best;
	}

	/** Where a menu click on an object points: a game object's south-west tile, else its own tile. */
	private static Point sceneOf(TileObject object)
	{
		if (object instanceof GameObject)
		{
			return ((GameObject) object).getSceneMinLocation();
		}
		LocalPoint local = object.getLocalLocation();
		return new Point(local.getSceneX(), local.getSceneY());
	}

	ObjectComposition composition(int objectId)
	{
		ObjectComposition composition = client.getObjectDefinition(objectId);
		if (composition != null && composition.getImpostorIds() != null)
		{
			ObjectComposition impostor = composition.getImpostor();
			if (impostor != null)
			{
				return impostor;
			}
		}
		return composition;
	}

	static int optionIndex(String[] actions, String option)
	{
		if (actions == null)
		{
			return -1;
		}
		for (int i = 0; i < actions.length; i++)
		{
			if (actions[i] != null && actions[i].equalsIgnoreCase(option))
			{
				return i;
			}
		}
		return -1;
	}

	boolean hasOption(TileObject object, String option)
	{
		return optionIndex(composition(object.getId()).getActions(), option) >= 0;
	}

	/** Clicks one of an object's options; false if it hasn't that option. */
	boolean objectOption(TileObject object, String option)
	{
		ObjectComposition composition = composition(object.getId());
		int index = optionIndex(composition.getActions(), option);
		if (index < 0 || index >= OBJECT_OPTIONS.length)
		{
			return false;
		}
		Point at = sceneOf(object);
		act(object.getClickbox(), () ->
			client.menuAction(at.getX(), at.getY(), OBJECT_OPTIONS[index], object.getId(), -1, option, composition.getName()));
		return true;
	}

	boolean useItemOn(int itemId, TileObject object)
	{
		Point at = sceneOf(object);
		String name = composition(object.getId()).getName();
		return useItem(itemId, object.getClickbox(), () ->
			client.menuAction(at.getX(), at.getY(), MenuAction.WIDGET_TARGET_ON_GAME_OBJECT, object.getId(), -1, "Use", name));
	}

	// --- NPCs ---

	NPC npc(String nameContains, int radius)
	{
		WorldPoint at = position();
		NPC best = null;
		for (NPC npc : client.getTopLevelWorldView().npcs())
		{
			NPCComposition composition = npcComposition(npc);
			if (composition == null || composition.getName() == null
				|| !composition.getName().toLowerCase().contains(nameContains.toLowerCase()))
			{
				continue;
			}
			if (at != null && npc.getWorldLocation().distanceTo2D(at) <= radius
				&& (best == null || npc.getWorldLocation().distanceTo2D(at) < best.getWorldLocation().distanceTo2D(at)))
			{
				best = npc;
			}
		}
		return best;
	}

	private static NPCComposition npcComposition(NPC npc)
	{
		NPCComposition composition = npc.getComposition();
		if (composition != null && composition.getConfigs() != null)
		{
			composition = composition.transform();
		}
		return composition;
	}

	boolean npcOption(NPC npc, String option)
	{
		NPCComposition composition = npcComposition(npc);
		int index = optionIndex(composition.getActions(), option);
		if (index < 0 || index >= NPC_OPTIONS.length)
		{
			return false;
		}
		act(npc.getConvexHull(), () -> client.menuAction(0, 0, NPC_OPTIONS[index], npc.getIndex(), -1, option, composition.getName()));
		return true;
	}

	boolean useItemOn(int itemId, NPC npc)
	{
		String name = npcComposition(npc).getName();
		return useItem(itemId, npc.getConvexHull(), () ->
			client.menuAction(0, 0, MenuAction.WIDGET_TARGET_ON_NPC, npc.getIndex(), -1, "Use", name));
	}

	// --- Widgets ---

	boolean visible(int widgetId)
	{
		Widget widget = client.getWidget(widgetId);
		return widget != null && !widget.isHidden();
	}

	/** Clicks op `op` (1-based) of a widget, or of its dynamic child `childIndex` (-1 for the widget itself). */
	void widgetOp(int widgetId, int childIndex, int op, String option)
	{
		act(widgetBounds(widgetId, childIndex), () ->
			client.menuAction(childIndex, widgetId, op > 5 ? MenuAction.CC_OP_LOW_PRIORITY : MenuAction.CC_OP, op, -1, option, ""));
	}

	/** The dynamic child of `widgetId` showing `itemId`, or null. */
	Widget itemChild(int widgetId, int itemId)
	{
		Widget widget = client.getWidget(widgetId);
		if (widget == null)
		{
			return null;
		}
		for (Widget child : widget.getDynamicChildren())
		{
			if (child != null && child.getItemId() == itemId && !child.isHidden())
			{
				return child;
			}
		}
		return null;
	}

	/**
	 * The first visible widget in interface `group` (a component or one of its dynamic children)
	 * with an op whose label satisfies `label`, searching components in order. Buttons a client
	 * script builds (the GE's quantity and price controls) are found by what they say, not by id.
	 */
	Widget findByOp(int group, java.util.function.Predicate<String> label)
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
			if (dynamic == null)
			{
				continue;
			}
			for (Widget d : dynamic)
			{
				if (d != null && !d.isHidden() && opIndex(d, label) >= 0)
				{
					return d;
				}
			}
		}
		return null;
	}

	/** The 0-based index of the widget's first op whose label satisfies `label`, or -1. */
	static int opIndex(Widget widget, java.util.function.Predicate<String> label)
	{
		String[] actions = widget.getActions();
		if (actions == null)
		{
			return -1;
		}
		for (int i = 0; i < actions.length; i++)
		{
			if (actions[i] != null && label.test(actions[i].replaceAll("<[^>]*>", "").trim()))
			{
				return i;
			}
		}
		return -1;
	}

	/** Whether `widget` is a dynamic child (which reports its parent's id and is clicked by index). */
	static boolean dynamic(Widget widget)
	{
		Widget parent = widget.getParent();
		if (parent == null || parent.getDynamicChildren() == null)
		{
			return false;
		}
		for (Widget child : parent.getDynamicChildren())
		{
			if (child == widget)
			{
				return true;
			}
		}
		return false;
	}

	/** Clicks the op of `widget` whose label satisfies `label`; false if it has none. */
	boolean clickOp(Widget widget, java.util.function.Predicate<String> label)
	{
		int index = widget == null ? -1 : opIndex(widget, label);
		if (index < 0)
		{
			return false;
		}
		widgetOp(widget.getId(), dynamic(widget) ? widget.getIndex() : -1, index + 1, widget.getActions()[index]);
		return true;
	}

	/** Clicks "Click here to continue" on any open chat box; true if there was one. */
	boolean continueDialogue()
	{
		for (int id : CONTINUE_WIDGETS)
		{
			if (visible(id))
			{
				act(widgetBounds(id, -1), () -> client.menuAction(-1, id, MenuAction.WIDGET_CONTINUE, 0, -1, "Continue", ""));
				return true;
			}
		}
		return false;
	}

	/** Closes whatever interface is open with its own close button (an op named "Close"). */
	boolean closeInterface(int group)
	{
		for (int child = 0; child < 200; child++)
		{
			Widget widget = client.getWidget(group, child);
			if (widget == null)
			{
				continue;
			}
			if (closeIn(widget, false))
			{
				return true;
			}
		}
		return false;
	}

	/** A dynamic child reports its parent's id; its click names its index in the parent. */
	private boolean closeIn(Widget widget, boolean dynamic)
	{
		int index = optionIndex(widget.getActions(), "Close");
		if (index >= 0 && !widget.isHidden())
		{
			widgetOp(widget.getId(), dynamic ? widget.getIndex() : -1, index + 1, "Close");
			return true;
		}
		Widget[] children = widget.getDynamicChildren();
		if (children != null)
		{
			for (Widget child : children)
			{
				if (child != null && closeIn(child, true))
				{
					return true;
				}
			}
		}
		return false;
	}

	// --- Walking ---

	/** A tile to walk to and the point in the game view where it is drawn. */
	static final class Aim
	{
		final WorldPoint tile;
		final Point onScreen;

		Aim(WorldPoint tile, Point onScreen)
		{
			this.tile = tile;
			this.onScreen = onScreen;
		}

		@Override
		public String toString()
		{
			return tile.getX() + "," + tile.getY() + " at screen " + onScreen.getX() + "," + onScreen.getY();
		}
	}

	/**
	 * Where to walk towards `target`: the tile itself, or a nearer point on the straight line to it,
	 * whichever is first drawn inside the game view. Null when none is (loading, or the camera
	 * points away).
	 */
	Aim aim(WorldPoint target)
	{
		if (client.getGameState() != GameState.LOGGED_IN)
		{
			return null;
		}
		WorldPoint at = position();
		for (int reach : new int[]{Integer.MAX_VALUE, 10, 7, 5, 3})
		{
			WorldPoint tile = towards(at, target, reach);
			LocalPoint local = LocalPoint.fromWorld(client.getTopLevelWorldView(), tile);
			Point onScreen = local == null ? null : Perspective.localToCanvas(client, local, tile.getPlane());
			if (onScreen == null)
			{
				continue;
			}
			int x = onScreen.getX() - client.getViewportXOffset();
			int y = onScreen.getY() - client.getViewportYOffset();
			if (x > 4 && y > 4 && x < client.getViewportWidth() - 4 && y < client.getViewportHeight() - 4)
			{
				return new Aim(tile, onScreen);
			}
		}
		return null;
	}

	/**
	 * The client's "Walk here" walks to the tile the scene marks as under the mouse (it ignores the
	 * menu action's coordinates), so walking is: move the fake mouse over the tile, then, once the
	 * client reports that tile as hovered, "Walk here". False without the fake mouse.
	 */
	boolean hover(Point point)
	{
		FakeMouse mouse = FakeMouse.get();
		if (mouse == null)
		{
			return false;
		}
		mouse.glideTo(point, null);
		return true;
	}

	/**
	 * Does `click` the way a player would: the fake mouse glides onto `target` (a clickbox or a
	 * widget's bounds) and the click happens when it arrives. Without the fake mouse, or with
	 * nothing to aim at, it clicks at once. Callers wait while busy().
	 */
	private void act(Shape target, Runnable click)
	{
		FakeMouse mouse = FakeMouse.get();
		if (mouse == null || target == null)
		{
			click.run();
			return;
		}
		mouse.glideTo(target.getBounds(), click);
	}

	/** Whether the fake mouse is still on its way to something. */
	boolean busy()
	{
		FakeMouse mouse = FakeMouse.get();
		return mouse != null && mouse.busy();
	}

	private Rectangle inventorySlot(int slot)
	{
		Widget inventory = client.getWidget(InterfaceID.Inventory.ITEMS);
		Widget item = inventory == null || inventory.isHidden() ? null : inventory.getChild(slot);
		return item == null ? null : item.getBounds();
	}

	private Rectangle widgetBounds(int widgetId, int childIndex)
	{
		Widget widget = client.getWidget(widgetId);
		if (widget != null && childIndex >= 0)
		{
			widget = widget.getChild(childIndex);
		}
		return widget == null || widget.isHidden() ? null : widget.getBounds();
	}

	/** The tile the client has under the mouse, or null. */
	WorldPoint hovered()
	{
		Tile tile = client.getTopLevelWorldView().getSelectedSceneTile();
		return tile == null ? null : tile.getWorldLocation();
	}

	/** "Walk here" to the hovered tile. */
	void walkHere()
	{
		client.menuAction(0, 0, MenuAction.WALK, 0, 0, "Walk here", "");
	}

	String mouse()
	{
		Point mouse = client.getMouseCanvasPosition();
		return mouse == null ? "none" : mouse.getX() + "," + mouse.getY();
	}

	/** The point `reach` tiles from `from` on the way to `to` (or `to` itself when nearer). */
	static WorldPoint towards(WorldPoint from, WorldPoint to, int reach)
	{
		int dx = to.getX() - from.getX();
		int dy = to.getY() - from.getY();
		int distance = Math.max(Math.abs(dx), Math.abs(dy));
		if (distance <= reach)
		{
			return to;
		}
		return new WorldPoint(from.getX() + dx * reach / distance, from.getY() + dy * reach / distance, to.getPlane());
	}


	/** Types `text` into the game, as keystrokes (the chatbox search reads them as a player's typing). */
	void type(String text)
	{
		Canvas canvas = client.getCanvas();
		SwingUtilities.invokeLater(() ->
		{
			long now = System.currentTimeMillis();
			for (char c : text.toCharArray())
			{
				int code = KeyEvent.getExtendedKeyCodeForChar(c);
				canvas.dispatchEvent(new KeyEvent(canvas, KeyEvent.KEY_PRESSED, now, 0, code, c));
				canvas.dispatchEvent(new KeyEvent(canvas, KeyEvent.KEY_TYPED, now, 0, KeyEvent.VK_UNDEFINED, c));
				canvas.dispatchEvent(new KeyEvent(canvas, KeyEvent.KEY_RELEASED, now, 0, code, c));
			}
		});
	}

	int varbit(int id)
	{
		return client.getVarbitValue(id);
	}

	int varp(int id)
	{
		return client.getVarpValue(id);
	}
}
