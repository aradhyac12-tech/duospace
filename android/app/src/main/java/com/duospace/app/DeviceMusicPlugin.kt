package com.duospace.app

import android.content.ContentUris
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.media.ThumbnailUtils
import android.util.Base64
import android.util.Size
import java.io.ByteArrayOutputStream
import android.os.Build
import android.provider.MediaStore
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * "DeviceMusic": lists the audio files already on the phone (MediaStore) so the
 * Music page can show them without the user picking each file. Nothing is copied:
 * each track is returned as a content:// URI that the native ExoPlayer engine
 * plays directly (DefaultDataSource handles content:// and file://).
 *
 * Permission: READ_MEDIA_AUDIO on Android 13+, READ_EXTERNAL_STORAGE below
 * (both already declared in the manifest). Registered from MainActivity.onCreate.
 */
@CapacitorPlugin(
    name = "DeviceMusic",
    permissions = [
        Permission(alias = "audio", strings = ["android.permission.READ_MEDIA_AUDIO"]),
        Permission(alias = "legacyAudio", strings = ["android.permission.READ_EXTERNAL_STORAGE"]),
    ],
)
class DeviceMusicPlugin : Plugin() {

    private fun alias(): String = if (Build.VERSION.SDK_INT >= 33) "audio" else "legacyAudio"
    private fun granted(): Boolean = getPermissionState(alias()) == PermissionState.GRANTED

    @PluginMethod
    fun checkPermission(call: PluginCall) {
        call.resolve(JSObject().put("granted", granted()))
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (granted()) { call.resolve(JSObject().put("granted", true)); return }
        requestPermissionForAlias(alias(), call, "permissionResult")
    }

    @PermissionCallback
    private fun permissionResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", granted()))
    }

    /** Returns { tracks: [{ id, uri, title, artist, album, duration(sec) }] }, newest first. */
    @PluginMethod
    fun scan(call: PluginCall) {
        if (!granted()) { call.reject("permission_denied"); return }
        val limit = (call.getInt("limit") ?: 5000).coerceIn(1, 20000)
        try {
            val collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
            val projection = arrayOf(
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.DURATION,
            )
            // Real music only: skips ringtones/notifications/alarms and clips under 30 s.
            val selection = "${MediaStore.Audio.Media.IS_MUSIC} != 0 AND ${MediaStore.Audio.Media.DURATION} >= 30000"
            val tracks = JSArray()
            val cursor = context.contentResolver.query(
                collection, projection, selection, null, "${MediaStore.Audio.Media.DATE_ADDED} DESC",
            )
            cursor?.use { c ->
                val idCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val titleCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
                val artistCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
                val albumCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM)
                val durCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
                while (c.moveToNext() && tracks.length() < limit) {
                    val id = c.getLong(idCol)
                    val artist = c.getString(artistCol)
                    tracks.put(
                        JSObject()
                            .put("id", id.toString())
                            .put("uri", ContentUris.withAppendedId(collection, id).toString())
                            .put("title", c.getString(titleCol) ?: "Untitled")
                            .put("artist", if (artist.isNullOrBlank() || artist == "<unknown>") "This phone" else artist)
                            .put("album", c.getString(albumCol) ?: "")
                            .put("duration", (c.getLong(durCol) / 1000L).toInt()),
                    )
                }
            }
            call.resolve(JSObject().put("tracks", tracks))
        } catch (e: Throwable) {
            call.reject(e.message ?: "scan_failed")
        }
    }

    /**
     * Album art for ONE song as a square JPEG data URL ({ art } — omitted when the song has none).
     * Tries the system thumbnail first (Android 10+), then the picture embedded in the file's tags.
     * Called lazily and one at a time from JS, so a 5000-song scan never decodes 5000 bitmaps.
     */
    @PluginMethod
    fun getArt(call: PluginCall) {
        if (!granted()) { call.reject("permission_denied"); return }
        val id = call.getString("id")?.toLongOrNull()
        if (id == null) { call.reject("bad_id"); return }
        val size = (call.getInt("size") ?: 200).coerceIn(64, 512)
        try {
            val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)
            var bmp: Bitmap? = null
            if (Build.VERSION.SDK_INT >= 29) {
                try { bmp = context.contentResolver.loadThumbnail(uri, Size(size, size), null) } catch (ignored: Throwable) { /* no thumbnail */ }
            }
            if (bmp == null) {
                val mmr = MediaMetadataRetriever()
                try {
                    mmr.setDataSource(context, uri)
                    val bytes = mmr.embeddedPicture
                    if (bytes != null) bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                } catch (ignored: Throwable) { /* unreadable or no tags */ } finally {
                    try { mmr.release() } catch (ignored: Throwable) { }
                }
            }
            if (bmp == null) { call.resolve(JSObject()); return }
            val square = ThumbnailUtils.extractThumbnail(bmp, size, size) // centre-crop
            val out = ByteArrayOutputStream()
            square.compress(Bitmap.CompressFormat.JPEG, 70, out)
            if (square !== bmp) square.recycle()
            bmp.recycle()
            call.resolve(JSObject().put("art", "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)))
        } catch (e: Throwable) {
            call.resolve(JSObject()) // art is cosmetic: never fail the caller
        }
    }
}
