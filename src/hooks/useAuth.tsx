// PERF/RELIABILITY FIX (Phase 1 #1): this hook used to own the auth
// subscription/refresh-timer lifecycle directly, so every one of its 30+
// call sites across the app created its own `onAuthStateChange` listener,
// its own proactive-refresh timer, and its own `notifyCurrentDeviceSignIn()`
// call on every sign-in event. That state now lives exactly once in
// <AuthProvider> (src/contexts/AuthContext.tsx, mounted once near the root
// in App.tsx). This hook is now just the read side — same return shape
// ({ user, loading, refreshFailed }), so no call site needs to change.
export { useAuthContext as useAuth } from "@/contexts/AuthContext";
