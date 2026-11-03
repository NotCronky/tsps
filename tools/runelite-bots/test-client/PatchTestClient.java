import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;
import net.rsprox.patch.PatchResult;
import net.rsprox.patch.runelite.RuneLitePatcher;

/**
 * Patches stock RuneLite (the injected client) to log in to a worktree's gateway: its RSA modulus
 * and game port, with RSProx's public patcher, as tools/runelite-client/PatchClient.java does for
 * the Windows demo. Signatures are dropped, since the patched classes no longer match them.
 *
 * The RuneLite client jar gets the patcher's local-host support too, so it accepts a jav_config
 * served from 127.0.0.1 (the worktree's server).
 *
 * Usage: PatchTestClient <injected-client.jar> <out.jar> <gateway port> <modulus hex> <client.jar> <client out.jar> <server port>
 */
public final class PatchTestClient
{
	public static void main(String[] args) throws Exception
	{
		Path injected = Path.of(args[0]);
		Path out = Path.of(args[1]);
		int port = Integer.parseInt(args[2]);
		String modulus = args[3].trim();
		if (port == 43594 || port == 43595)
		{
			throw new IllegalArgumentException("That's the main checkout's port; test clients use a worktree's gateway.");
		}
		PatchResult result = new RuneLitePatcher().patch(injected, modulus, port, -1);
		if (!(result instanceof PatchResult.Success))
		{
			throw new IllegalStateException("RSProx's patcher failed: " + result);
		}
		javConfig = "http://127.0.0.1:" + args[6] + "/gateway/jav_config.ws";
		unsign(((PatchResult.Success) result).getOutputPath(), out);
		Path client = new RuneLitePatcher().patchLocalHostSupport(Path.of(args[4]), Integer.parseInt(args[6]), "TSPS bots test client", false);
		unsign(client, Path.of(args[5]));
		System.out.println("Patched " + out + " for gateway port " + port + ", and " + args[5]);
	}

	private static String javConfig = "";

	private static void unsign(Path patched, Path out) throws Exception
	{
		try (ZipFile zip = new ZipFile(patched.toFile()); ZipOutputStream output = new ZipOutputStream(Files.newOutputStream(out)))
		{
			for (var entries = zip.entries(); entries.hasMoreElements(); )
			{
				ZipEntry entry = entries.nextElement();
				if (entry.getName().matches("META-INF/.*\\.(SF|RSA|DSA)"))
				{
					continue;
				}
				byte[] bytes = zip.getInputStream(entry).readAllBytes();
				if (entry.getName().equals("net/runelite/client/runelite.properties"))
				{
					// No Discord: the test client must not show up in the user's Discord status.
					// And no official fallback: the config only ever comes from the worktree's server.
					String properties = new String(bytes, java.nio.charset.StandardCharsets.ISO_8859_1)
						.replaceAll("(?m)^runelite.discord.enable=.*$", "runelite.discord.enable=false")
						.replaceAll("(?m)^(runelite.jav_config(?:_backup)?)=.*$", "$1=" + javConfig);
					if (!properties.contains("runelite.discord.enable="))
					{
						properties += "\nrunelite.discord.enable=false\n";
					}
					bytes = properties.getBytes(java.nio.charset.StandardCharsets.ISO_8859_1);
				}
				output.putNextEntry(new ZipEntry(entry.getName()));
				output.write(bytes);
				output.closeEntry();
			}
		}
	}
}
