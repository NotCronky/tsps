package com.tsps.fakemouse;

import java.awt.Canvas;
import java.awt.Dimension;
import java.awt.event.MouseEvent;
import java.util.Random;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import javax.swing.SwingUtilities;
import net.runelite.api.Client;
import net.runelite.api.Point;
import net.runelite.client.callback.ClientThread;

/**
 * A mouse for bot plugins. While a plugin holds it, the game ignores the real mouse (the
 * FakeMousePlugin's listener swallows real events) and sees only this one. Points are in game
 * coordinates, as Perspective and widgets give them; they are scaled to the window when the
 * client is stretched (the client halves a 2x-stretched window's mouse back to game pixels).
 *
 * One plugin holds it at a time: take() it, release() it when done. Escape gives it back to the
 * player, and the holder hears why through its onLost callback.
 */
public final class FakeMouse
{
	private static volatile FakeMouse instance;

	private static final int FRAME_MS = 4;
	/** Target width (pixels) assumed for a bare point. */
	private static final double DEFAULT_TARGET = 16;

	private final Client client;
	private final ClientThread clientThread;
	private final ScheduledExecutorService frames;
	private final Random random = new Random();
	private String owner;
	private Consumer<String> onLost;
	private volatile Point position;
	private ScheduledFuture<?> glide;
	private java.util.function.Supplier<MousePath.Speed> speed = () -> MousePath.Speed.HUMAN;

	FakeMouse(Client client, ClientThread clientThread)
	{
		this.client = client;
		this.clientThread = clientThread;
		this.frames = clientThread == null ? null : Executors.newSingleThreadScheduledExecutor(r ->
		{
			Thread thread = new Thread(r, "tsps-fake-mouse");
			thread.setDaemon(true);
			return thread;
		});
	}

	void setSpeed(java.util.function.Supplier<MousePath.Speed> speed)
	{
		this.speed = speed;
	}

	void shutDown()
	{
		if (frames != null)
		{
			frames.shutdownNow();
		}
	}

	/** Whether the mouse is still gliding to where it was sent. */
	public synchronized boolean busy()
	{
		return (glide != null && !glide.isDone()) || !queued.isEmpty();
	}

	/** Glides onto a point (a small target), then runs `then` on the client thread (null for nothing). */
	public void glideTo(Point game, Runnable then)
	{
		glide(game.getX(), game.getY(), DEFAULT_TARGET, then);
	}

	/**
	 * Glides onto somewhere inside `target` (clustered towards its middle, as people aim), then runs
	 * `then` on the client thread. The target's size feeds the movement time, as with a real hand.
	 */
	public void glideTo(java.awt.Rectangle target, Runnable then)
	{
		int[] aim = MousePath.aimInside(target.getCenterX(), target.getCenterY(), target.getWidth(), target.getHeight(), random);
		glide(aim[0], aim[1], Math.max(4, Math.min(target.getWidth(), target.getHeight())), then);
	}

	/** Moves waiting for the one in progress: clicks queue, so two in a tick (a combo eat) both land. */
	private final java.util.ArrayDeque<Runnable> queued = new java.util.ArrayDeque<>();

	/**
	 * Plays a MousePath (see there: Fitts's law timing, minimum-jerk speed, curve, tremor, overshoot).
	 * A move asked for while one is in progress waits its turn.
	 */
	private synchronized void glide(int toX, int toY, double width, Runnable then)
	{
		if (glide != null && !glide.isDone())
		{
			queued.add(() -> start(toX, toY, width, then));
			return;
		}
		start(toX, toY, width, then);
	}

	private synchronized void next()
	{
		Runnable move = queued.poll();
		if (move != null)
		{
			move.run();
		}
	}

	private synchronized void start(int toX, int toY, double width, Runnable then)
	{
		Point from = position;
		if (frames == null || from == null)
		{
			moveTo(new Point(toX, toY));
			finish(then);
			next();
			return;
		}
		java.util.List<MousePath.Frame> path = MousePath.plan(from.getX(), from.getY(), toX, toY, width, speed.get(), random);
		long start = System.nanoTime();
		int[] next = {0};
		java.util.concurrent.atomic.AtomicReference<ScheduledFuture<?>> self = new java.util.concurrent.atomic.AtomicReference<>();
		glide = frames.scheduleAtFixedRate(() ->
		{
			long elapsed = (System.nanoTime() - start) / 1_000_000;
			MousePath.Frame frame = null;
			while (next[0] < path.size() && path.get(next[0]).at <= elapsed)
			{
				frame = path.get(next[0]++);
			}
			if (frame != null)
			{
				moveTo(new Point(frame.x, frame.y));
			}
			if (next[0] >= path.size())
			{
				self.get().cancel(false);
				finish(then);
				next();
			}
		}, 0, FRAME_MS, TimeUnit.MILLISECONDS);
		self.set(glide);
	}

	private void finish(Runnable then)
	{
		if (then != null)
		{
			if (clientThread != null)
			{
				clientThread.invoke(then);
			}
			else
			{
				then.run();
			}
		}
	}

	/** The fake mouse, or null when the TSPS Fake Mouse plugin isn't running. */
	public static FakeMouse get()
	{
		return instance;
	}

	static void install(FakeMouse mouse)
	{
		instance = mouse;
	}

	/** Takes the mouse for `who`; false if another plugin holds it. `onLost` hears why if it's taken back. */
	public synchronized boolean take(String who, Consumer<String> onLost)
	{
		if (owner != null && !owner.equals(who))
		{
			return false;
		}
		owner = who;
		this.onLost = onLost;
		return true;
	}

	public synchronized void release(String who)
	{
		if (who.equals(owner))
		{
			owner = null;
			onLost = null;
		}
	}

	/** Gives the mouse back to the player (Escape, or the plugin stopping) and tells the holder. */
	synchronized void revoke(String why)
	{
		queued.clear();
		Consumer<String> lost = onLost;
		owner = null;
		onLost = null;
		if (lost != null)
		{
			lost.accept(why);
		}
	}

	public synchronized boolean held()
	{
		return owner != null;
	}

	public synchronized String owner()
	{
		return owner;
	}

	/** Where the fake mouse is, in game coordinates, or null before it first moves. */
	public Point position()
	{
		return position;
	}

	/** Puts the mouse on a point in game coordinates at once (a hover: the game sees the mouse there). */
	public void moveTo(Point game)
	{
		position = game;
		send(MouseEvent.MOUSE_MOVED, game, 0, 0, MouseEvent.NOBUTTON);
	}

	/** Moves to `game` and left-clicks there. */
	public void click(Point game)
	{
		moveTo(game);
		send(MouseEvent.MOUSE_PRESSED, game, MouseEvent.BUTTON1_DOWN_MASK, 1, MouseEvent.BUTTON1);
		send(MouseEvent.MOUSE_RELEASED, game, 0, 1, MouseEvent.BUTTON1);
		send(MouseEvent.MOUSE_CLICKED, game, 0, 1, MouseEvent.BUTTON1);
	}

	/** A game-coordinate point as a window (component) point: the client's stretch undone. */
	Point toWindow(Point game)
	{
		if (!client.isStretchedEnabled())
		{
			return game;
		}
		Dimension real = client.getRealDimensions();
		Dimension stretched = client.getStretchedDimensions();
		if (real == null || stretched == null || real.width == 0 || real.height == 0)
		{
			return game;
		}
		return new Point((int) Math.round(game.getX() * stretched.getWidth() / real.getWidth()),
			(int) Math.round(game.getY() * stretched.getHeight() / real.getHeight()));
	}

	private void send(int id, Point game, int modifiers, int clicks, int button)
	{
		Canvas canvas = client.getCanvas();
		Point window = toWindow(game);
		SwingUtilities.invokeLater(() ->
			canvas.dispatchEvent(new FakeMouseEvent(canvas, id, modifiers, window.getX(), window.getY(), clicks, button)));
	}
}
