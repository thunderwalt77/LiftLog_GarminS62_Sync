package expo.modules.nativelib

import com.garmin.android.connectiq.ConnectIQ
import com.garmin.android.connectiq.IQApp
import com.garmin.android.connectiq.IQDevice
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

/**
 * Talks to the LiftLog Connect IQ app on a Garmin watch through Garmin Connect Mobile. Messages cross the
 * bridge as JSON strings; the Connect IQ SDK carries them to the watch as dictionaries and arrays.
 */
class LiftLogGarminModule : Module() {
    private var connectIQ: ConnectIQ? = null
    private var ready = false
    private val watchApp = IQApp(WATCH_APP_ID)
    private val listening = mutableSetOf<Long>()

    override fun definition() = ModuleDefinition {
        Name("LiftLogGarmin")
        Events("onMessage")

        AsyncFunction("initialize") { promise: Promise ->
            val context = appContext.reactContext
            if (ready) {
                promise.resolve("READY")
            } else if (context == null) {
                promise.resolve("UNAVAILABLE")
            } else {
                val ciq = ConnectIQ.getInstance(context, ConnectIQ.IQConnectType.WIRELESS)
                connectIQ = ciq
                var settled = false
                try {
                    ciq.initialize(context, true, object : ConnectIQ.ConnectIQListener {
                        override fun onSdkReady() {
                            ready = true
                            if (!settled) { settled = true; promise.resolve("READY") }
                        }

                        override fun onInitializeError(status: ConnectIQ.IQSdkErrorStatus?) {
                            if (!settled) { settled = true; promise.resolve(status?.name ?: "ERROR") }
                        }

                        override fun onSdkShutDown() {
                            ready = false
                        }
                    })
                } catch (e: Exception) {
                    if (!settled) { settled = true; promise.resolve("ERROR") }
                }
            }
        }

        AsyncFunction("getDevices") {
            val ciq = connectIQ
            if (ciq == null || !ready) {
                emptyList<Map<String, String>>()
            } else {
                try {
                    ciq.knownDevices.orEmpty().map { device ->
                        mapOf(
                            "id" to device.deviceIdentifier.toString(),
                            "name" to (device.friendlyName ?: "Garmin watch"),
                            "status" to (ciq.getDeviceStatus(device)?.name ?: "UNKNOWN"),
                        )
                    }
                } catch (e: Exception) {
                    emptyList<Map<String, String>>()
                }
            }
        }

        AsyncFunction("send") { deviceId: String, json: String, promise: Promise ->
            val ciq = connectIQ
            val device = if (ciq != null && ready) findDevice(ciq, deviceId) else null
            if (ciq == null || device == null) {
                promise.resolve(if (ciq == null || !ready) "NOT_READY" else "NO_DEVICE")
            } else {
                try {
                    listen(ciq, device)
                    ciq.sendMessage(device, watchApp, fromJson(JSONObject(json)), object : ConnectIQ.IQSendMessageListener {
                        override fun onMessageStatus(d: IQDevice?, app: IQApp?, status: ConnectIQ.IQMessageStatus?) {
                            promise.resolve(status?.name ?: "FAILURE_UNKNOWN")
                        }
                    })
                } catch (e: Exception) {
                    promise.resolve("FAILURE_UNKNOWN")
                }
            }
        }

        OnDestroy {
            try {
                appContext.reactContext?.let { connectIQ?.shutdown(it) }
            } catch (e: Exception) {
            }
        }
    }

    private fun findDevice(ciq: ConnectIQ, deviceId: String): IQDevice? =
        try {
            ciq.knownDevices.orEmpty().firstOrNull { it.deviceIdentifier.toString() == deviceId }
        } catch (e: Exception) {
            null
        }

    private fun listen(ciq: ConnectIQ, device: IQDevice) {
        if (!listening.add(device.deviceIdentifier)) return
        ciq.registerForAppEvents(device, watchApp, object : ConnectIQ.IQApplicationEventListener {
            override fun onMessageReceived(d: IQDevice?, app: IQApp?, message: MutableList<Any>?, status: ConnectIQ.IQMessageStatus?) {
                if (status != ConnectIQ.IQMessageStatus.SUCCESS || message == null) return
                for (item in message) {
                    sendEvent("onMessage", mapOf("deviceId" to device.deviceIdentifier.toString(), "json" to toJson(item).toString()))
                }
            }
        })
    }

    private fun fromJson(value: Any?): Any? = when (value) {
        is JSONObject -> HashMap<String, Any?>().also { map -> value.keys().forEach { map[it] = fromJson(value.get(it)) } }
        is JSONArray -> ArrayList<Any?>().also { list -> for (i in 0 until value.length()) list.add(fromJson(value.get(i))) }
        JSONObject.NULL -> null
        else -> value
    }

    private fun toJson(value: Any?): Any = when (value) {
        is Map<*, *> -> JSONObject().also { obj -> value.forEach { (k, v) -> obj.put(k.toString(), toJson(v)) } }
        is List<*> -> JSONArray().also { arr -> value.forEach { arr.put(toJson(it)) } }
        null -> JSONObject.NULL
        else -> value
    }

    companion object {
        /** `watch/manifest.xml` application id in Watch_GymAPP. */
        const val WATCH_APP_ID = "d52fcacc-d457-4eb2-98e9-5ad0285701fd"
    }
}
