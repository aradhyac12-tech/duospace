package com.duospace.app

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * WhatsApp-style "Ringing…" for the CALLER when the callee's app is killed.
 *
 * The moment this device receives the incoming-call push it tells the
 * call-ringing Edge Function "this phone got the call and is ringing". That
 * stamps call_history.ringing_at, which the caller's app watches, flipping the
 * caller's screen from "Calling…" to "Ringing…". Best effort: never throws, never
 * blocks the ringer (own thread), one retry. Uses the same single-call token
 * the push already carries for instant-decline (callId + receiver bound,
 * short expiry) — the ack endpoint is a strictly weaker action than decline.
 */
object CallRingingAck {
    fun send(data: Map<String, String>) {
        val declineUrl = data["declineUrl"] ?: return
        val callId = data["callId"] ?: return
        val receiver = data["declineReceiver"] ?: return
        val exp = data["declineExp"]?.toLongOrNull() ?: return
        val token = data["declineToken"] ?: return
        if (!declineUrl.startsWith("https://") || !declineUrl.endsWith("/call-decline")) return
        val url = declineUrl.removeSuffix("/call-decline") + "/call-ringing"
        val body = JSONObject().apply {
            put("callId", callId); put("receiverId", receiver); put("exp", exp); put("token", token)
        }.toString().toByteArray()
        Thread {
            repeat(2) { attempt ->
                try {
                    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"; connectTimeout = 5000; readTimeout = 5000; doOutput = true
                        setRequestProperty("Content-Type", "application/json")
                    }
                    try {
                        conn.outputStream.use { it.write(body) }
                        if (conn.responseCode == 200) return@Thread
                    } finally { conn.disconnect() }
                } catch (_: Exception) { /* best effort */ }
                if (attempt == 0) try { Thread.sleep(1200) } catch (_: InterruptedException) { return@Thread }
            }
        }.apply { isDaemon = true; name = "call-ringing-ack" }.start()
    }
}
