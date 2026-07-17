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
        className="fixed top-0 left-0 right-0 z-[9998] bg-destructive flex items-center justify-center gap-2 py-2 safe-top"
      >
        <WifiOff className="h-3.5 w-3.5 text-destructive-foreground" />
        <span className="text-xs font-medium text-destructive-foreground">No internet connection</span>
      </motion.div>
    )}
  </AnimatePresence>
);

export default OfflineBanner;
