/**
 * DuospaceBilling — thin bridge to Google Play Billing Library (subscriptions
 * only: Individual Plus / Couple Plus). Android only for now; see web.ts.
 *
 * SECURITY MODEL — read this before calling anything here from a component:
 * Every method on this plugin reports what the *device's* Play Store client
 * told it. None of that is proof of payment by itself — a rooted device or a
 * modified Play Store client could fake a local "purchase successful"
 * callback. This plugin's job stops at handing you the productId +
 * purchaseToken Google gave it. The app MUST send those to the
 * `verify-google-play-purchase` Supabase Edge Function, which calls Google's
 * server-to-server Play Developer API and is the only thing allowed to write
 * to `entitlements`. Never flip any local "isPlus" state from this plugin's
 * result directly — always go through useEntitlement() after the server
 * confirms.
 *
 * ASYNC PURCHASE MODEL — read this before calling purchase():
 * `purchase()` ONLY launches Google Play's UI and resolves once that launch
 * either succeeded or failed to even start. It is NOT the purchase result —
 * Play's UI is a separate Activity the user interacts with for an
 * arbitrary amount of time (and can background/kill your app during), and
 * the real outcome (bought / pending / cancelled / error) arrives later,
 * asynchronously, via the "purchaseUpdated" event below. Treating
 * `purchase()`'s resolved value as proof of anything is the exact bug this
 * type shape exists to prevent — see src/hooks/usePurchase.ts for the
 * correct listener-based flow.
 */
import type { PluginListenerHandle } from "@capacitor/core";

export type BillingConnectionState = "connected" | "disconnected" | "unavailable";

/** One purchasable subscription offer (a base plan, or a promotional offer on it). */
export interface SubscriptionOffer {
  basePlanId: string;
  /** null/absent for the plain base plan; set for promotional/intro offers. */
  offerId?: string | null;
  offerToken: string;
  /** Steady-state (recurring) price in Play's localized format. */
  formattedPrice: string;
  priceCurrencyCode: string;
  priceAmountMicros: number;
  /** ISO-8601 period of the recurring phase, e.g. "P1M". */
  billingPeriod: string;
  isFreeTrial: boolean;
  isIntroductory: boolean;
}

export interface BillingProductPrice {
  productId: string;
  /** Every offer Play returned. Choose deliberately — never assume the first. */
  offers?: SubscriptionOffer[];
  formattedPrice: string;
  priceCurrencyCode: string;
  priceAmountMicros: number;
  title: string;
  description: string;
}

export interface GetProductsOptions {
  productIds: string[];
}

export interface GetProductsResult {
  products: BillingProductPrice[];
}

export interface PurchaseOptions {
  productId: string;
  /** Which base plan to buy. Required when the product has more than one. */
  basePlanId?: string;
  /** Promotional offer to apply; omit for the plain base plan. */
  offerId?: string;
  /**
   * Server-derived, privacy-preserving account-binding token — NOT the raw
   * Supabase user id and NOT an email. Get this from the
   * `get-billing-account-token` Edge Function immediately before calling
   * purchase(); it's a deterministic HMAC the backend can recompute during
   * verification to prove the purchase belongs to the account submitting
   * it. See docs/MONETIZATION_ARCHITECTURE.md "Account binding" section.
   */
  obfuscatedAccountId: string;
}

/** Launch acknowledgement only. This is NOT the purchase result. */
export interface PurchaseLaunchResult {
  launched: boolean;
  productId: string;
  errorMessage?: string;
}

// Mirrors Google Play Billing's own Purchase.PurchaseState values (1/2/0),
// plus two states this plugin adds locally for cases Billing's enum doesn't
// cover: "cancelled" (user backed out of the UI — BillingResponseCode
// USER_CANCELED, never reaches a Purchase object at all) and "error" (any
// other non-OK response). Only "purchased" may ever lead to verification.
export type PurchaseState = "purchased" | "pending" | "unspecified" | "cancelled" | "error";

export interface PurchaseUpdatedEvent {
  state: PurchaseState;
  productId: string;
  /** Opaque token — send this, unmodified, to verify-google-play-purchase.
   *  Absent for cancelled/error. */
  purchaseToken?: string;
  orderId?: string;
  /** Epoch milliseconds, as Google reports it. */
  purchaseTimeMillis?: number;
  isAutoRenewing?: boolean;
  /** Whether Play itself already considers this acknowledged (informational
   *  — DuoSpace's real acknowledgement path is server-side). */
  isAcknowledged?: boolean;
  /** Echoes back the obfuscatedAccountId this purchase was launched with,
   *  when Play returns it. The backend's account-binding recheck during
   *  verification is the real guard, not this field. */
  obfuscatedAccountId?: string;
  errorMessage?: string;
}

export interface QueryActivePurchasesResult {
  purchases: PurchaseUpdatedEvent[];
}

export interface AcknowledgeOptions {
  purchaseToken: string;
}

export interface DuospaceBillingPlugin {
  connect(): Promise<{ state: BillingConnectionState }>;

  getProducts(options: GetProductsOptions): Promise<GetProductsResult>;

  /**
   * Launches Play's native purchase UI. Resolves as soon as the UI has
   * launched (or failed to launch) — this is a LAUNCH ACKNOWLEDGEMENT ONLY,
   * never the purchase result. Listen for "purchaseUpdated" for the actual
   * outcome, which can arrive seconds to minutes later, in a separate app
   * lifecycle, or not to this device session at all (see
   * queryActivePurchases / the restore-on-launch flow for that last case).
   */
  purchase(options: PurchaseOptions): Promise<PurchaseLaunchResult>;

  /** Discovery mechanism for restore/recovery — still must go through
   *  verification before being trusted, same as a fresh purchase. */
  queryActivePurchases(): Promise<QueryActivePurchasesResult>;

  /** Client-side acknowledgement fallback only — DuoSpace's primary path is
   *  server-side, right after verification. See PHASE 8 in
   *  docs/MONETIZATION_ARCHITECTURE.md. */
  acknowledgePurchase(options: AcknowledgeOptions): Promise<void>;

  addListener(
    eventName: "purchaseUpdated",
    listenerFunc: (result: PurchaseUpdatedEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
