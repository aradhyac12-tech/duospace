package com.duospace.appupdate

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * JS-facing bridge for DuospaceAppUpdate (contract: src/definitions.ts). The JS
 * layer decides WHETHER an update happens (from an admin-published release);
 * this class only downloads a file and refuses to install anything that is not
 * exactly the expected, newer, same-signer build of this app.
 */
@CapacitorPlugin(name = "DuospaceAppUpdate")
class AppUpdatePlugin : Plugin() {

    private val fileNameRegex = Regex("^[A-Za-z0-9._-]{1,120}\\.apk$")
    private val apkMime = "application/vnd.android.package-archive"

    private fun dm(): DownloadManager =
        context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    private fun downloadsDir(): File? =
        context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)

    /** Validates the name and pins the file inside the private downloads dir. */
    private fun resolveFile(name: String?): File? {
        if (name == null || !fileNameRegex.matches(name)) return null
        val dir = downloadsDir() ?: return null
        val file = File(dir, name)
        return if (file.canonicalPath.startsWith(dir.canonicalPath + File.separator)) file else null
    }

    private fun deleteStaleUpdates() {
        downloadsDir()?.listFiles()?.forEach {
            if (it.isFile && it.name.startsWith("duospace-") && it.name.endsWith(".apk")) it.delete()
        }
    }

    @PluginMethod
    fun startDownload(call: PluginCall) {
        val url = call.getString("url")
        val file = resolveFile(call.getString("fileName"))
        val allowCellular = call.getBoolean("allowCellular", false) ?: false

        if (url.isNullOrBlank() || !url.startsWith("https://")) {
            call.reject("url must be https", "INVALID_ARGUMENT"); return
        }
        if (file == null) {
            call.reject("invalid fileName", "INVALID_ARGUMENT"); return
        }

        try {
            // A stale file with the same name would make DownloadManager pick
            // "name-1.apk" and our path would point at the wrong one.
            deleteStaleUpdates()

            val networks = if (allowCellular)
                DownloadManager.Request.NETWORK_WIFI or DownloadManager.Request.NETWORK_MOBILE
            else
                DownloadManager.Request.NETWORK_WIFI

            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(call.getString("title") ?: "DuoSpace update")
                .setDescription(call.getString("description") ?: "")
                .setMimeType(apkMime)
                // Progress notification only while running. NOT *_NOTIFY_COMPLETED:
                // tapping that would open the APK installer and skip our checks.
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setAllowedNetworkTypes(networks)
                .setAllowedOverMetered(allowCellular)
                .setAllowedOverRoaming(false)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, file.name)

            val ret = JSObject()
            ret.put("downloadId", dm().enqueue(request).toString())
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Could not start download: ${e.message}", "DOWNLOAD_START_FAILED")
        }
    }

    @PluginMethod
    fun getDownloadStatus(call: PluginCall) {
        val id = call.getString("downloadId")?.toLongOrNull()
        if (id == null) {
            call.reject("downloadId required", "INVALID_ARGUMENT"); return
        }
        val ret = JSObject()
        try {
            dm().query(DownloadManager.Query().setFilterById(id)).use { c ->
                if (c == null || !c.moveToFirst()) {
                    ret.put("status", "missing")
                    ret.put("bytesDownloaded", 0)
                    ret.put("totalBytes", 0)
                } else {
                    val st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    val got = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    val reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                    val status = when (st) {
                        DownloadManager.STATUS_PENDING -> "pending"
                        DownloadManager.STATUS_RUNNING -> "running"
                        DownloadManager.STATUS_PAUSED -> "paused"
                        DownloadManager.STATUS_SUCCESSFUL -> "success"
                        DownloadManager.STATUS_FAILED -> "failed"
                        else -> "pending"
                    }
                    ret.put("status", status)
                    ret.put("bytesDownloaded", got)
                    ret.put("totalBytes", if (total > 0) total else 0)
                    ret.put(
                        "waitingForWifi",
                        st == DownloadManager.STATUS_PAUSED &&
                            (reason == DownloadManager.PAUSED_QUEUED_FOR_WIFI ||
                                reason == DownloadManager.PAUSED_WAITING_FOR_NETWORK),
                    )
                    if (st == DownloadManager.STATUS_FAILED || st == DownloadManager.STATUS_PAUSED) {
                        ret.put("reasonCode", reason)
                    }
                }
            }
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Could not read download status: ${e.message}", "STATUS_FAILED")
        }
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val id = call.getString("downloadId")?.toLongOrNull()
        if (id == null) {
            call.reject("downloadId required", "INVALID_ARGUMENT"); return
        }
        try {
            dm().remove(id) // also deletes the partial file
            call.resolve()
        } catch (e: Exception) {
            call.reject("Could not cancel: ${e.message}", "CANCEL_FAILED")
        }
    }

    @PluginMethod
    fun installApk(call: PluginCall) {
        val file = resolveFile(call.getString("fileName"))
        val expectedSha = call.getString("sha256")?.lowercase()
        val expectedVersionCode = call.getInt("expectedVersionCode")

        if (expectedSha == null || expectedVersionCode == null) {
            call.reject("sha256 and expectedVersionCode are required", "INVALID_ARGUMENT"); return
        }
        if (file == null || !file.isFile) {
            call.reject("Downloaded file not found", "FILE_MISSING"); return
        }

        try {
            if (sha256Hex(file) != expectedSha) {
                file.delete()
                call.reject("Downloaded file is corrupted. Please download it again.", "HASH_MISMATCH"); return
            }

            val pm = context.packageManager
            @Suppress("DEPRECATION")
            val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
            else PackageManager.GET_SIGNATURES

            @Suppress("DEPRECATION")
            val archive: PackageInfo? = pm.getPackageArchiveInfo(file.absolutePath, flags)
            if (archive == null) {
                file.delete()
                call.reject("This file is not a valid app package.", "INVALID_APK"); return
            }
            if (archive.packageName != context.packageName) {
                file.delete()
                call.reject("This package is not DuoSpace.", "WRONG_PACKAGE"); return
            }

            @Suppress("DEPRECATION")
            val installed = pm.getPackageInfo(context.packageName, flags)
            val newCode = versionCodeOf(archive)
            val curCode = versionCodeOf(installed)
            if (newCode != expectedVersionCode.toLong()) {
                file.delete()
                call.reject("Package version $newCode does not match the published release $expectedVersionCode.", "VERSION_MISMATCH"); return
            }
            if (newCode <= curCode) {
                file.delete()
                call.reject("This version is not newer than the installed one.", "NOT_NEWER"); return
            }
            if (!sameSigner(installed, archive)) {
                file.delete()
                call.reject("This build is signed with a different key and cannot update the installed app.", "SIGNATURE_MISMATCH"); return
            }

            if (Build.VERSION.SDK_INT >= 26 && !pm.canRequestPackageInstalls()) {
                val ret = JSObject()
                ret.put("status", "needs_permission")
                call.resolve(ret); return
            }

            val uri = FileProvider.getUriForFile(context, "${context.packageName}.appupdate.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, apkMime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)

            val ret = JSObject()
            ret.put("status", "started")
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Could not start the installer: ${e.message}", "INSTALL_FAILED")
        }
    }

    @PluginMethod
    fun openInstallSettings(call: PluginCall) {
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Could not open settings: ${e.message}", "SETTINGS_FAILED")
        }
    }

    @PluginMethod
    fun getInstallSource(call: PluginCall) {
        val installer: String? = try {
            val pm = context.packageManager
            if (Build.VERSION.SDK_INT >= 30) {
                pm.getInstallSourceInfo(context.packageName).installingPackageName
            } else {
                @Suppress("DEPRECATION")
                pm.getInstallerPackageName(context.packageName)
            }
        } catch (e: Exception) {
            null
        }
        val ret = JSObject()
        ret.put("installer", installer ?: JSONObject.NULL)
        call.resolve(ret)
    }

    @PluginMethod
    fun cleanup(call: PluginCall) {
        try {
            deleteStaleUpdates()
            call.resolve()
        } catch (e: Exception) {
            call.reject("Cleanup failed: ${e.message}", "CLEANUP_FAILED")
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private fun versionCodeOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * True when the APK is signed by the same certificate(s) as the installed
     * app. Below API 28, or where the OS reports no signing info for an
     * archive, this cannot be checked here; the OS still refuses a mismatched
     * update at install time, this only gives a clearer error earlier.
     */
    private fun sameSigner(installed: PackageInfo, archive: PackageInfo): Boolean {
        if (Build.VERSION.SDK_INT < 28) return true
        val a = installed.signingInfo?.apkContentsSigners ?: return true
        val b = archive.signingInfo?.apkContentsSigners ?: return true
        fun hashes(sigs: Array<Signature>) = sigs.map {
            MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { x -> "%02x".format(x) }
        }.toSet()
        return hashes(a) == hashes(b)
    }
}
