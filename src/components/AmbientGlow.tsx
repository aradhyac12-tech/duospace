/**
 * Shared soft ambient glow — the diffuse colour wash sitting behind glass
 * surfaces (Auth screens originated this pattern as a private const; this
 * promotes it to a reusable component so Us/Groic/Calls/MapView can share
 * the exact same material language instead of each hand-rolling blurred
 * divs). Theme-aware (--primary/--accent), purely decorative,
 * aria-hidden + pointer-events-none, zero layout impact (absolute inset-0
 * inside a `relative` ancestor). `variant="warm"` adds a soft rose wash
 * (e.g. for Music/Calls where the reference mood is warmer than Chat/Us).
 */
const AmbientGlow = ({ variant = "cool" }: { variant?: "cool" | "warm" }) => (
  <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10" aria-hidden="true">
    <div className="absolute -top-24 -left-16 h-72 w-72 rounded-full blur-3xl opacity-25" style={{ background: "hsl(var(--primary))" }} />
    <div className="absolute -bottom-32 -right-20 h-80 w-80 rounded-full blur-3xl opacity-20" style={{ background: "hsl(var(--accent))" }} />
    {variant === "warm" && (
      <div className="absolute top-1/3 right-1/4 h-64 w-64 rounded-full blur-3xl opacity-[0.14]" style={{ background: "hsl(340 75% 65%)" }} />
    )}
  </div>
);

export default AmbientGlow;
