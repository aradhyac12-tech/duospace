package com.duospace.haptics

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Premium haptics for Android.
 *
 * Why not @capacitor/haptics: it plays a fixed `createWaveform` buzz for every
 * impact (long on-times, generic motor drive) — that is the "cheap and hard"
 * feel. Modern phones ship a tuned haptic HAL (Pixel, Samsung, Xiaomi, ...)
 * exposing *primitives* (CLICK, TICK, LOW_TICK, THUD, rises/falls, SPIN) with a
 * 0..1 scale. Those are short (<20 ms for the tap primitives), crisp and
 * device-calibrated.
 *
 * Fallback chain per call:
 *   1. VibrationEffect.Composition primitives   (API 30+, only if the HAL
 *      supports every primitive used; unsupported ones are substituted)
 *   2. VibrationEffect.createPredefined()       (API 29+, single-event only)
 *   3. Short waveform                            (any API; short on-times so even
 *      an eccentric-rotating-mass motor feels like a tap, not a buzz)
 *
 * Reference: source.android.com/docs/core/interaction/haptics/haptics-constants-primitives
 */
@CapacitorPlugin(name = "DuospaceHaptics")
class DuospaceHapticsPlugin : Plugin() {

    // VibrationEffect.Composition.PRIMITIVE_* (CLICK..TICK = API 30, LOW_TICK = API 31).
    // Numeric on purpose: these are stable framework constants and this keeps the
    // class loadable on API 24-29 where the Composition class doesn't exist.
    private object Prim {
        const val CLICK = 1
        const val THUD = 2
        const val SPIN = 3
        const val QUICK_RISE = 4
        const val SLOW_RISE = 5
        const val QUICK_FALL = 6
        const val TICK = 7
        const val LOW_TICK = 8
    }

    private data class Ev(val kind: String, val intensity: Float, val atMs: Int)
    private data class Resolved(val prim: Int, val scale: Float, val atMs: Int)

    private var vibrator: Vibrator? = null
    private var amplitudeControl = false
    private val supported = HashSet<Int>()
    private val durations = HashMap<Int, Int>()

    // Conservative defaults when the HAL can't report durations (API < 31).
    private val defaultDurationMs = mapOf(
        Prim.CLICK to 14, Prim.TICK to 8, Prim.LOW_TICK to 10, Prim.THUD to 40,
        Prim.QUICK_RISE to 80, Prim.SLOW_RISE to 250, Prim.QUICK_FALL to 70, Prim.SPIN to 140,
    )

    override fun load() {
        val v: Vibrator? = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vm?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
        } catch (_: Throwable) { null }
        vibrator = v
        if (v == null) return

        amplitudeControl = try { v.hasAmplitudeControl() } catch (_: Throwable) { false }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val all = intArrayOf(
                Prim.CLICK, Prim.THUD, Prim.SPIN, Prim.QUICK_RISE, Prim.SLOW_RISE,
                Prim.QUICK_FALL, Prim.TICK, Prim.LOW_TICK,
            )
            for (id in all) {
                try {
                    if (v.areAllPrimitivesSupported(id)) supported.add(id)
                } catch (_: Throwable) { /* treat as unsupported */ }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                for (id in supported) {
                    try {
                        val d = v.getPrimitiveDurations(id)
                        if (d.isNotEmpty() && d[0] > 0) durations[id] = d[0]
                    } catch (_: Throwable) { /* keep default */ }
                }
            }
        }
    }

    // ── JS API ──────────────────────────────────────────────────────────────

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        val names = JSArray()
        val nameById = mapOf(
            Prim.TICK to "tick", Prim.LOW_TICK to "lowTick", Prim.CLICK to "click", Prim.THUD to "thud",
            Prim.QUICK_RISE to "quickRise", Prim.SLOW_RISE to "slowRise", Prim.QUICK_FALL to "fall", Prim.SPIN to "spin",
        )
        for ((id, name) in nameById) if (supported.contains(id)) names.put(name)
        val has = try { vibrator?.hasVibrator() == true } catch (_: Throwable) { false }
        val out = JSObject()
        out.put("platform", "android")
        out.put("hasHaptics", has)
        out.put("rich", supported.contains(Prim.CLICK) && supported.contains(Prim.TICK))
        out.put("amplitudeControl", amplitudeControl)
        out.put("osVersion", Build.VERSION.SDK_INT)
        out.put("primitives", names)
        call.resolve(out)
    }

    @PluginMethod
    fun prepare(call: PluginCall) {
        // Nothing to warm up on Android — the vibrator service is already bound.
        call.resolve()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        try { vibrator?.cancel() } catch (_: Throwable) { /* best effort */ }
        call.resolve()
    }

    @PluginMethod
    fun play(call: PluginCall) {
        val arr = call.getArray("events")
        val events = ArrayList<Ev>()
        if (arr != null) {
            for (i in 0 until arr.length()) {
                try {
                    val o = arr.getJSONObject(i)
                    events.add(
                        Ev(
                            o.optString("kind", "click"),
                            o.optDouble("intensity", 1.0).toFloat().coerceIn(0f, 1f),
                            o.optInt("atMs", 0).coerceAtLeast(0),
                        )
                    )
                } catch (_: Throwable) { /* skip malformed event */ }
            }
        }
        run(events)
        call.resolve()
    }

    @PluginMethod
    fun perform(call: PluginCall) {
        val effect = call.getString("effect") ?: "impactLight"
        val k = (call.getDouble("intensity") ?: 1.0).toFloat().coerceIn(0f, 1f)
        run(compositionFor(effect, k))
        call.resolve()
    }

    // ── Named effects → primitive compositions ─────────────────────────────

    private fun compositionFor(effect: String, k: Float): List<Ev> = when (effect) {
        "selection" -> listOf(Ev("lowTick", 0.55f * k, 0))
        "impactSoft" -> listOf(Ev("lowTick", 0.95f * k, 0))
        "impactLight" -> listOf(Ev("click", 0.45f * k, 0))
        "impactMedium" -> listOf(Ev("click", 0.75f * k, 0))
        "impactHeavy" -> listOf(Ev("thud", 0.9f * k, 0), Ev("click", 0.5f * k, 0))
        "impactRigid" -> listOf(Ev("click", 1.0f * k, 0))
        // Rising two-beat: a soft lead-in resolving into a confident click.
        "success" -> listOf(Ev("tick", 0.5f * k, 0), Ev("click", 0.95f * k, 95))
        // Two even, slightly heavy taps — "hey, look at this".
        "warning" -> listOf(Ev("click", 0.7f * k, 0), Ev("click", 0.7f * k, 120))
        // Sharp, then two decaying hits — unmistakably a "no".
        "error" -> listOf(Ev("click", 1.0f * k, 0), Ev("click", 0.8f * k, 75), Ev("thud", 0.8f * k, 155))
        else -> listOf(Ev("click", 0.6f * k, 0))
    }

    // ── Execution ──────────────────────────────────────────────────────────

    private fun run(events: List<Ev>) {
        val v = vibrator ?: return
        if (events.isEmpty()) return
        try {
            if (playComposition(v, events)) return
            if (playPredefined(v, events)) return
            playWaveform(v, events)
        } catch (_: Throwable) {
            // Haptics must never take the app down.
        }
    }

    /** Pick the closest supported primitive, or null when nothing works. */
    private fun resolve(e: Ev): Resolved? {
        fun has(id: Int) = supported.contains(id)
        val k = e.intensity
        return when (e.kind) {
            "tick" -> when {
                has(Prim.TICK) -> Resolved(Prim.TICK, k, e.atMs)
                has(Prim.CLICK) -> Resolved(Prim.CLICK, k * 0.55f, e.atMs)
                else -> null
            }
            "lowTick" -> when {
                has(Prim.LOW_TICK) -> Resolved(Prim.LOW_TICK, k, e.atMs)
                has(Prim.TICK) -> Resolved(Prim.TICK, k * 0.85f, e.atMs)
                has(Prim.CLICK) -> Resolved(Prim.CLICK, k * 0.5f, e.atMs)
                else -> null
            }
            "thud" -> when {
                has(Prim.THUD) -> Resolved(Prim.THUD, k, e.atMs)
                has(Prim.CLICK) -> Resolved(Prim.CLICK, k, e.atMs)
                else -> null
            }
            "quickRise" -> when {
                has(Prim.QUICK_RISE) -> Resolved(Prim.QUICK_RISE, k, e.atMs)
                has(Prim.CLICK) -> Resolved(Prim.CLICK, k * 0.6f, e.atMs)
                else -> null
            }
            "slowRise" -> when {
                has(Prim.SLOW_RISE) -> Resolved(Prim.SLOW_RISE, k, e.atMs)
                has(Prim.QUICK_RISE) -> Resolved(Prim.QUICK_RISE, k, e.atMs)
                has(Prim.CLICK) -> Resolved(Prim.CLICK, k * 0.6f, e.atMs)
                else -> null
            }
            "fall" -> when {
                has(Prim.QUICK_FALL) -> Resolved(Prim.QUICK_FALL, k, e.atMs)
                has(Prim.LOW_TICK) -> Resolved(Prim.LOW_TICK, k, e.atMs)
                has(Prim.CLICK) -> Resolved(Prim.CLICK, k * 0.5f, e.atMs)
                else -> null
            }
            "spin" -> when {
                has(Prim.SPIN) -> Resolved(Prim.SPIN, k, e.atMs)
                has(Prim.CLICK) -> Resolved(Prim.CLICK, k * 0.7f, e.atMs)
                else -> null
            }
            else -> if (has(Prim.CLICK)) Resolved(Prim.CLICK, k, e.atMs) else null
        }
    }

    private fun durationOf(prim: Int): Int = durations[prim] ?: defaultDurationMs[prim] ?: 15

    private fun playComposition(v: Vibrator, events: List<Ev>): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || supported.isEmpty()) return false
        val resolved = ArrayList<Resolved>(events.size)
        for (e in events.sortedBy { it.atMs }) resolved.add(resolve(e) ?: return false)

        val comp = VibrationEffect.startComposition()
        var cursorEnd = 0 // ms — when the previous primitive finishes
        for (r in resolved) {
            val delay = (r.atMs - cursorEnd).coerceAtLeast(0)
            comp.addPrimitive(r.prim, r.scale.coerceIn(0f, 1f), delay)
            cursorEnd = maxOf(r.atMs, cursorEnd) + durationOf(r.prim)
        }
        v.vibrate(comp.compose())
        return true
    }

    private fun playPredefined(v: Vibrator, events: List<Ev>): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || events.size != 1) return false
        val id = when (events[0].kind) {
            "tick", "lowTick" -> VibrationEffect.EFFECT_TICK
            "thud" -> VibrationEffect.EFFECT_HEAVY_CLICK
            else -> VibrationEffect.EFFECT_CLICK
        }
        v.vibrate(VibrationEffect.createPredefined(id))
        return true
    }

    /** Last resort. Short on-times keep even a basic motor feeling like a tap. */
    private fun playWaveform(v: Vibrator, events: List<Ev>) {
        fun onMs(kind: String): Long = when (kind) {
            "tick" -> 6L
            "lowTick" -> 8L
            "click" -> 10L
            "thud" -> 24L
            "quickRise" -> 40L
            "slowRise" -> 90L
            "fall" -> 40L
            "spin" -> 70L
            else -> 10L
        }
        val timings = ArrayList<Long>()
        val amps = ArrayList<Int>()
        var cursor = 0L
        for (e in events.sortedBy { it.atMs }) {
            val gap = (e.atMs - cursor).coerceAtLeast(0L)
            if (gap > 0 || timings.isEmpty()) {
                timings.add(gap)
                amps.add(0)
            }
            val on = onMs(e.kind)
            timings.add(on)
            amps.add((e.intensity * 255f).toInt().coerceIn(40, 255))
            cursor = maxOf(e.atMs.toLong(), cursor) + on
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.vibrate(VibrationEffect.createWaveform(timings.toLongArray(), amps.toIntArray(), -1))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(timings.toLongArray(), -1)
        }
    }
}
