import storage from "@/lib/storage";

/**
 * Shared full-screen boot/loading state — used wherever the app has
 * nothing else to show yet (auth resolving, onboarding-status check, etc).
 *
 * FIX (DA-05): this exact markup (badge + pulsing label, centered on a
 * plain background) was duplicated verbatim between AuthRoute and
 * ProtectedRoutes in App.tsx — same classes, same structure, same
 * potential for drifting out of sync on a future copy change. Extracted
 * with no visual change; ProtectedRoutes' third "Setting up..." state
 * (onboarding-status check) used the same wrapper without the badge, so
 * that's folded in here too via `showBadge`.
 */
export function AppBootScreen({ label = "Loading...", showBadge = true }: { label?: string; showBadge?: boolean }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-3">
        {showBadge && (
          <div className="h-10 w-10 rounded-full bg-muted mx-auto flex items-center justify-center">
            <span className="text-sm font-semibold text-muted-foreground">
              {(storage.get("duo-app-name") || "DS").slice(0, 2).toUpperCase()}
            </span>
          </div>
        )}
        <p className="text-xs text-muted-foreground animate-pulse">{label}</p>
      </div>
    </div>
  );
}

export default AppBootScreen;
