/**
 * OnboardingTooltip — inline contextual hints for first-time users.
 *
 * FIX AUDIT #20: Missing polished onboarding/help flows.
 * Shows a one-time dismissable tooltip anchored to a feature.
 * State is persisted in localStorage so hints are only shown once.
 *
 * Usage:
 *   <OnboardingTooltip id="chat-e2e" text="Messages are end-to-end encrypted." />
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import storage from "@/lib/storage";

interface OnboardingTooltipProps {
  /** Unique ID — used as the storage key. Must be stable across sessions. */
  id: string;
  /** The hint text to show */
  text: string;
  /** Optional emoji to lead with */
  emoji?: string;
  /** Which side to show the tip on */
  side?: "top" | "bottom" | "left" | "right";
}

const STORAGE_PREFIX = "duo-hint-dismissed-";

export function OnboardingTooltip({ id, text, emoji = "💡", side = "bottom" }: OnboardingTooltipProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = storage.get(`${STORAGE_PREFIX}${id}`);
    if (!dismissed) setVisible(true);
  }, [id]);

  const dismiss = () => {
    storage.set(`${STORAGE_PREFIX}${id}`, "1");
    setVisible(false);
  };

  const positionClass = {
    bottom: "top-full mt-2 left-1/2 -translate-x-1/2",
    top: "bottom-full mb-2 left-1/2 -translate-x-1/2",
    left: "right-full mr-2 top-1/2 -translate-y-1/2",
    right: "left-full ml-2 top-1/2 -translate-y-1/2",
  }[side];

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          className={`absolute z-50 ${positionClass} w-max max-w-[220px]`}
        >
          <div className="bg-foreground text-background rounded-xl px-3 py-2 shadow-xl flex items-start gap-2">
            <span className="text-sm shrink-0">{emoji}</span>
            <p className="text-[11px] leading-relaxed flex-1">{text}</p>
            <button
              onClick={dismiss}
              className="shrink-0 mt-0.5 opacity-60 hover:opacity-100 transition-opacity"
              aria-label="Dismiss tip"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Pre-defined hints for the main DuoSpace flows ────────────────────────────

export const HINTS = {
  CHAT_E2E: {
    id: "chat-e2e",
    text: "Messages are end-to-end encrypted. Only you and your partner can read them.",
    emoji: "🔒",
  },
  CHAT_DISAPPEAR: {
    id: "chat-disappear",
    text: "Enable disappearing messages from the ⋮ menu. Messages vanish after your chosen time.",
    emoji: "⏱️",
  },
  CHAT_NUDGE: {
    id: "chat-nudge",
    text: "Tap the ❤ to send a nudge — a gentle notification to your partner.",
    emoji: "❤️",
  },
  SETTINGS_PARTNER: {
    id: "settings-partner",
    text: "Link a partner in Settings to start chatting. Share your invite code with them.",
    emoji: "🔗",
  },
  BACKUP: {
    id: "backup-first-time",
    text: "Back up your chat history to Lovable Cloud in Settings → Backup.",
    emoji: "☁️",
  },
  CALL_VOICE: {
    id: "call-voice-tip",
    text: "Voice calls never open your camera. Video calls do — tap the camera icon to toggle.",
    emoji: "📞",
  },
} as const;
