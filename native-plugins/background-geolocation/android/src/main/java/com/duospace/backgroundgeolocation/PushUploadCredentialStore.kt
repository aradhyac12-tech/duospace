package com.duospace.backgroundgeolocation

import android.content.Context

/**
 * On-device home of the per-device location-upload credential (KI-12 gap 2).
 *
 * Lives in the plugin module (which the app module may import from, not the
 * other way round — see LocationFixBridge) so BOTH sides use one definition:
 * BackgroundGeolocationPlugin writes it (JS registers it after sign-in) and
 * the app's DuoSpaceLocationService reads it when a push wakes a process that
 * has no WebView/JS to upload the fix.
 *
 * The credential is deliberately weak: it can only POST one location fix for
 * one user to the `location-push-upload` edge function. It is stored in this
 * app's private SharedPreferences (same protection level as the Supabase
 * session JS already keeps in Capacitor Preferences) and is cleared on
 * sign-out. UNVERIFIED on a device.
 */
object PushUploadCredentialStore {
    private const val PREFS = "duospace_location_push"
    private const val K_USER = "userId"
    private const val K_ID = "credentialId"
    private const val K_SECRET = "secret"
    private const val K_URL = "uploadUrl"

    data class Credential(val userId: String, val credentialId: String, val secret: String, val uploadUrl: String)

    fun save(context: Context, c: Credential) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(K_USER, c.userId)
            .putString(K_ID, c.credentialId)
            .putString(K_SECRET, c.secret)
            .putString(K_URL, c.uploadUrl)
            .apply()
    }

    fun read(context: Context): Credential? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val user = p.getString(K_USER, null) ?: return null
        val id = p.getString(K_ID, null) ?: return null
        val secret = p.getString(K_SECRET, null) ?: return null
        val url = p.getString(K_URL, null) ?: return null
        return Credential(user, id, secret, url)
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
}
