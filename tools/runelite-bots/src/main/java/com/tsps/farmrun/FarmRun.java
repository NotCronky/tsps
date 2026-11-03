package com.tsps.farmrun;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import net.runelite.api.TileObject;
import net.runelite.api.GrandExchangeOffer;
import net.runelite.api.GrandExchangeOfferState;
import net.runelite.api.ItemComposition;
import net.runelite.api.NPC;
import net.runelite.api.Skill;
import net.runelite.api.coords.WorldPoint;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.api.widgets.Widget;

/**
 * One farm run as a queue of steps, ticked once per game tick on the client thread: get supplies
 * at the Grand Exchange (bank, then buy what's missing), then for each spot teleport, walk to the
 * patches, rake, clear, harvest, compost and plant, and note the produce at the tool leprechaun.
 */
final class FarmRun
{
	static final class Failed extends RuntimeException
	{
		Failed(String message)
		{
			super(message);
		}
	}

	/** A step returns true when it is finished; it throws Failed to stop the run. */
	interface Step
	{
		String describe();

		boolean tick();
	}

	static final int GE_SLOTS = 8;
	static final int GE_GROUP = 465;
	static final int SELECTED_ITEM_VARP = 1151;
	static final int WITHDRAW_NOTES_VARBIT = 3958;
	static final int BANK_WITHDRAW_1 = 2;
	static final int BANK_WITHDRAW_ALL = 7;
	static final int GE_NEAR = 25;
	static final int SPELLBOOK_VARBIT = 4070;
	static final int VARROCK_TELEPORT_LEVEL = 25;
	/** Tiles from the player a minimap click can reach. */
	static final int MINIMAP_REACH = 14;

	private final Game game;
	private final GameData data;
	private final Tracker tracker;
	private final Consumer<String> status;
	/** Lines for the run's log file (~/.rlcustom/tsps-farm-run.log). */
	private final Consumer<String> log;
	/** A list as well as a queue: a step can queue more steps straight after itself (index 1). */
	private final LinkedList<Step> steps = new LinkedList<>();
	/** Re-made once the bank is open: RuneLite only knows the bank's contents after it has been opened. */
	private final java.util.function.Supplier<Plan> planner;
	private Plan plan;
	private GameData.Teleport lastTeleport;
	private String lastMessage = "";
	/** Shown under every step's status for the rest of the run. */
	private String note = "";
	private String lastStep = "";
	private int wait;
	private boolean finished;

	FarmRun(Game game, GameData data, Tracker tracker, java.util.function.Supplier<Plan> planner, Consumer<String> status, Consumer<String> log)
	{
		this.log = log;
		this.game = game;
		this.data = data;
		this.tracker = tracker;
		this.planner = planner;
		this.plan = planner.get();
		this.status = status;
		build();
	}

	boolean finished()
	{
		return finished;
	}

	void gameMessage(String message)
	{
		lastMessage = message;
	}

	/** Runs the current step; true once the whole run is done. Throws Failed to stop. */
	boolean tick()
	{
		if (finished)
		{
			return true;
		}
		if (game.busy())
		{
			// The fake mouse is still on its way to something.
			return false;
		}
		if (game.continueDialogue())
		{
			return false;
		}
		if (wait > 0)
		{
			wait--;
			return false;
		}
		Step step = steps.peekFirst();
		if (step == null)
		{
			finished = true;
			status.accept(note.isEmpty() ? "Run complete." : "Run complete.<br>" + note);
			return true;
		}
		String describe = step.describe();
		if (!describe.equals(lastStep))
		{
			lastStep = describe;
			log.accept("step: " + describe + " (at " + game.position() + ")");
		}
		status.accept(note.isEmpty() ? describe : describe + "<br>" + note);
		if (step.tick())
		{
			steps.pollFirst();
		}
		return false;
	}

	private void pause(int ticks)
	{
		wait = Math.max(wait, ticks);
	}

	// --- Building the run ---

	private void build()
	{
		if (plan.herb == null && plan.flower == null && plan.allotment == null)
		{
			throw new Failed("Your Farming level is too low to plant anything here.");
		}
		if (stocked())
		{
			log.accept("everything the run needs is in the inventory: straight to the patches");
			steps.add(step("Planning the route", this::queueSpots));
			return;
		}
		if (game.distanceTo(data.grandExchange.target) > GE_NEAR)
		{
			GameData.Teleport toGe = data.grandExchange.teleports.get(0);
			boolean tab = game.count(Game.INVENTORY, toGe.items.get(0)) > 0;
			boolean spell = game.client().getVarbitValue(SPELLBOOK_VARBIT) == 0
				&& game.client().getBoostedSkillLevel(Skill.MAGIC) >= VARROCK_TELEPORT_LEVEL;
			if (!tab && !spell)
			{
				throw new Failed("To start away from the Grand Exchange, carry a Varrock teleport tablet or be able to cast Varrock Teleport.");
			}
			steps.add(tab ? teleport("the Grand Exchange", data.grandExchange.teleports) : castVarrockTeleport());
			steps.add(walk("the Grand Exchange"));
		}
		steps.add(openBank());
		steps.add(depositInventory());
		steps.add(shop());
		steps.add(withdrawSupplies());
		steps.add(closeInterface("bank", InterfaceID.Bankmain.ITEMS));
		steps.add(step("Planning the route", this::queueSpots));
	}

	/** Queues each spot's steps from the plan made with the bank open (it knows what you own then). */
	private boolean queueSpots()
	{
		if (!plan.unreachable.isEmpty())
		{
			note = "Skipping " + plan.unreachable.stream().map(l -> l.name).collect(java.util.stream.Collectors.joining(", "))
				+ ": no teleport there in your bank, and the Grand Exchange doesn't sell one.";
		}
		if (plan.locations.isEmpty())
		{
			throw new Failed("No farming spot can be reached. " + note);
		}
		for (GameData.Location location : plan.locations)
		{
			steps.add(teleport(location.name, location.teleports));
			steps.add(walk(location.name));
			for (GameData.Patch patch : ordered(location.patches))
			{
				steps.add(new PatchStep(location, patch));
			}
			steps.add(noteProduce(location));
		}
		return true;
	}

	/** Whether the inventory alone holds everything the plan needs, so the run can skip the Grand Exchange. */
	private boolean stocked()
	{
		for (int item : plan.keep)
		{
			if (game.count(Game.INVENTORY, item) == 0)
			{
				return false;
			}
		}
		for (java.util.Map.Entry<Integer, Integer> need : plan.needs.entrySet())
		{
			if (game.count(Game.INVENTORY, need.getKey()) < need.getValue())
			{
				return false;
			}
		}
		return !plan.locations.isEmpty();
	}

	/** Casts Varrock Teleport from the standard spellbook (218:26); it lands where the tablet does. */
	private Step castVarrockTeleport()
	{
		int[] ticks = {0};
		return step("Casting Varrock Teleport", () ->
		{
			GameData.Teleport tablet = data.grandExchange.teleports.get(0);
			if (ticks[0] > 0 && game.distanceTo(tablet.landing) <= 10)
			{
				lastTeleport = tablet;
				pause(2);
				return true;
			}
			if (ticks[0]++ % 12 == 0)
			{
				if (ticks[0] > 30)
				{
					throw new Failed("Varrock Teleport didn't work" + (lastMessage.isEmpty() ? "." : ": " + lastMessage));
				}
				game.widgetOp(InterfaceID.MagicSpellbook.VARROCK_TELEPORT, -1, 1, "Cast");
			}
			return false;
		});
	}

	/** Herbs first (the run's reason), then the flower that protects the allotments, then the allotments. */
	private static List<GameData.Patch> ordered(List<GameData.Patch> patches)
	{
		List<GameData.Patch> ordered = new ArrayList<>();
		for (String type : new String[]{"HERB", "FLOWER", "ALLOTMENT"})
		{
			for (GameData.Patch patch : patches)
			{
				if (patch.type.equals(type))
				{
					ordered.add(patch);
				}
			}
		}
		return ordered;
	}

	private static Step step(String description, java.util.function.BooleanSupplier tick)
	{
		return new Step()
		{
			@Override
			public String describe()
			{
				return description;
			}

			@Override
			public boolean tick()
			{
				return tick.getAsBoolean();
			}
		};
	}

	/** A step that gives up after `limit` ticks. */
	private static Step timed(String description, int limit, java.util.function.BooleanSupplier tick)
	{
		int[] ticks = {0};
		return step(description, () ->
		{
			if (++ticks[0] > limit)
			{
				throw new Failed("Timed out: " + description);
			}
			return tick.getAsBoolean();
		});
	}

	// --- Bank ---

	private boolean bankOpen()
	{
		return game.visible(InterfaceID.Bankmain.ITEMS);
	}

	private Step openBank()
	{
		int[] tries = {0};
		return timed("Opening the bank", 60, () ->
		{
			if (bankOpen())
			{
				return true;
			}
			if (tries[0]++ % 6 == 0)
			{
				TileObject booth = game.nearestObject(game.position(), 15, (object, composition) ->
					Game.optionIndex(composition.getActions(), "Bank") >= 0);
				if (booth == null)
				{
					throw new Failed("No bank booth nearby.");
				}
				game.objectOption(booth, "Bank");
			}
			return false;
		});
	}

	private Step depositInventory()
	{
		int[] tries = {0};
		return timed("Depositing your inventory", 20, () ->
		{
			if (game.freeSlots() == 28)
			{
				return true;
			}
			if (tries[0]++ % 3 == 0)
			{
				game.widgetOp(InterfaceID.Bankmain.DEPOSITINV, -1, 1, "Deposit inventory");
			}
			return false;
		});
	}

	private int owned(int itemId)
	{
		return game.count(Game.BANK, itemId) + game.count(Game.INVENTORY, itemId);
	}

	/** Withdraws `itemId` until the inventory holds `amount` (all of a stack). */
	private Step withdraw(int itemId, int amount)
	{
		int[] tries = {0};
		return timed("Taking " + game.name(itemId) + " from the bank", 60, () ->
		{
			if (game.count(Game.INVENTORY, itemId) >= amount)
			{
				return true;
			}
			if (game.varbit(WITHDRAW_NOTES_VARBIT) == 1)
			{
				game.widgetOp(InterfaceID.Bankmain.NOTE, -1, 1, "Item");
				pause(1);
				return false;
			}
			Widget child = game.itemChild(InterfaceID.Bankmain.ITEMS, itemId);
			if (child == null)
			{
				throw new Failed(game.name(itemId) + " is not in your bank.");
			}
			ItemComposition item = game.client().getItemDefinition(itemId);
			if (tries[0]++ % 2 == 0)
			{
				game.widgetOp(InterfaceID.Bankmain.ITEMS, child.getIndex(), item.isStackable() ? BANK_WITHDRAW_ALL : BANK_WITHDRAW_1,
					item.isStackable() ? "Withdraw-All" : "Withdraw-1");
			}
			return false;
		});
	}

	private Step withdrawSupplies()
	{
		return step("Taking supplies from the bank", () ->
		{
			List<Step> takes = new ArrayList<>();
			for (int item : plan.keep)
			{
				takes.add(withdraw(item, 1));
			}
			plan.needs.forEach((item, amount) -> takes.add(withdraw(item, amount)));
			for (int i = takes.size() - 1; i >= 0; i--)
			{
				steps.add(1, takes.get(i));
			}
			return true;
		});
	}

	// --- Grand Exchange ---

	/** Buys whatever the run needs that the bank lacks, then puts it all in the bank. */
	private Step shop()
	{
		return step("Checking supplies", () ->
		{
			plan = planner.get();
			List<int[]> buys = new ArrayList<>();
			for (int item : plan.keep)
			{
				if (owned(item) == 0)
				{
					buys.add(new int[]{item, 1});
				}
			}
			plan.needs.forEach((item, amount) ->
			{
				int missing = amount - owned(item);
				if (missing > 0)
				{
					buys.add(new int[]{item, missing});
				}
			});
			if (buys.isEmpty())
			{
				return true;
			}
			if (buys.size() > GE_SLOTS)
			{
				throw new Failed("The run needs more than 8 different items bought.");
			}
			List<Step> shopping = new ArrayList<>();
			shopping.add(withdraw(data.supply("Coins"), 1));
			shopping.add(closeInterface("bank", InterfaceID.Bankmain.ITEMS));
			shopping.add(openGe());
			for (int[] buy : buys)
			{
				shopping.add(new BuyStep(buy[0], buy[1]));
			}
			shopping.add(waitForOffers());
			shopping.add(collectToBank());
			shopping.add(closeInterface("Grand Exchange", InterfaceID.GeOffers.INDEX_0));
			shopping.add(openBank());
			shopping.add(depositInventory());
			for (int i = shopping.size() - 1; i >= 0; i--)
			{
				steps.add(1, shopping.get(i));
			}
			// steps.add(1, ...) inserts after this step, which is removed when it returns true.
			return true;
		});
	}

	private boolean geOpen()
	{
		return game.visible(InterfaceID.GeOffers.INDEX_0);
	}

	/**
	 * The server keeps offers in varps 7900+; the gateway turns them into the official client's
	 * stock-market updates, which RuneLite reads as GrandExchangeOffers.
	 */
	private GrandExchangeOfferState offerStatus(int slot)
	{
		GrandExchangeOffer[] offers = game.client().getGrandExchangeOffers();
		return offers == null || offers[slot] == null ? GrandExchangeOfferState.EMPTY : offers[slot].getState();
	}

	private Step openGe()
	{
		int[] tries = {0};
		return timed("Opening the Grand Exchange", 60, () ->
		{
			if (geOpen())
			{
				return true;
			}
			if (tries[0]++ % 6 == 0)
			{
				NPC clerk = game.npc("Grand Exchange Clerk", 15);
				if (clerk == null)
				{
					throw new Failed("No Grand Exchange clerk nearby.");
				}
				game.npcOption(clerk, "Exchange");
			}
			return false;
		});
	}

	private final Set<Integer> buying = new HashSet<>();

	/** One buy offer: an empty slot's Buy, pick the item, set the quantity, +10% on the price, Confirm. */
	private final class BuyStep implements Step
	{
		private final int itemId;
		private final int quantity;
		private int slot = -1;
		private int phase;
		private int ticks;
		private List<Integer> presses;
		private int searchTicks;

		BuyStep(int itemId, int quantity)
		{
			this.itemId = itemId;
			this.quantity = quantity;
		}

		@Override
		public String describe()
		{
			return "Buying " + quantity + " x " + game.name(itemId);
		}

		@Override
		public boolean tick()
		{
			if (++ticks > 80)
			{
				String[] phases = {"opening a slot", "typing the item's name", "choosing the item from the search",
					"setting the quantity and price", "confirming"};
				throw new Failed("Couldn't buy " + game.name(itemId) + " (stuck " + phases[Math.min(phase, phases.length - 1)] + ")"
					+ (lastMessage.isEmpty() ? "." : ": " + lastMessage));
			}
			switch (phase)
			{
				case 0:
					for (int s = 0; s < GE_SLOTS && slot < 0; s++)
					{
						if (offerStatus(s) == GrandExchangeOfferState.EMPTY && !buying.contains(s))
						{
							slot = s;
						}
					}
					if (slot < 0)
					{
						throw new Failed("No free Grand Exchange slot; collect your offers first.");
					}
					if (!clickBuy(slot))
					{
						throw new Failed("Can't find the Buy button on Grand Exchange slot " + (slot + 1) + ".");
					}
					phase = 1;
					pause(2);
					return false;
				case 1:
					// Type the name into the search, as a player does; script 752 lists the matches.
					game.type(game.name(itemId));
					phase = 2;
					searchTicks = 0;
					pause(2);
					return false;
				case 2:
					if (game.varp(SELECTED_ITEM_VARP) == itemId)
					{
						phase = 3;
						return false;
					}
					// RuneLite won't let a plugin's script send packets, so the result is clicked, never scripted.
					if (searchTicks++ % 3 == 0)
					{
						selectResult(itemId);
					}
					return false;
				case 3:
					if (presses == null)
					{
						presses = new ArrayList<>(GeButtons.quantityPresses(quantity));
						presses.add(GeButtons.PRICE_PLUS_5_PERCENT);
						presses.add(GeButtons.PRICE_PLUS_5_PERCENT);
					}
					if (!presses.isEmpty())
					{
						pressSetupButton(presses.remove(0));
						return false;
					}
					lastMessage = "";
					if (!game.clickOp(game.findByOp(GE_GROUP, "Confirm"::equalsIgnoreCase), "Confirm"::equalsIgnoreCase))
					{
						throw new Failed("Can't find the Grand Exchange Confirm button.");
					}
					phase = 4;
					pause(1);
					return false;
				default:
					if (offerStatus(slot) != GrandExchangeOfferState.EMPTY)
					{
						buying.add(slot);
						return true;
					}
					if (lastMessage.contains("enough coins"))
					{
						throw new Failed("Not enough coins to buy " + game.name(itemId) + ".");
					}
					return false;
			}
		}
	}

	/**
	 * Clicks the search result for `itemId`: a dynamic child of the chatbox's results (162:53) named
	 * after the item, with a Select op that runs script 754 (resume_objdialog) as a player's click does.
	 */
	private boolean selectResult(int itemId)
	{
		Widget results = game.client().getWidget(InterfaceID.Chatbox.MES_LAYER_SCROLLCONTENTS);
		if (results == null || results.getDynamicChildren() == null)
		{
			return false;
		}
		String name = game.name(itemId);
		for (Widget child : results.getDynamicChildren())
		{
			String shown = child == null || child.getName() == null ? "" : child.getName().replaceAll("<[^>]*>", "").trim();
			if (shown.equalsIgnoreCase(name) && game.clickOp(child, "Select"::equalsIgnoreCase))
			{
				return true;
			}
		}
		return false;
	}

	/** Clicks Buy on a slot: the dynamic child of the slot's box whose op says Buy. */
	private boolean clickBuy(int slot)
	{
		Widget box = game.client().getWidget(InterfaceID.GeOffers.INDEX_0 + slot);
		if (box == null || box.getDynamicChildren() == null)
		{
			return false;
		}
		for (Widget child : box.getDynamicChildren())
		{
			if (child != null && !child.isHidden() && game.clickOp(child, label -> label.toLowerCase().contains("buy")))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * Presses one of the offer setup's quantity or price buttons by the slot the server reads
	 * (GeButtons). Script 773 builds them as dynamic children of the setup component in that order,
	 * so the one labelled "Enter quantity" (slot 7) identifies the component.
	 */
	private void pressSetupButton(int slot)
	{
		Widget anchor = game.findByOp(GE_GROUP, "Enter quantity"::equalsIgnoreCase);
		if (anchor == null || !Game.dynamic(anchor))
		{
			throw new Failed("Can't find the Grand Exchange quantity buttons.");
		}
		Widget button = anchor.getParent().getChild(slot);
		if (button == null || button.getActions() == null)
		{
			throw new Failed("The Grand Exchange offer panel has no button " + slot + ".");
		}
		game.clickOp(button, label -> true);
	}

	private Step waitForOffers()
	{
		// The server fills an offer priced over the guide in seconds; give it five minutes.
		return timed("Waiting for the Grand Exchange offers", 500, () ->
			buying.stream().allMatch(slot -> offerStatus(slot) == GrandExchangeOfferState.BOUGHT));
	}

	private Step collectToBank()
	{
		int[] tries = {0};
		return timed("Collecting to the bank", 30, () ->
		{
			if (buying.stream().allMatch(slot -> offerStatus(slot) == GrandExchangeOfferState.EMPTY))
			{
				buying.clear();
				return true;
			}
			if (tries[0]++ % 4 == 0)
			{
				Widget collect = game.findByOp(GE_GROUP, label -> label.toLowerCase().contains("bank") && label.toLowerCase().contains("collect"));
				if (!game.clickOp(collect, label -> label.toLowerCase().contains("bank")))
				{
					// The Collect button's second op goes to the bank (the server's GrandExchange plugin).
					game.widgetOp(InterfaceID.GeOffers.COLLECTALL, 0, 2, "Bank");
				}
			}
			return false;
		});
	}

	private Step closeInterface(String name, int visibleWidget)
	{
		int[] tries = {0};
		return timed("Closing the " + name, 20, () ->
		{
			if (!game.visible(visibleWidget))
			{
				return true;
			}
			if (tries[0]++ % 3 == 0 && !game.closeInterface(visibleWidget >>> 16))
			{
				throw new Failed("Can't find the " + name + "'s close button.");
			}
			return false;
		});
	}

	// --- Travel ---

	/** Uses the first of `teleports` the inventory can; falls back to the next if one doesn't move the player. */
	private Step teleport(String where, List<GameData.Teleport> teleports)
	{
		Set<GameData.Teleport> tried = new HashSet<>();
		int[] ticks = {0};
		GameData.Teleport[] current = {null};
		return step("Teleporting to " + where, () ->
		{
			if (current[0] != null)
			{
				if (game.distanceTo(current[0].landing) <= 10)
				{
					lastTeleport = current[0];
					pause(2);
					return true;
				}
				if (++ticks[0] < 12)
				{
					return false;
				}
				current[0] = null;
			}
			for (GameData.Teleport teleport : teleports)
			{
				if (tried.contains(teleport))
				{
					continue;
				}
				for (int item : teleport.items)
				{
					if (game.count(Game.INVENTORY, item) > 0 && game.itemOption(item, teleport.option))
					{
						tried.add(teleport);
						current[0] = teleport;
						ticks[0] = 0;
						return false;
					}
				}
				tried.add(teleport);
			}
			throw new Failed("No way to teleport to " + where + (lastMessage.isEmpty() ? "." : ": " + lastMessage));
		});
	}

	/**
	 * Walks the last teleport's route. Each move: hover the next waypoint (or a nearer point on the
	 * way) and, once the client reports that tile under the mouse, "Walk here"; the server finds the
	 * path. Every move is logged.
	 */
	private Step walk(String where)
	{
		int[] index = {0};
		int[] idle = {0};
		int[] clicks = {0};
		int[] misses = {0};
		Game.Aim[] pending = {null};
		return step("Walking to " + where, () ->
		{
			List<int[]> waypoints = lastTeleport.route.waypoints;
			// Past every waypoint reached, even ones walked by on the way to a later one.
			for (int i = waypoints.size() - 1; i >= index[0]; i--)
			{
				if (game.distanceTo(waypoints.get(i)) <= 2)
				{
					index[0] = i + 1;
					clicks[0] = 0;
					break;
				}
			}
			if (index[0] >= waypoints.size())
			{
				log.accept("walk: reached " + where + " at " + game.position());
				return true;
			}
			int[] next = waypoints.get(index[0]);
			for (int ahead = index[0] + 1; ahead < waypoints.size() && game.distanceTo(waypoints.get(ahead)) <= MINIMAP_REACH; ahead++)
			{
				next = waypoints.get(ahead);
			}
			if (pending[0] != null)
			{
				Game.Aim aim = pending[0];
				pending[0] = null;
				WorldPoint hovered = game.hovered();
				if (hovered != null && hovered.distanceTo2D(aim.tile) <= 1)
				{
					game.walkHere();
					log.accept("walk: at " + game.position() + ", walking to " + hovered + " (aimed " + aim + ")");
					clicks[0]++;
					idle[0] = 0;
					pause(1);
					return false;
				}
				log.accept("walk: at " + game.position() + ", aimed " + aim + " but the client has " + hovered
					+ " under the mouse (mouse " + game.mouse() + ")");
				if (++misses[0] > 12)
				{
					throw new Failed("Can't walk to " + where + ": the game didn't put the bot's mouse on the tile it aimed at.");
				}
				return false;
			}
			if (game.moving())
			{
				idle[0] = 0;
				return false;
			}
			if (++idle[0] < 2)
			{
				return false;
			}
			if (clicks[0] > 8)
			{
				throw new Failed("Stuck walking to " + where + " (at " + game.position() + ").");
			}
			Game.Aim aim = game.aim(Game.point(next));
			if (aim == null)
			{
				log.accept("walk: at " + game.position() + ", nothing on the way to " + next[0] + "," + next[1] + " is on screen");
				if (++misses[0] > 15)
				{
					throw new Failed("Can't walk to " + where + ": the way isn't on screen. Zoom out or tilt the camera down.");
				}
				pause(1);
				return false;
			}
			if (!game.hover(aim.onScreen))
			{
				throw new Failed("The TSPS Fake Mouse plugin isn't running.");
			}
			pending[0] = aim;
			return false;
		});
	}

	// --- Patches ---

	private final class PatchStep implements Step
	{
		private final GameData.Location location;
		private final GameData.Patch patch;
		private final GameData.Crop crop;
		private boolean composted;
		private boolean planted;
		private String lastSeen = "";
		private int actions;
		private int idle;

		PatchStep(GameData.Location location, GameData.Patch patch)
		{
			this.location = location;
			this.patch = patch;
			this.crop = plan.cropFor(patch.type);
		}

		@Override
		public String describe()
		{
			return location.name + " " + patch.type.toLowerCase().replace('_', ' ') + " patch";
		}

		@Override
		public boolean tick()
		{
			if (game.animating() || game.moving())
			{
				idle = 0;
				return false;
			}
			if (++idle < 2)
			{
				return false;
			}
			if (dropWeeds())
			{
				return false;
			}
			TileObject object = game.object(patch.objectId, Game.point(patch.tile));
			if (object == null)
			{
				throw new Failed("Can't find the " + describe() + ".");
			}
			PatchState state = PatchState.decode(data, patch.type, game.varbit(patch.varbit));
			long now = System.currentTimeMillis();
			String seen = state + " (varbit " + game.varbit(patch.varbit) + ")";
			if (!seen.equals(lastSeen))
			{
				lastSeen = seen;
				log.accept(describe() + ": " + seen + ", " + game.freeSlots() + " free slots");
			}
			if (++actions > 30)
			{
				status.accept("Gave up on the " + describe() + " (" + state + ").");
				log.accept("gave up on the " + describe() + " at " + seen + (lastMessage.isEmpty() ? "" : "; last message: " + lastMessage));
				return true;
			}
			switch (state.stage)
			{
				case WEEDS:
					return act(game.objectOption(object, "Rake"), "rake");
				case DEAD:
					return act(game.objectOption(object, "Clear"), "clear");
				case HARVESTABLE:
					tracker.seenReady(location, patch, now);
					if (game.freeSlots() == 0)
					{
						steps.addFirst(noteProduce(location));
						return false;
					}
					return act(game.objectOption(object, "Harvest") || game.objectOption(object, "Pick"), "harvest");
				case EMPTY:
					tracker.cleared(location, patch);
					if (crop == null)
					{
						return true;
					}
					if (!composted && plan.compostId > 0 && game.count(Game.INVENTORY, plan.compostId) > 0 && compostHere())
					{
						composted = true;
						return act(game.useItemOn(plan.compostId, object), "compost");
					}
					if (game.count(Game.INVENTORY, crop.seedId) < crop.seedCount)
					{
						status.accept("Out of " + game.name(crop.seedId) + "; skipped the " + describe() + ".");
						return true;
					}
					planted = true;
					return act(game.useItemOn(crop.seedId, object), "plant");
				case GROWING:
					GameData.Crop growing = data.crop(state.crop);
					if (planted && growing != null)
					{
						tracker.planted(location, patch, growing, now);
					}
					else
					{
						tracker.seenGrowing(location, patch, growing, now);
					}
					return true;
				case DISEASED:
					status.accept("The " + describe() + " is diseased; cure or dig it up yourself.");
					return true;
				default:
					return true;
			}
		}

		/**
		 * Herbs always get compost. The rest do with "Compost every patch" on, from a bottomless
		 * bucket or from the buckets beyond one a spot (the herbs' share).
		 */
		private boolean compostHere()
		{
			return "HERB".equals(patch.type)
				|| plan.compostEverything && (plan.bottomless || plan.compostCount > plan.locations.size());
		}

		private boolean act(boolean clicked, String what)
		{
			if (!clicked)
			{
				throw new Failed("Couldn't " + what + " the " + describe() + ".");
			}
			log.accept(describe() + ": " + what + (lastMessage.isEmpty() ? "" : " (last message: " + lastMessage + ")"));
			lastMessage = "";
			idle = 0;
			pause(2);
			return false;
		}
	}

	/**
	 * Weeds from raking aren't produce the leprechaun notes; drop them one at a time. If drops stop
	 * taking (the count doesn't fall), give up on it for the run rather than stall.
	 */
	private boolean dropWeeds()
	{
		int weeds = data.supply("Weeds");
		int count = game.count(Game.INVENTORY, weeds);
		if (count == 0 || weedDropFailed)
		{
			return false;
		}
		if (count < weedsBefore)
		{
			weedTries = 0;
		}
		else if (++weedTries > 4)
		{
			weedDropFailed = true;
			log.accept("dropping weeds isn't working; leaving them in the inventory");
			return false;
		}
		weedsBefore = count;
		return game.itemOption(weeds, "Drop");
	}

	private int weedsBefore = Integer.MAX_VALUE;
	private int weedTries;
	private boolean weedDropFailed;

	/** Uses each kind of produce in the inventory on the tool leprechaun, which notes it. */
	private Step noteProduce(GameData.Location location)
	{
		int[] ticks = {0};
		return step("Noting produce at the " + location.name + " leprechaun", () ->
		{
			if (game.animating() || game.moving())
			{
				return false;
			}
			for (GameData.Crop crop : data.crops)
			{
				if (game.count(Game.INVENTORY, crop.produceId) == 0)
				{
					continue;
				}
				if (++ticks[0] > 40)
				{
					throw new Failed("The leprechaun won't note " + game.name(crop.produceId) + ".");
				}
				NPC leprechaun = game.npc("leprechaun", 20);
				if (leprechaun == null)
				{
					throw new Failed("No tool leprechaun at " + location.name + ".");
				}
				game.useItemOn(crop.produceId, leprechaun);
				pause(3);
				return false;
			}
			return true;
		});
	}
}
