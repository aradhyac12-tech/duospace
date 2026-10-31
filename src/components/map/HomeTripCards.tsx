/**
 * HomeTripCards — the small floating cards for "heading home":
 *  - mine: a "Heading home" start pill, or an active card with Cancel
 *  - partner's: "<name> is heading home · 2.1 km · ~12 min" (+ a stopped warning)
 * Positioned by the parent (it sits above the bottom status chip).
 */
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Home, Loader2, Navigation, X } from "lucide-react";
import type { OwnTrip, PartnerTrip } from "@/hooks/useHomeTrip";

const fmtDist = (m: number | null) =>
  m == null ? "" : m < 950 ? `${Math.max(50, Math.round(m / 50) * 50)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

interface Props {
  hasHome: boolean;
  /** You are already inside the Home circle: nothing to head home to, so no start button. */
  insideHome?: boolean;
  /** Home's "tell my partner" switch — trips are only shared when it is on. */
  partnerAlertsOn: boolean;
  partnerName: string | null;
  ownTrip: OwnTrip | null;
  partnerTrip: PartnerTrip | null;
  busy: boolean;
  homeOpen: boolean;
  onStart: () => void;
  onCancel: () => void;
}

const HomeTripCards = ({ hasHome, insideHome = false, partnerAlertsOn, partnerName, ownTrip, partnerTrip, busy, homeOpen, onStart, onCancel }: Props) => {
  if (homeOpen) return null;
  return (
    <div className="flex flex-col gap-2 items-start">
      <AnimatePresence initial={false}>
        {partnerTrip && (
          <motion.div
            key="partner-trip"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            className={`rounded-2xl glass-sheet px-3 py-2 flex items-center gap-2.5 max-w-full ${partnerTrip.stalled ? "ring-1 ring-warning/60" : ""}`}
            role="status"
          >
            <span className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${partnerTrip.stalled ? "bg-warning/20 text-warning" : "bg-primary/15 text-primary"}`}>
              {partnerTrip.stalled ? <AlertTriangle className="h-4 w-4" /> : <Navigation className="h-4 w-4" />}
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[12.5px] font-medium truncate">
                {partnerName ?? "Your partner"} {partnerTrip.stalled ? "has stopped on the way home" : "is heading home"}
              </span>
              <span className="block text-[10.5px] text-foreground-secondary tabular-nums truncate">
                {[fmtDist(partnerTrip.distance_m), partnerTrip.eta_min != null ? `~${partnerTrip.eta_min} min` : "estimating…"].filter(Boolean).join(" · ")}
              </span>
            </span>
          </motion.div>
        )}

        {hasHome && !insideHome && !ownTrip && (
          <motion.button
            key="start-trip"
            type="button"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            onClick={onStart}
            disabled={busy}
            aria-label="Start heading home"
            className="rounded-full glass-sheet pl-2.5 pr-3.5 h-10 flex items-center gap-2 text-[12.5px] font-medium active:scale-95 transition-transform disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Home className="h-4 w-4 text-primary" />}
            I'm heading home
          </motion.button>
        )}

        {ownTrip && (
          <motion.div
            key="own-trip"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            className="rounded-2xl glass-sheet pl-3 pr-1.5 py-1.5 flex items-center gap-2.5 max-w-full"
            role="status"
          >
            <span className="h-8 w-8 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
              <Navigation className="h-4 w-4" />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[12.5px] font-medium truncate">Heading home</span>
              <span className="block text-[10.5px] text-foreground-secondary truncate">
                {partnerName && partnerAlertsOn ? `${partnerName} can follow along` : "Not shared — Home alerts are off"}
              </span>
            </span>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              aria-label="Cancel heading home"
              className="h-8 w-8 rounded-full bg-foreground/[0.08] flex items-center justify-center shrink-0 active:scale-95 transition-transform"
            >
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default HomeTripCards;
