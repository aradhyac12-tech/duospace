package com.duospace.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // === DUOSPACE PUSH ADDITIONS (added by scripts/patch-native-permissions.mjs) ===

    private static final String PROCESS_TOKEN =
        "p_" + Long.toString(System.currentTimeMillis(), 36) + "_" + (1000 + (int) (Math.random() * 9000));

    private void lifecycleLog(String event) {
        android.util.Log.i(
            "DuoSpaceLifecycle",
            event + " processToken=" + PROCESS_TOKEN + " instance=" + System.identityHashCode(this) +
                " isFinishing=" + isFinishing() + " isChangingConfigurations=" + isChangingConfigurations()
        );
    }

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Installed as the very first statement, before super.onCreate(),
        // so it's active before anything else in this process runs — see
        // CrashLogger.kt's header. showLastCrashIfAny() runs after
        // super.onCreate() below since it needs a ready Activity to show
        // a dialog on.
        com.duospace.app.CrashLogger.INSTANCE.install(this);
        android.content.Intent __initialIntent = getIntent();
        android.util.Log.i(
            "DuoSpaceLifecycle",
            "onCreate processToken=" + PROCESS_TOKEN + " instance=" + System.identityHashCode(this) +
                " savedInstanceState=" + (savedInstanceState != null
                    ? "present (config-change restore, same process)"
                    : "null (first creation in this process)") +
                " intentAction=" + (__initialIntent != null ? __initialIntent.getAction() : null) +
                " intentData=" + (__initialIntent != null ? __initialIntent.getData() : null)
        );
        super.onCreate(savedInstanceState);
        // === DUOSPACE FLAG_SECURE: block screenshots + screen recording + recents thumbnail ===
        getWindow().setFlags(
            android.view.WindowManager.LayoutParams.FLAG_SECURE,
            android.view.WindowManager.LayoutParams.FLAG_SECURE);
        com.duospace.app.CrashLogger.INSTANCE.showLastCrashIfAny(this);
        com.duospace.app.NotificationChannels.createAll(this); // @JvmStatic — real static method
        com.duospace.app.TelecomHelper.INSTANCE.registerPhoneAccount(this); // plain Kotlin object — no @JvmStatic, needs .INSTANCE from Java
        logIfOAuthCallback(__initialIntent, "onCreate");
        handleDuospaceCallIntent(__initialIntent);
        handleDuospaceNotificationIntent(__initialIntent);
        // See the Kotlin version: Telecom mute/end/decline reach a running
        // WebView without launching/foregrounding this activity.
        com.duospace.app.CallBridge.INSTANCE.setLiveSink(json -> {
            __dispatchCallActionLive(json);
            return kotlin.Unit.INSTANCE;
        });
        com.duospace.app.CallBridge.INSTANCE.setPushSink(json -> {
            __dispatchPushLive(json);
            return kotlin.Unit.INSTANCE;
        });
    }

    private void __dispatchPushLive(String json) {
        final String __js = "(function(){try{window.dispatchEvent(new CustomEvent('duospace-push-arrived', { detail: " + json + " }));}catch(e){}})();";
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(new Runnable() {
                @Override
                public void run() {
                    if (getBridge() != null && getBridge().getWebView() != null) {
                        getBridge().getWebView().evaluateJavascript(__js, null);
                    }
                }
            });
        }
    }

    private void __dispatchCallActionLive(String json) {
        final String __js = "(function(){try{window.dispatchEvent(new CustomEvent('duospace-call-action', { detail: " + json + " }));}catch(e){}})();";
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(new Runnable() {
                @Override
                public void run() {
                    if (getBridge() != null && getBridge().getWebView() != null) {
                        getBridge().getWebView().evaluateJavascript(__js, null);
                    }
                }
            });
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        lifecycleLog("onStart");
    }

    @Override
    public void onResume() {
        super.onResume();
        lifecycleLog("onResume");
        // DOUBLE-NOTIFICATION FIX: see Kotlin version above.
        com.duospace.app.CallNotificationService.isAppForegrounded = true;
    }

    @Override
    public void onPause() {
        lifecycleLog("onPause (backgrounding — e.g. system browser opening for OAuth)");
        // DOUBLE-NOTIFICATION FIX: see Kotlin version above.
        com.duospace.app.CallNotificationService.isAppForegrounded = false;
        super.onPause();
    }

    @Override
    public void onStop() {
        lifecycleLog("onStop");
        super.onStop();
    }

    @Override
    public void onDestroy() {
        boolean __unexpected = !isFinishing() && !isChangingConfigurations();
        android.util.Log.w(
            "DuoSpaceLifecycle",
            "onDestroy processToken=" + PROCESS_TOKEN + " instance=" + System.identityHashCode(this) +
                " isFinishing=" + isFinishing() + " isChangingConfigurations=" + isChangingConfigurations() +
                (__unexpected
                    ? " — UNEXPECTED: Activity destroyed by the system, not by user/config-change. If this happened mid-OAuth, the process was reclaimed for memory."
                    : "")
        );
        com.duospace.app.CallBridge.INSTANCE.setLiveSink(null);
        com.duospace.app.CallBridge.INSTANCE.setPushSink(null);
        super.onDestroy();
    }

    @Override
    public void onNewIntent(android.content.Intent intent) {
        android.util.Log.i(
            "DuoSpaceLifecycle",
            "onNewIntent RECEIVED processToken=" + PROCESS_TOKEN + " instance=" + System.identityHashCode(this) +
                " action=" + (intent != null ? intent.getAction() : null) +
                " data=" + (intent != null ? intent.getData() : null) +
                " flags=" + (intent != null ? Integer.toHexString(intent.getFlags()) : null)
        );
        super.onNewIntent(intent);
        android.util.Log.i(
            "DuoSpaceOAuth",
            "onNewIntent -> super.onNewIntent() returned; Capacitor Bridge.onNewIntent() has run. " +
                "If this intent carries duospace://auth data, JS 'appUrlOpen' has now fired — " +
                "next expected line is [DuoSpaceOAuth][auth.deeplink] from Auth.tsx."
        );
        logIfOAuthCallback(intent, "onNewIntent");
        handleDuospaceCallIntent(intent);
        handleDuospaceNotificationIntent(intent);
    }

    /** See the Kotlin version of this method (MAIN_ACTIVITY_KOTLIN_ADDITIONS
     *  in patch-native-permissions.mjs) for the full doc comment — identical
     *  behavior here. */
    private void logIfOAuthCallback(android.content.Intent intent, String via) {
        android.net.Uri data = intent != null ? intent.getData() : null;
        if (data == null) return;
        if ("duospace".equals(data.getScheme()) && "auth".equals(data.getHost())) {
            int level = "onNewIntent".equals(via) ? android.util.Log.INFO : android.util.Log.WARN;
            String pathPart = data.getPath() != null ? data.getPath() : "";
            boolean hasCode = data.getQueryParameter("code") != null;
            boolean hasError = data.getQueryParameter("error") != null || data.getQueryParameter("error_description") != null;
            String msg = "duospace://auth callback delivered via " + via + " (path=" + pathPart +
                ", hasCode=" + hasCode + ", hasError=" + hasError + ", processToken=" + PROCESS_TOKEN + ")";
            if ("onCreate".equals(via)) {
                msg += " — ACTIVITY WAS RECREATED, expected onNewIntent; check launchMode=singleTask";
            }
            android.util.Log.println(level, "DuoSpaceOAuth", msg);
        }
    }

    private void handleDuospaceCallIntent(android.content.Intent intent) {
        if (intent == null) return;
        String callId = intent.getStringExtra("callId");
        if (callId == null) return;
        String action = intent.getStringExtra("callAction");
        // See the Kotlin version: live call controls never stop the ringer
        // and are never persisted for replay.
        if (action != null && !"accept".equals(action) && !"decline".equals(action) && !"open".equals(action)) {
            try {
                org.json.JSONObject live = new org.json.JSONObject();
                live.put("callId", callId);
                live.put("action", action);
                __dispatchCallActionLive(live.toString());
            } catch (org.json.JSONException ignored) {
            }
            return;
        }

        android.content.Intent stopIntent = new android.content.Intent(this, com.duospace.app.CallRingingService.class);
        stopIntent.setAction(com.duospace.app.CallRingingService.ACTION_STOP);
        startService(stopIntent);
        // See the Kotlin version: clear the ongoing ringing notification on
        // Accept/Decline instead of leaving it up until its 45s timeout.
        if ("accept".equals(action) || "decline".equals(action)) {
            try {
                android.app.NotificationManager nm =
                    (android.app.NotificationManager) getSystemService(android.content.Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(com.duospace.app.CallNotificationService.NOTIFICATION_ID);
            } catch (Exception ignored) {
            }
        }

        try {
            org.json.JSONObject payload = new org.json.JSONObject();
            payload.put("callId", callId);
            payload.put("action", action != null ? action : "open");
            payload.put("callType", intent.getStringExtra("callType"));
            payload.put("conversationId", intent.getStringExtra("conversationId"));
            payload.put("roomName", intent.getStringExtra("roomName"));
            // COLD-START LOST-ACTION FIX: see the Kotlin version of this
            // method (MAIN_ACTIVITY_KOTLIN_ADDITIONS) for the full reasoning
            // — same durable localStorage write before the live dispatch,
            // drained by src/lib/nativeCallActionBridge.ts on boot.
            final String __js = "(function(){try{var d=" + payload.toString() + ";d.ts=Date.now();try{localStorage.setItem('duospace_pending_call_action', JSON.stringify(d));}catch(e){}; window.dispatchEvent(new CustomEvent('duospace-call-action', { detail: d }));}catch(e){}})();";
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().post(new Runnable() {
                    @Override
                    public void run() {
                        if (getBridge() != null && getBridge().getWebView() != null) {
                            getBridge().getWebView().evaluateJavascript(__js, null);
                        }
                    }
                });
            }
        } catch (org.json.JSONException e) {
            android.util.Log.w("DuoSpaceLifecycle", "handleDuospaceCallIntent: payload build failed", e);
        }
    }

    /** See the Kotlin version's handleDuospaceNotificationIntent doc comment
     *  (MAIN_ACTIVITY_KOTLIN_ADDITIONS) — identical behavior here. */
    private void handleDuospaceNotificationIntent(android.content.Intent intent) {
        if (intent == null) return;
        if (intent.getStringExtra("callId") != null) return;
        String pushType = intent.getStringExtra("pushType");
        if (pushType == null) return;
        try {
            org.json.JSONObject payload = new org.json.JSONObject();
            payload.put("type", pushType);
            payload.put("conversationId", intent.getStringExtra("conversationId"));
            final String __js = "window.dispatchEvent(new CustomEvent('duospace-notification-tap', { detail: " + payload.toString() + " }))";
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().post(new Runnable() {
                    @Override
                    public void run() {
                        if (getBridge() != null && getBridge().getWebView() != null) {
                            getBridge().getWebView().evaluateJavascript(__js, null);
                        }
                    }
                });
            }
        } catch (org.json.JSONException e) {
            android.util.Log.w("DuoSpaceLifecycle", "handleDuospaceNotificationIntent: payload build failed", e);
        }
    }

    /** See the Kotlin version's doc comment (MAIN_ACTIVITY_KOTLIN_ADDITIONS) —
     *  identical platform reasoning for why only volume keys are wired here. */
    @Override
    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        // NOTE: isRinging/isSilenced are Kotlin `var ... private set` companion
        // properties (see native/android/CallRingingService.kt) — not
        // @JvmStatic/@JvmField, so from Java they're only reachable through
        // the Kotlin-generated Companion getters, not as plain static fields
        // (unlike ACTION_STOP/ACTION_SILENCE above, which are `const val`
        // and do compile to real static fields either language can use
        // directly).
        if ((keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP || keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN) &&
            com.duospace.app.CallRingingService.Companion.isRinging() && !com.duospace.app.CallRingingService.Companion.isSilenced()
        ) {
            android.content.Intent silenceIntent = new android.content.Intent(this, com.duospace.app.CallRingingService.class);
            silenceIntent.setAction(com.duospace.app.CallRingingService.ACTION_SILENCE);
            startService(silenceIntent);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
    // === END DUOSPACE PUSH ADDITIONS ===
}
