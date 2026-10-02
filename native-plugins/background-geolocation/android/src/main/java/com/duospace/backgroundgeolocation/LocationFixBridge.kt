package com.duospace.backgroundgeolocation

/**
 * Cross-module hookup between `native/android/DuoSpaceLocationService.kt`
 * (app package, `com.duospace.app`) and this plugin.
 *
 * Gradle dependencies only ever point one way — the generated app module
 * depends on every Capacitor plugin module (that's what `cap sync` wires
 * into android/settings.gradle for every plugin listed in package.json,
 * this one included), never the other way around. So DuoSpaceLocationService
 * CAN import this class directly (it lives in a module the app module
 * already depends on); this plugin module could never import anything
 * from `com.duospace.app` back. This object is the one place that
 * boundary is crossed, and it's crossed in the only direction Gradle
 * actually allows.
 *
 * `BackgroundGeolocationPlugin.load()` sets [listener] to itself.
 * DuoSpaceLocationService calls [listener]?.onFix(...) / onError(...)
 * every time it has something to report — a running watcher tick or a
 * one-shot fix. If no plugin instance has loaded yet (JS/WebView never
 * started — e.g. a location one-shot triggered purely from
 * CallNotificationService.kt before the app was ever opened), [listener]
 * is simply null and the fix is dropped: there is no JS bridge to deliver
 * it to yet. That's an accepted, documented limitation (see
 * docs/BACKGROUND_LOCATION_NATIVE.md) — not silently swallowed, logged
 * once at INFO by the service itself.
 */
object LocationFixBridge {

    data class Fix(
        val latitude: Double,
        val longitude: Double,
        val accuracy: Float?,
        val timestampMs: Long,
        val source: String, // "watch" | "oneShot"
    )

    interface Listener {
        fun onFix(fix: Fix)
        fun onError(code: String, message: String)
    }

    @Volatile
    var listener: Listener? = null
}
