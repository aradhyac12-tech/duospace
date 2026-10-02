// Paywall copy. RULE (enforced by src/test/monetization/marketing.test.ts):
// a highlight may only describe something that is ENFORCED today. Anything
// still PENDING lives in `comingSoon`, which the paywall labels "Not available
// yet" and never as a benefit.
import { AI_QUOTA_DISPLAY, SELL_PRO, type PlanLevel, type PlanScope } from "./config";

export interface PlanCopy {
  name: string;
  tagline: string;
  badge?: string;
  highlights: string[];
  /** Declared in the entitlement contract but not built/enforced yet. */
  comingSoon: string[];
}

export const PLAN_MARKETING: Record<PlanLevel, PlanCopy> = {
  FREE: {
    name: "Free",
    tagline: "Core DuoSpace — chat, calls, memories and more.",
    highlights: [
      "Private chat, calls, photos and voice notes",
      "Memories, mood check-ins, music and surprises",
      `${AI_QUOTA_DISPLAY.FREE.standardPerDay} AI helper actions a day`,
      "All safety, privacy and data controls",
    ],
    comingSoon: [],
  },
  PLUS: {
    name: "Plus",
    tagline: "Everything you need to get more from DuoSpace.",
    highlights: [
      `${AI_QUOTA_DISPLAY.PLUS.standardPerDay} AI helper actions a day`,
      "All premium themes",
      "Theme Studio — build your own look",
    ],
    comingSoon: ["Expanded storage", "Advanced memory and discovery", "Ad-free (no ads are shown today)"],
  },
  PRO: {
    name: "Pro",
    tagline: "Higher limits, first in line for deeper intelligence.",
    badge: "Highest limits",
    highlights: [
      `${AI_QUOTA_DISPLAY.PRO.standardPerDay} AI helper actions a day`,
      "Everything in Plus",
    ],
    comingSoon: [
      "Deep relationship analysis",
      "Advanced compatibility and conflict-repair tools",
      "Long-term relationship insights",
      "Priority support",
    ],
  },
};

/** Which levels to offer as purchases, given what the user already has. */
export function upgradeOptionsFor(level: PlanLevel, _scope: PlanScope): { levels: Array<"PLUS" | "PRO"> } {
  if (level === "FREE") return { levels: SELL_PRO ? ["PLUS", "PRO"] : ["PLUS"] };
  if (level === "PLUS") return { levels: SELL_PRO ? ["PRO"] : [] };
  return { levels: [] };
}
