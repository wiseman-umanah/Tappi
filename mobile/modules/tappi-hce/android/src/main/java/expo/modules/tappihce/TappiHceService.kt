package expo.modules.tappihce

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * Emulates an NFC Forum Type 4 tag holding one NDEF URI record (the customer's
 * `tappi://tap/<token>`), so the merchant's phone can read it like any NFC tag.
 * Nothing is answered while Pay isn't open.
 */
class TappiHceService : HostApduService() {
  companion object {
    /** NLEN + NDEF message, or null when there's nothing to share. */
    @Volatile var ndefFile: ByteArray? = null

    private val OK = byteArrayOf(0x90.toByte(), 0x00)
    private val NOT_FOUND = byteArrayOf(0x6A.toByte(), 0x82.toByte())
    /** NFC Forum NDEF Tag Application, and the two files a Type 4 tag exposes. */
    private val NDEF_AID = hex("D2760000850101")
    private val CC_ID = hex("E103")
    private val NDEF_ID = hex("E104")

    // Capability container: mapping v2.0, max read/write sizes, NDEF file E104 (max 255 bytes,
    // read-only).
    private val CC_FILE = hex("000F20003B00340406E10400FF00FF")

    fun buildNdefFile(uri: String): ByteArray {
      val payload = byteArrayOf(0x00) + uri.toByteArray(Charsets.UTF_8) // 0x00 = no URI prefix
      // Short record, message begin + end, TNF well-known, type "U".
      val record = byteArrayOf(0xD1.toByte(), 0x01, payload.size.toByte(), 'U'.code.toByte()) + payload
      return byteArrayOf((record.size shr 8).toByte(), record.size.toByte()) + record
    }

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }

  private enum class File { NONE, CC, NDEF }
  private var selected = File.NONE

  // Parsed rather than byte-matched: readers differ in P2 (00 / 0C) and whether they send Le.
  override fun processCommandApdu(apdu: ByteArray, extras: Bundle?): ByteArray {
    val file = ndefFile ?: return NOT_FOUND
    if (apdu.size < 4 || apdu[0] != 0x00.toByte()) return NOT_FOUND
    val ins = apdu[1]
    val p1 = apdu[2].toInt() and 0xFF
    return when {
      ins == 0xA4.toByte() -> {
        val data = commandData(apdu) ?: return NOT_FOUND
        when {
          p1 == 0x04 && data.contentEquals(NDEF_AID) -> selected = File.NONE
          p1 == 0x00 && data.contentEquals(CC_ID) -> selected = File.CC
          p1 == 0x00 && data.contentEquals(NDEF_ID) -> selected = File.NDEF
          else -> return NOT_FOUND
        }
        OK
      }
      ins == 0xB0.toByte() && apdu.size >= 5 -> {
        val source = when (selected) {
          File.CC -> CC_FILE
          File.NDEF -> file
          File.NONE -> return NOT_FOUND
        }
        val offset = ((apdu[2].toInt() and 0xFF) shl 8) or (apdu[3].toInt() and 0xFF)
        val length = apdu[4].toInt() and 0xFF
        if (offset > source.size) return NOT_FOUND
        source.copyOfRange(offset, minOf(source.size, offset + length)) + OK
      }
      else -> NOT_FOUND
    }
  }

  /** The command's data field (Lc bytes after the header), or null if the APDU is malformed. */
  private fun commandData(apdu: ByteArray): ByteArray? {
    if (apdu.size < 5) return null
    val lc = apdu[4].toInt() and 0xFF
    if (apdu.size < 5 + lc) return null
    return apdu.copyOfRange(5, 5 + lc)
  }

  override fun onDeactivated(reason: Int) {
    selected = File.NONE
  }
}
