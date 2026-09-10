import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Music, X } from "lucide-react";
import { useGroic } from "@/contexts/GroicContext";
import { hapticMedium } from "@/lib/haptics";

/**
 * GroicInviteBanner — "Your partner started listening — tap to join".
 * Mounted globally (AppLayout) so it can surface on any screen, not just
 * the Groic page itself, the moment the partner's heartbeat/tick/load is
 * detected while this device is idle (sessionRole === "solo").
 */
const GroicInviteBanner = () => {
  const { partnerInviteActive, joinPartnerSession, dismissPartnerInvite } = useGroic();
  const navigate = useNavigate();

  const handleJoin = () => {
    hapticMedium();
    joinPartnerSession();
    navigate("/groic");
  };

  const handleDismiss = () => {
    dismissPartnerInvite();
  };

  return (
    <AnimatePresence>
      {partnerInviteActive && (
        <motion.div
          key="groic-invite"
          initial={{ y: -60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -60, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          className="fixed left-3 right-3 z-[70] safe-top"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 8px)" }}
        >
          <button
            onClick={handleJoin}
            className="w-full flex items-center gap-3 p-3 rounded-2xl bg-primary text-primary-foreground shadow-[0_10px_40px_-12px_hsl(var(--primary)/0.6)] active:scale-[0.98] transition-transform text-left"
          >
            <div className="h-9 w-9 rounded-full bg-primary-foreground/20 flex items-center justify-center shrink-0">
              <Music className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-tight">Your partner started listening 🎧</p>
              <p className="text-[11px] opacity-85 leading-tight mt-0.5">Tap to join in sync</p>
            </div>
            <span
              role="button"
              aria-label="Dismiss"
              onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
              className="h-7 w-7 rounded-full bg-primary-foreground/15 flex items-center justify-center shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default GroicInviteBanner;
