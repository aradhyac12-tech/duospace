import { useEffect, useState } from "react";
import { methodNote, priceCaption } from "@/lib/monetization/billingCopy";
import { AdSlot } from "@/components/monetization/AdSlot";
import { motion } from "framer-motion";
import { Capacitor } from "@capacitor/core";
import { Check, ChevronDown, Crown, Heart, Loader2, Sparkles } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useEntitlement } from "@/hooks/useEntitlement";
import { usePurchase } from "@/hooks/usePurchase";
import { useRazorpayCheckout } from "@/hooks/useRazorpayCheckout";
import { useRazorpaySubscription } from "@/hooks/useRazorpaySubscription";
import { useToast } from "@/hooks/use-toast";
import { hapticMedium } from "@/lib/haptics";
import {
  PRODUCT_IDS,
  FALLBACK_DISPLAY_PRICING,
  FEATURE_FLAGS,
  AI_QUOTA_DISPLAY,
  productIdFor,
  type PlanScope,
  type ProductId,
} from "@/lib/monetization/config";
import { PLAN_MARKETING, upgradeOptionsFor } from "@/lib/monetization/marketing";
import { SELL_PRO } from "@/lib/monetization/config";
import { DuospaceBilling, type BillingProductPrice } from "duospace-billing";
import {
  getAvailablePaymentMethods,
  paymentMethodsCopy,
  type Distribution,
} from "@/lib/monetization/paymentRouting";

/**
 * DuoSpace Plus — the subscription screen. Lives inside Settings (this is
 * NOT a new top-level tab, per the monetization brief's "do not redesign
 * DuoSpace" rule) and reuses the same card/row visual language as every
 * other Settings subpage (PageHeader, bg-card rounded-2xl border, Button).
 *
 * Shows Google Play's own live, localized prices once getProducts()
 * resolves; falls back to FALLBACK_DISPLAY_PRICING (config.ts) only for the
 * brief window before that, or if Billing is unavailable on this device.
 *
 * The actual purchase→verify→entitlement flow is entirely in usePurchase() —
 * this component only renders state and calls buy(); it never marks anyone
 * "Plus" itself.
 */
const DuoSpacePlusSettings = () => {
  const { plan, level, scope: ownedScope, status: entStatus, loading: entitlementLoading, isPlus, isComplimentary, refreshEntitlement } = useEntitlement();
  const [scope, setScope] = useState<PlanScope>("INDIVIDUAL");
  const [expanded, setExpanded] = useState<string | null>(null);
  const { buy, state: purchaseState, error: purchaseError } = usePurchase();
  const { pay: razorpayPay, state: razorpayState, error: razorpayError } = useRazorpayCheckout();
  const rzSub = useRazorpaySubscription();
  const razorpayBusy = razorpayState === "creating_order" || razorpayState === "awaiting_payment" || razorpayState === "verifying";
  const { toast } = useToast();
  const [livePrices, setLivePrices] = useState<Record<string, BillingProductPrice>>({});
  const [playChecked, setPlayChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await DuospaceBilling.connect();
        const { products } = await DuospaceBilling.getProducts({
          productIds: Object.values(PRODUCT_IDS),
        });
        if (cancelled) return;
        const map: Record<string, BillingProductPrice> = {};
        products.forEach((p) => { map[p.productId] = p; });
        setLivePrices(map);
      } catch {
        // Billing unavailable on this device/build — the fallback display
        // prices below cover this; never block the screen on it.
      } finally {
        if (!cancelled) setPlayChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (purchaseState === "done") {
      hapticMedium();
      toast({ title: "You're on DuoSpace Plus", description: "Enjoy the new features." });
    } else if (purchaseState === "pending") {
      // PHASE 3: a pending purchase (e.g. a cash payment method still
      // settling) has NOT unlocked Plus yet — set expectations, don't
      // imply success. It'll resolve on its own via a later purchaseUpdated
      // event, an RTDN notification, or the next restore pass.
      toast({
        title: "Payment pending",
        description: "Google Play is still processing this. Plus will activate automatically once it clears.",
      });
    } else if (purchaseState === "error" && purchaseError) {
      toast({ title: "Purchase didn't go through", description: purchaseError, variant: "destructive" });
    }
  }, [purchaseState, purchaseError, toast]);

  useEffect(() => {
    if (razorpayState === "done") {
      hapticMedium();
      toast({ title: "You're on DuoSpace Plus", description: "Paid via Razorpay." });
    } else if (razorpayState === "error" && razorpayError) {
      toast({ title: "Payment didn't go through", description: razorpayError, variant: "destructive" });
    }
  }, [razorpayState, razorpayError, toast]);

  const priceLabelFor = (productId: ProductId): string =>
    livePrices[productId]?.formattedPrice ?? FALLBACK_DISPLAY_PRICING[productId].label;

  const purchasing = purchaseState === "purchasing" || purchaseState === "verifying";

  // PHASE 13/14: the footer copy reflects what's actually available. Country
  // stays null and alternative billing false until wired to trusted sources
  // (see paymentRouting.ts header), so today this resolves to Google Play
  // only for Play installs, and never exposes Razorpay to Play users.
  // Google Play Billing only exists inside an installed Android app. In a
  // browser (or any non-native build) getProducts() is always empty, which
  // is what produced "This plan isn't available to purchase right now".
  // So: not native -> "web" (Razorpay only); native -> VITE_DISTRIBUTION,
  // defaulting to play_store (Play policy path).
  // Web -> Razorpay. Android (.apk from Play) -> Google Play Billing.
  // iOS (.ipa) -> Apple In-App Purchase. Set VITE_DISTRIBUTION=sideload only
  // for an Android APK installed outside Play (then Razorpay is used).
  const envDistribution = (import.meta as any)?.env?.VITE_DISTRIBUTION as Distribution | undefined;
  const nativePlatform = Capacitor.getPlatform();
  const distribution: Distribution = !Capacitor.isNativePlatform()
    ? "web"
    : nativePlatform === "ios"
      ? "app_store"
      : (envDistribution === "sideload" ? "sideload" : "play_store");
  const paymentMethods = getAvailablePaymentMethods({
    distribution,
    country: null,
    platform: nativePlatform === "ios" ? "ios" : nativePlatform === "android" ? "android" : "web",
    alternativeBillingEnrolled: false,
    razorpayConfigured: FEATURE_FLAGS.razorpayEnabled,
  });

  if (!FEATURE_FLAGS.subscriptionsEnabled) {
    return (
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
      >
        <PageHeader title="DuoSpace Plus" subtitle="Coming soon" />
        <div className="px-5 pt-8 text-center text-sm text-muted-foreground">
          DuoSpace Plus isn't available yet — check back soon.
        </div>
      </motion.div>
    );
  }

  const complimentary = isComplimentary;
  const noMethods = paymentMethods.length === 0;
  const options = upgradeOptionsFor(level, ownedScope);
  const tiers = (["PLUS", "PRO"] as const).filter((lv) => options.levels.includes(lv));

  const productFor = (lv: "PLUS" | "PRO"): ProductId | null => {
    try {
      const id = productIdFor(lv, scope);
      if (lv === "PLUS" && scope === "INDIVIDUAL" && !FEATURE_FLAGS.individualPlusEnabled) return null;
      if (lv === "PLUS" && scope === "COUPLE" && !FEATURE_FLAGS.couplePlusEnabled) return null;
      return id;
    } catch { return null; }
  };

  const ctaLabel = (lv: "PLUS" | "PRO"): string => {
    const name = PLAN_MARKETING[lv].name;
    if (level === "PLUS" && lv === "PRO") return scope === "COUPLE" ? "Upgrade to Pro Couple" : "Upgrade to Pro";
    return scope === "COUPLE" ? `Get ${name} for both of us` : `Get ${name}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
      style={{ paddingBottom: "calc(6rem + var(--ad-banner-height, 0px))" }}
    >
      <PageHeader title={SELL_PRO ? "DuoSpace Plus & Pro" : "DuoSpace Plus"} subtitle="Optional — everything core stays free" />

      <div className="px-5 pt-5 space-y-4">
        {entStatus === "checking" && (
          <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking subscription…
          </div>
        )}
        {(entStatus === "unavailable" || entStatus === "stale") && (
          <div className="rounded-2xl border border-border/60 bg-card px-4 py-3 text-xs text-muted-foreground" role="status">
            {entStatus === "stale"
              ? "Can't reach the server right now — showing your last known plan."
              : "Can't check your subscription right now. Your plan hasn't changed; try again in a moment."}
            <button className="ml-2 underline" onClick={() => void refreshEntitlement()}>Retry</button>
          </div>
        )}

        {isPlus && !entitlementLoading && (
          <div className="bg-accent/10 rounded-2xl border border-accent/30 px-4 py-3.5 flex items-center gap-3">
            <Crown className="h-5 w-5 text-accent shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {plan === "ADMIN" ? "Admin — everything unlocked"
                  : complimentary ? "Premium is included with your account"
                  : level === "PRO" ? "You're on Pro"
                  : "You're on Plus"}
                {!complimentary && ownedScope === "COUPLE" ? " · covers you and your partner" : ""}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {complimentary ? "Nothing to buy." : "Manage or cancel from the store or payment app you used."}
              </p>
              {!complimentary && rzSub.active && (
                rzSub.cancelScheduled ? (
                  <p className="text-[11px] text-muted-foreground mt-1">Renewal is off. You keep access until this period ends.</p>
                ) : (
                  <button
                    disabled={rzSub.busy}
                    onClick={async () => {
                      const ok = await rzSub.cancelRenewal();
                      toast(ok
                        ? { title: "Renewal cancelled", description: "You keep access until this period ends." }
                        : { title: "Couldn't cancel", description: "Please try again in a moment.", variant: "destructive" });
                    }}
                    className="text-[11px] underline text-muted-foreground mt-1 disabled:opacity-50"
                  >
                    {rzSub.busy ? "Cancelling…" : "Cancel renewal"}
                  </button>
                )
              )}
            </div>
          </div>
        )}

        {/* Scope selector — capabilities are identical; only coverage differs. */}
        {tiers.length > 0 && entStatus !== "checking" && (
          <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-muted/50 p-1" role="group" aria-label="Who is this for?">
            {([["INDIVIDUAL", "For me"], ["COUPLE", "For both of us"]] as const).map(([sc, label]) => (
              <button
                key={sc}
                onClick={() => { hapticMedium(); setScope(sc); }}
                aria-pressed={scope === sc}
                className={`h-9 rounded-xl text-sm font-medium transition-colors ${scope === sc ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {level === "FREE" && entStatus !== "checking" && (
          <div className="bg-card rounded-2xl border border-border/60 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Heart className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">Free</p>
                  <p className="text-[11px] text-muted-foreground">{PLAN_MARKETING.FREE.tagline}</p>
                </div>
              </div>
              <p className="text-sm font-semibold text-foreground">₹0</p>
            </div>
            <ul className="mt-3 space-y-1.5">
              {PLAN_MARKETING.FREE.highlights.map((perk) => (
                <li key={perk} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                  <Check className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />{perk}
                </li>
              ))}
            </ul>
          </div>
        )}

        {entStatus !== "checking" && tiers.map((lv) => {
          const copy = PLAN_MARKETING[lv];
          const productId = productFor(lv);
          if (!productId) return null;
          const price = (livePrices[productId]?.formattedPrice ?? FALLBACK_DISPLAY_PRICING[productId].label).replace(/\/month$/, "");
          const highlight = lv === "PRO";
          return (
            <div key={lv} className={`relative bg-card rounded-2xl p-4 ${highlight ? "border-2 border-accent/60 shadow-sm" : "border border-border/60"}`}>
              {copy.badge && (
                <span className="absolute -top-2.5 left-4 inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-semibold text-accent-foreground">
                  <Sparkles className="h-3 w-3" aria-hidden="true" />{copy.badge}
                </span>
              )}
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground">{copy.name}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{copy.tagline}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-base font-semibold text-foreground tabular-nums leading-none">{price}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">{priceCaption(paymentMethods)} · {scope === "COUPLE" ? "both of you" : "just you"}</p>
                </div>
              </div>

              <ul className="mt-3.5 space-y-1.5">
                {copy.highlights.map((perk) => (
                  <li key={perk} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                    <Check className="h-4 w-4 text-accent shrink-0" aria-hidden="true" />{perk}
                  </li>
                ))}
              </ul>

              <button
                className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground"
                onClick={() => setExpanded(expanded === lv ? null : lv)}
                aria-expanded={expanded === lv}
              >
                See everything <ChevronDown className={`h-3 w-3 transition-transform ${expanded === lv ? "rotate-180" : ""}`} aria-hidden="true" />
              </button>
              {expanded === lv && (
                <div className="mt-2 space-y-2 text-[11px] text-muted-foreground">
                  <p>
                    AI helper actions: {AI_QUOTA_DISPLAY[lv].standardPerDay} per day, counted on our servers
                    (Free: {AI_QUOTA_DISPLAY.FREE.standardPerDay}). Limits may change.
                  </p>
                  {copy.comingSoon.length > 0 && (
                    <div>
                      <p className="font-medium text-foreground/80">Not available yet</p>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {copy.comingSoon.map((c) => <li key={c}>{c}</li>)}
                      </ul>
                    </div>
                  )}
                  <p>
                    {scope === "COUPLE"
                      ? "Same features as the individual plan. Your currently linked partner gets this level too, and loses it if you unlink."
                      : "Covers your account only."}
                  </p>
                </div>
              )}

              <div className="mt-4 space-y-2">
                {paymentMethods.includes("google_play") && (
                  <Button
                    className="w-full"
                    disabled={purchasing || (playChecked && !livePrices[productId])}
                    onClick={() => buy(productId)}
                  >
                    {purchasing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : ctaLabel(lv)}
                  </Button>
                )}
                {paymentMethods.includes("google_play") && (
                  <p className="text-[11px] text-muted-foreground text-center">{methodNote("google_play")}</p>
                )}
                {paymentMethods.includes("google_play") && playChecked && !livePrices[productId] && (
                  <p className="text-[11px] text-muted-foreground text-center">
                    This plan isn't live in Google Play yet. Install from Play (internal testing) with the
                    subscription set to Active in Play Console.
                  </p>
                )}
                {paymentMethods.includes("razorpay") && (
                  <Button
                    variant={paymentMethods.includes("google_play") ? "outline" : "default"}
                    className="w-full"
                    disabled={razorpayBusy}
                    onClick={() => razorpayPay(productId)}
                  >
                    {razorpayBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      : paymentMethods.includes("google_play") ? "Pay with UPI / Card" : `${ctaLabel(lv)} — UPI / Card`}
                  </Button>
                )}
                {paymentMethods.includes("razorpay") && (
                  <p className="text-[11px] text-muted-foreground text-center">{methodNote("razorpay")}</p>
                )}
                {paymentMethods.includes("apple_iap") && (
                  <Button className="w-full" disabled>Apple In-App Purchase — coming soon</Button>
                )}
                {noMethods && <Button className="w-full" disabled>Not available on this install yet</Button>}
              </div>
            </div>
          );
        })}

        {level === "PRO" && !complimentary && (
          <p className="text-[11px] text-muted-foreground text-center">You're on the highest plan.</p>
        )}

        <p className="text-[11px] text-muted-foreground text-center px-2">
          {complimentary ? "Premium is complimentary on this account." : paymentMethodsCopy(paymentMethods)}
        </p>
      </div>
      {/* Free-tier banner; the policy hides it for paying/complimentary plans. */}
      <AdSlot surface="plans_screen_footer" />
    </motion.div>
  );
};

export default DuoSpacePlusSettings;
