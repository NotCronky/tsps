package gateway.it

import gateway.headless.HeadlessClient
import net.rsprox.protocol.game.outgoing.model.inv.UpdateInvFull
import net.rsprox.protocol.game.outgoing.model.inv.UpdateInvPartial
import net.rsprox.protocol.game.outgoing.model.map.RebuildLoginV2
import net.rsprox.protocol.game.outgoing.model.misc.client.ServerTickEnd
import net.rsprox.protocol.game.outgoing.model.misc.player.RunClientScript
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test

/** The spawn searches: the official client answers with a bare item, not the browser's "<id> <op>". */
class ItemSearchTest {
    @Test
    fun `a search pick asks for the amount, and more than one arrives noted`() {
        val developer = LiveGateway.developerName
        assumeTrue(developer != null, "DEV_USERNAME isn't set; ::spawn needs an administrator")
        LiveGateway.login(developer!!).use { game ->
            game.expect<RebuildLoginV2>()
            game.ticks(LOGIN_TICKS)
            game.command("spawn")
            game.expectScript(SEARCH_SCRIPT)
            game.resumeObj(SHARK)
            game.expectScript(AMOUNT_PROMPT_SCRIPT)
            game.resumeCount(AMOUNT)
            // The account can carry notes from an earlier run; the stack only ever grows here.
            val stack = game.notedSharks()
            assertTrue(stack >= AMOUNT, "got $stack noted sharks")
            assertEquals(0, stack % AMOUNT, "a whole number of picks, not a single loose item")
        }
    }

    private fun HeadlessClient.Game.ticks(count: Int) {
        var seen = 0
        while (seen < count) if ((next() ?: error("stream ended")) is ServerTickEnd) seen++
    }

    private fun HeadlessClient.Game.expectScript(id: Int) {
        repeat(PACKETS) {
            val message = next() ?: error("stream ended")
            if (message is RunClientScript && message.id == id) return
        }
        error("script $id never ran")
    }

    private fun HeadlessClient.Game.notedSharks(): Int {
        repeat(PACKETS) {
            when (val message = next() ?: error("stream ended")) {
                is UpdateInvFull ->
                    if (message.inventoryId == INVENTORY) message.objs.firstOrNull { it.id == NOTED_SHARK }?.let { return it.count }
                is UpdateInvPartial ->
                    if (message.inventoryId == INVENTORY) message.objs.firstOrNull { it.id == NOTED_SHARK }?.let { return it.count }
            }
        }
        error("no noted sharks arrived")
    }

    private companion object {
        const val SEARCH_SCRIPT = 750
        const val AMOUNT_PROMPT_SCRIPT = 108
        const val SHARK = 385
        const val NOTED_SHARK = 386
        const val AMOUNT = 50
        const val INVENTORY = 93
        const val LOGIN_TICKS = 3
        const val PACKETS = 3_000
    }
}
