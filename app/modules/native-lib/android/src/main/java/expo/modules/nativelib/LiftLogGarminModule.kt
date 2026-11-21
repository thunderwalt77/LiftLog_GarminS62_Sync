package expo.modules.nativelib

import com.garmin.android.connectiq.ConnectIQ
import com.garmin.android.connectiq.IQApp
import com.garmin.android.connectiq.IQDevice
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

/**
 * Talks to the LiftLog Connect IQ app on a Garmin watch through Garmin Connect Mobile. Messages cross the
 * bridge as JSON strings; the Connect IQ SDK carries them to the watch as dictionaries and arrays.
 *
 * Every call runs on the main thread: the SDK creates Handlers on the calling thread, which crashes on
 * Expo's default background queue. Failures come back as status strings rather than exceptions so a
 * problem with Garmin Connect never takes the app down.
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
            when {
                ready -> promise.resolve("READY")
                context == null -> promise.resolve("UNAVAILABLE")
                else -> {
                    var settled = false
                    val settle: (String) -> Unit = { status -> if (!settled) { settled = true; promise.resolve(status) } }
                    try {
                        val ciq = connectIQ ?: ConnectIQ.getInstance(context, ConnectIQ.IQConnectType.WIRELESS).also { connectIQ = it }
                        ciq.initialize(context, false, object : ConnectIQ.ConnectIQListener {
                            override fun onSdkReady() {
                                ready = true
                                settle("READY")
                            }

                            override fun onInitializeError(status: ConnectIQ.IQSdkErrorStatus?) {
                                settle(status?.name ?: "ERROR")
                            }

                            override fun onSdkShutDown() {
                                ready = false
                            }
                        })
                    } catch (e: Throwable) {
                        settle(describe(e))
                    }
                }
            }
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("getDevices") { promise: Promise ->
            val ciq = connectIQ
            if (ciq == null || !ready) {
                promise.resolve(emptyList<Map<String, String>>())
            } else {
                try {
                    promise.resolve(
                        ciq.knownDevices.orEmpty().map { device ->
                            mapOf(
                                "id" to device.deviceIdentifier.toString(),
                                "name" to (device.friendlyName ?: "Garmin watch"),
                                "status" to (ciq.getDeviceStatus(device)?.name ?: "UNKNOWN"),
                            )
                        },
                    )
                } catch (e: Throwable) {
                    promise.resolve(emptyList<Map<String, String>>())
                }
            }
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("listen") { deviceId: String, promise: Promise ->
            val ciq = connectIQ
            if (ciq == null || !ready) {
                promise.resolve("NOT_READY")
            } else {
                try {
                    val device = ciq.knownDevices.orEmpty().firstOrNull { it.deviceIdentifier.toString() == deviceId }
                    if (device == null) {
                        promise.resolve("NO_DEVICE")
                    } else {
                        listen(ciq, device)
                        promise.resolve("OK")
                    }
                } catch (e: Throwable) {
                    promise.resolve(describe(e))
                }
            }
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("send") { deviceId: String, json: String, promise: Promise ->
            val ciq = connectIQ
            if (ciq == null || !ready) {
                promise.resolve("NOT_READY")
            } else {
                try {
                    val device = ciq.knownDevices.orEmpty().firstOrNull { it.deviceIdentifier.toString() == deviceId }
                    if (device == null) {
                        promise.resolve("NO_DEVICE")
                    } else {
                        listen(ciq, device)
                        var settled = false
                        ciq.sendMessage(device, watchApp, fromJson(JSONObject(json)), object : ConnectIQ.IQSendMessageListener {
                            override fun onMessageStatus(d: IQDevice?, app: IQApp?, status: ConnectIQ.IQMessageStatus?) {
                                if (!settled) {
                                    settled = true
                                    promise.resolve(status?.name ?: "FAILURE_UNKNOWN")
                                }
                            }
                        })
                    }
                } catch (e: Throwable) {
                    promise.resolve(describe(e))
                }
            }
        }.runOnQueue(Queues.MAIN)

        OnDestroy {
            try {
                appContext.reactContext?.let { connectIQ?.shutdown(it) }
            } catch (e: Throwable) {
            }
        }
    }

    private fun listen(ciq: ConnectIQ, device: IQDevice) {
        if (!listening.add(device.deviceIdentifier)) return
        ciq.registerForAppEvents(device, watchApp, object : ConnectIQ.IQApplicationEventListener {
            override fun onMessageReceived(d: IQDevice?, app: IQApp?, message: MutableList<Any>?, status: ConnectIQ.IQMessageStatus?) {
                if (status != ConnectIQ.IQMessageStatus.SUCCESS || message == null) return
                try {
                    for (item in message) {
                        sendEvent("onMessage", mapOf("deviceId" to device.deviceIdentifier.toString(), "json" to toJson(item).toString()))
                    }
                } catch (e: Throwable) {
                }
            }
        })
    }

    private fun describe(e: Throwable) = "ERROR ${e.javaClass.simpleName}: ${e.message ?: ""}".take(200)

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
