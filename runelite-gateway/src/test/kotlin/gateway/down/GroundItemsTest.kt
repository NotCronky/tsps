package gateway.down

import gateway.tsps.TspsPacket
import gateway.tsps.TspsServerPacket
import gateway.tsps.TspsWriter
import net.rsprot.protocol.game.outgoing.specific.ObjAddSpecific
import net.rsprot.protocol.game.outgoing.specific.ObjDelSpecific
import net.rsprot.protocol.message.OutgoingGameMessage
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** Ground items across scene rebuilds: never more than one copy of a stack on the client. */
class GroundItemsTest {
    private val sent = mutableListOf<OutgoingGameMessage>()
    private val items = GroundItems { sent += it }

    /** A GROUND_ITEMS snapshot of one stack (a weapon frame), in encodeGroundItem's layout. */
    private fun frameOnTheFloor() =
        TspsPacket(
            TspsServerPacket.GROUND_ITEMS,
            TspsWriter()
                .i32(1) // serial
                .u16(1)
                .i32(77).u16(23834).i32(1).u16(8200).u16(1650).u8(1)
                .i32(0).i32(0).i32(18_000).i32(-1).u8(1).u8(1)
                .body(),
        )

    @Test
    fun `a rebuild deletes each shown stack before showing it again`() {
        items.rebuild(1025, 206)
        items.handle(frameOnTheFloor())
        assertEquals(1, sent.count { it is ObjAddSpecific })

        // Lighting rooms rebuilds the same instance again and again.
        repeat(15) { items.rebuild(1025, 206) }
        val adds = sent.count { it is ObjAddSpecific }
        val deletes = sent.count { it is ObjDelSpecific }
        assertEquals(16, adds)
        assertEquals(15, deletes, "every re-add follows a delete, so at most one copy is on the client")

        // The same snapshot again changes nothing.
        sent.clear()
        items.handle(frameOnTheFloor())
        assertEquals(0, sent.size)
    }
}
