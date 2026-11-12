package expo.modules.tappinearby

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.ParcelUuid
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Finds Tappi phones around (≈10 m) over Bluetooth LE, so the payer sees who is in tap mode.
 *
 * A phone in tap mode (Receive, or a merchant with a charge open) advertises an 8-byte beacon id
 * as service data under Tappi's UUID. The id is random, issued by the Tappi server and replaced
 * every couple of minutes, so it says nothing about the person by itself; the payer's phone asks
 * the server who is behind the ids it hears. Nothing connects: advertising is non-connectable.
 */
@SuppressLint("MissingPermission") // Callers ask for the Bluetooth permissions first (src/lib/nearby.ts).
class TappiNearbyModule : Module() {
  companion object {
    val SERVICE: ParcelUuid = ParcelUuid.fromString("e2ed895e-5b23-4517-8997-912d84e9b6b6")
    const val ID_BYTES = 8
    /** One event per phone per second is plenty; low-latency scans report far more often. */
    const val EVENT_INTERVAL_MS = 1000L
  }

  private val context get() = requireNotNull(appContext.reactContext)
  private val adapter get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  private var advertising: AdvertiseCallback? = null
  private var scanning: ScanCallback? = null
  private val lastSent = HashMap<String, Long>()

  override fun definition() = ModuleDefinition {
    Name("TappiNearby")
    Events("onBeacon", "onScanError")

    /** "unsupported" (no Bluetooth LE), "off" (Bluetooth switched off) or "ready". */
    Function("status") {
      val bluetooth = adapter
      when {
        bluetooth == null || !context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) -> "unsupported"
        !bluetooth.isEnabled -> "off"
        else -> "ready"
      }
    }

    /** Some phones can scan but not advertise; they can still find others. */
    Function("canAdvertise") { adapter?.bluetoothLeAdvertiser != null }

    AsyncFunction("startAdvertising") { idHex: String, promise: Promise ->
      startAdvertising(idHex, promise)
    }

    Function("stopAdvertising") { stopAdvertisingNow() }

    Function("startScanning") {
      val scanner = adapter?.bluetoothLeScanner ?: throw CodedException("UNSUPPORTED", "Bluetooth is off or missing", null)
      stopScanningNow()
      val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          report(result)
        }
        override fun onBatchScanResults(results: MutableList<ScanResult>) {
          results.forEach { report(it) }
        }
        override fun onScanFailed(errorCode: Int) {
          if (scanning === this) scanning = null
          sendEvent("onScanError", mapOf("code" to errorCode))
        }
      }
      // No hardware filter: 128-bit service-data filters are unreliable on some chipsets, and the
      // scan only runs while the Pay screen is open. Results are filtered in report().
      val settings = ScanSettings.Builder()
        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
        .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
        .setReportDelay(0)
        .build()
      scanning = callback
      try {
        scanner.startScan(null, settings, callback)
      } catch (e: SecurityException) {
        scanning = null
        throw CodedException("PERMISSION", "Allow Nearby devices for Tappi in Settings", e)
      }
    }

    Function("stopScanning") { stopScanningNow() }

    OnDestroy {
      stopAdvertisingNow()
      stopScanningNow()
    }
  }

  private fun startAdvertising(idHex: String, promise: Promise) {
    val id = hexToBytes(idHex)
    val advertiser = adapter?.bluetoothLeAdvertiser
    if (id == null || id.size != ID_BYTES) {
      promise.reject(CodedException("BAD_ID", "Beacon id must be $ID_BYTES bytes of hex", null))
      return
    }
    if (advertiser == null) {
      promise.reject(CodedException("UNSUPPORTED", "This phone can't announce itself over Bluetooth", null))
      return
    }
    stopAdvertisingNow()

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .setConnectable(false)
      .setTimeout(0)
      .build()
    // 2 + 16 (UUID) + 8 (id) bytes: fits a legacy advertisement with room for the flags.
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceData(SERVICE, id)
      .build()
    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
        promise.resolve(null)
      }

      override fun onStartFailure(errorCode: Int) {
        if (advertising === this) advertising = null
        promise.reject(CodedException("ADVERTISE_FAILED", "Bluetooth announce failed (code $errorCode)", null))
      }
    }
    advertising = callback
    try {
      advertiser.startAdvertising(settings, data, callback)
    } catch (e: SecurityException) {
      advertising = null
      promise.reject(CodedException("PERMISSION", "Allow Nearby devices for Tappi in Settings", e))
    }
  }

  private fun report(result: ScanResult) {
    val id = result.scanRecord?.getServiceData(SERVICE) ?: return
    if (id.size != ID_BYTES) return
    val hex = id.joinToString("") { "%02x".format(it) }
    val now = System.currentTimeMillis()
    synchronized(lastSent) {
      if (now - (lastSent[hex] ?: 0L) < EVENT_INTERVAL_MS) return
      lastSent[hex] = now
    }
    sendEvent("onBeacon", mapOf("id" to hex, "rssi" to result.rssi))
  }

  private fun stopAdvertisingNow() {
    val callback = advertising ?: return
    advertising = null
    try {
      adapter?.bluetoothLeAdvertiser?.stopAdvertising(callback)
    } catch (_: Exception) {
      // Bluetooth already off or permission revoked: nothing is being sent anyway.
    }
  }

  private fun stopScanningNow() {
    val callback = scanning ?: return
    scanning = null
    try {
      adapter?.bluetoothLeScanner?.stopScan(callback)
    } catch (_: Exception) {
    }
    synchronized(lastSent) { lastSent.clear() }
  }

  private fun hexToBytes(s: String): ByteArray? {
    if (s.length % 2 != 0 || !s.matches(Regex("^[0-9a-fA-F]*$"))) return null
    return ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }
}
