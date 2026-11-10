package expo.modules.tappihce

import android.content.ComponentName
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Lets the merchant's phone broadcast an open charge to a customer's phone over NFC. */
class TappiHceModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  private val adapter get() = NfcAdapter.getDefaultAdapter(context)

  override fun definition() = ModuleDefinition {
    Name("TappiHce")

    /** "unsupported" (no NFC / no card emulation), "disabled" (NFC switched off) or "ready". */
    Function("status") {
      val hce = context.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION)
      val nfc = adapter
      when {
        !hce || nfc == null -> "unsupported"
        !nfc.isEnabled -> "disabled"
        else -> "ready"
      }
    }

    Function("broadcast") { uri: String ->
      TappiHceService.ndefFile = TappiHceService.buildNdefFile(uri)
      preferThisService(true)
    }

    Function("stop") {
      TappiHceService.ndefFile = null
      preferThisService(false)
    }
  }

  // While a charge is on screen, route NFC readers to Tappi rather than other wallet apps.
  private fun preferThisService(prefer: Boolean) {
    val activity = appContext.currentActivity ?: return
    val nfc = adapter ?: return
    val emulation = CardEmulation.getInstance(nfc)
    activity.runOnUiThread {
      if (prefer) emulation.setPreferredService(activity, ComponentName(context, TappiHceService::class.java))
      else emulation.unsetPreferredService(activity)
    }
  }
}
