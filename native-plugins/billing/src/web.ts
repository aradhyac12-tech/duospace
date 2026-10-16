/**
 * Web fallback for DuospaceBilling.
 *
 * Deliberately NOT a working implementation, and deliberately NOT a fake
 * one either. There is no web equivalent of Google Play Billing — a
 * browser tab cannot charge a Play Store account. Every method here
 * reports "unavailable" / rejects rather than pretending to succeed, so a
 * web preview build fails loudly and obviously instead of silently
 * granting free premium. Real purchases only happen on the Android build,
 * where index.ts loads the native plugin instead of this file.
 */
import { WebPlugin } from "@capacitor/core";
import type {
  DuospaceBillingPlugin,
  BillingConnectionState,
  GetProductsOptions,
  GetProductsResult,
  PurchaseOptions,
  PurchaseLaunchResult,
  QueryActivePurchasesResult,
  AcknowledgeOptions,
} from "./definitions";

export class BillingWeb extends WebPlugin implements DuospaceBillingPlugin {
  async connect(): Promise<{ state: BillingConnectionState }> {
    return { state: "unavailable" };
  }

  async getProducts(_options: GetProductsOptions): Promise<GetProductsResult> {
    return { products: [] };
  }

  async purchase(options: PurchaseOptions): Promise<PurchaseLaunchResult> {
    return {
      launched: false,
      productId: options.productId,
      errorMessage: "Purchases are only available in the DuoSpace Android app.",
    };
  }

  async queryActivePurchases(): Promise<QueryActivePurchasesResult> {
    return { purchases: [] };
  }

  async acknowledgePurchase(_options: AcknowledgeOptions): Promise<void> {
    // No-op: nothing to acknowledge, there was never a real purchase.
  }
}
