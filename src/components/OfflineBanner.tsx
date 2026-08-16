import { motion, AnimatePresence } from "framer-motion";
import { WifiOff } from "lucide-react";

interface OfflineBannerProps {
  isOnline: boolean;
}

const OfflineBanner = ({ isOnline }: OfflineBannerProps) => (
  <AnimatePresence>
    {!isOnline && (
      <motion.div
        initial={{ y: -40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -40, opacity: 0 }}
        role="status"
        // --offline (mapped to --warning) rather than --destructive: losing
        // connectivity is a transient, recoverable state, not an error the
        // user caused — the destructive channel stays reserved for actual
        // errors/deletion elsewhere in the app.
        className="fixed top-0 left-0 right-0 z-[9998] bg-offline flex items-center justify-center gap-2 py-2 safe-top"
      >
        <WifiOff className="h-3.5 w-3.5 text-offline-foreground" />
        <span className="text-xs font-medium text-offline-foreground">No internet connection</span>
      </motion.div>
    )}
  </AnimatePresence>
);

export default OfflineBanner;
