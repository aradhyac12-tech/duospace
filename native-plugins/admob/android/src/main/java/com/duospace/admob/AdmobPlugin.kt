package com.duospace.admob

import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.gms.ads.AdListener
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.RequestConfiguration
import com.google.android.ump.ConsentDebugSettings
import com.google.android.ump.ConsentInformation
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform

/**
 * Draws ONE anchored adaptive banner at the bottom of the screen. It makes no
 * decision about whether an ad SHOULD be shown — that is entirely
 * src/lib/monetization/adPolicy.ts (Free plan only, never in chat/calls/
 * login/linking). This class only does what it is told, and never throws to JS.
 */
@CapacitorPlugin(name = "DuospaceAdmob")
class AdmobPlugin : Plugin() {
    private var initialized = false
    private var banner: AdView? = null

    @PluginMethod
    fun initialize(call: PluginCall) {
        if (initialized) {
            call.resolve(JSObject().put("initialized", true))
            return
        }
        val canRequest = try {
            UserMessagingPlatform.getConsentInformation(context).canRequestAds()
        } catch (e: Exception) { false }
        if (!canRequest) {
            call.resolve(JSObject().put("initialized", false).put("error", "consent_required"))
            return
        }
        try {
            val config = RequestConfiguration.Builder()
                // General-audience-or-below ads only; DuoSpace is a couples app,
                // and this is not child-directed.
                .setMaxAdContentRating(RequestConfiguration.MAX_AD_CONTENT_RATING_T)
                .setTagForChildDirectedTreatment(RequestConfiguration.TAG_FOR_CHILD_DIRECTED_TREATMENT_FALSE)
                .setTestDeviceIds(call.getArray("testDeviceIds")?.toList<String>() ?: emptyList())
                .build()
            MobileAds.setRequestConfiguration(config)
            MobileAds.initialize(context) {
                initialized = true
                call.resolve(JSObject().put("initialized", true))
            }
        } catch (e: Exception) {
            call.resolve(JSObject().put("initialized", false).put("error", e.message ?: "init_failed"))
        }
    }

    // ---- Google UMP consent (GDPR/EEA/UK + US state laws) -------------------
    // JS must call this BEFORE initialize(); initialize() refuses to start the
    // SDK until Google says ads may be requested. Never throws to JS and fails
    // closed: on any error we report whatever UMP has cached (canRequestAds).
    @PluginMethod
    fun requestConsent(call: PluginCall) {
        val activity = bridge?.activity
        if (activity == null) {
            call.resolve(consentResult(null, "no_activity"))
            return
        }
        activity.runOnUiThread {
            try {
                val info = UserMessagingPlatform.getConsentInformation(context)
                val params = ConsentRequestParameters.Builder()
                    .setTagForUnderAgeOfConsent(false)
                // Debug geography only when the caller passes it (dev/test builds).
                val geo = call.getString("debugGeography")
                val testIds = call.getArray("testDeviceIds")?.toList<String>() ?: emptyList()
                if (geo != null && testIds.isNotEmpty()) {
                    val dbg = ConsentDebugSettings.Builder(context)
                        .setDebugGeography(
                            when (geo) {
                                "EEA" -> ConsentDebugSettings.DebugGeography.DEBUG_GEOGRAPHY_EEA
                                "NOT_EEA" -> ConsentDebugSettings.DebugGeography.DEBUG_GEOGRAPHY_NOT_EEA
                                else -> ConsentDebugSettings.DebugGeography.DEBUG_GEOGRAPHY_DISABLED
                            },
                        )
                    testIds.forEach { dbg.addTestDeviceHashedId(it) }
                    params.setConsentDebugSettings(dbg.build())
                }
                info.requestConsentInfoUpdate(
                    activity,
                    params.build(),
                    {
                        UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) { formError ->
                            call.resolve(consentResult(info, formError?.message))
                        }
                    },
                    { error -> call.resolve(consentResult(info, error.message ?: "consent_update_failed")) },
                )
            } catch (e: Exception) {
                call.resolve(consentResult(null, e.message ?: "consent_failed"))
            }
        }
    }

    /** Re-opens Google's privacy options form (required entry point when status is REQUIRED). */
    @PluginMethod
    fun showPrivacyOptions(call: PluginCall) {
        val activity = bridge?.activity
        if (activity == null) {
            call.resolve(JSObject().put("shown", false))
            return
        }
        activity.runOnUiThread {
            try {
                UserMessagingPlatform.showPrivacyOptionsForm(activity) { error ->
                    call.resolve(JSObject().put("shown", error == null).put("error", error?.message))
                }
            } catch (e: Exception) {
                call.resolve(JSObject().put("shown", false).put("error", e.message ?: "privacy_options_failed"))
            }
        }
    }

    private fun consentResult(info: ConsentInformation?, error: String?): JSObject {
        val ci = info ?: try { UserMessagingPlatform.getConsentInformation(context) } catch (e: Exception) { null }
        return JSObject()
            .put("canRequestAds", ci?.canRequestAds() ?: false)
            .put(
                "privacyOptionsRequired",
                ci?.privacyOptionsRequirementStatus ==
                    ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED,
            )
            .put("error", error)
    }

    @PluginMethod
    fun showBanner(call: PluginCall) {
        val activity = bridge?.activity
        if (!initialized || activity == null) {
            call.resolve(JSObject().put("shown", false).put("error", "not_initialized"))
            return
        }
        val unitId = call.getString("adUnitId")
            ?: context.getString(R.string.duospace_admob_test_banner_unit_id)
        activity.runOnUiThread {
            try {
                removeBannerInternal()
                val root = activity.findViewById<ViewGroup>(android.R.id.content)
                val widthDp = (root.width / activity.resources.displayMetrics.density).toInt()
                    .let { if (it > 0) it else 360 }
                val view = AdView(activity)
                view.setAdSize(AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(activity, widthDp))
                view.adUnitId = unitId
                var answered = false
                view.adListener = object : AdListener() {
                    override fun onAdLoaded() {
                        if (answered) return
                        answered = true
                        val density = activity.resources.displayMetrics.density
                        call.resolve(
                            JSObject().put("shown", true).put("heightDp", (view.height / density).toInt()),
                        )
                    }

                    override fun onAdFailedToLoad(error: LoadAdError) {
                        if (answered) return
                        answered = true
                        removeBannerInternal()
                        call.resolve(JSObject().put("shown", false).put("error", "load_failed_${error.code}"))
                    }
                }
                root.addView(
                    view,
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
                    ),
                )
                banner = view
                view.loadAd(AdRequest.Builder().build())
            } catch (e: Exception) {
                call.resolve(JSObject().put("shown", false).put("error", e.message ?: "show_failed"))
            }
        }
    }

    @PluginMethod
    fun hideBanner(call: PluginCall) {
        val activity = bridge?.activity
        if (activity == null) {
            call.resolve()
            return
        }
        activity.runOnUiThread {
            removeBannerInternal()
            call.resolve()
        }
    }

    private fun removeBannerInternal() {
        banner?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        banner = null
    }

    override fun handleOnPause() {
        banner?.pause()
        super.handleOnPause()
    }

    override fun handleOnResume() {
        super.handleOnResume()
        banner?.resume()
    }

    override fun handleOnDestroy() {
        removeBannerInternal()
        super.handleOnDestroy()
    }
}
