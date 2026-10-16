package com.duospace.billing

import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * JS-facing bridge for DuospaceBilling, wrapping Google Play Billing
 * Library 7 (subscriptions only — DuoSpace has no consumable/one-time
 * products). See src/definitions.ts for the full contract and, critically,
 * the security note: nothing this class reports is trusted as proof of
 * payment by itself. It only surfaces what Play's own client told this
 * device; server-side verification (verify-google-play-purchase) is what
 * actually grants an entitlement.
 *
 * One BillingClient per process, held here for the plugin's lifetime —
 * Google's own guidance is to keep a single long-lived connection rather
 * than reconnecting per call.
 */
@CapacitorPlugin(name = "DuospaceBilling")
class BillingPlugin : Plugin() {

    private var billingClient: BillingClient? = null
    private var connected = false

    // Cached ProductDetails from the last getProducts() call, keyed by
    // productId, so purchase() can build BillingFlowParams without another
    // round trip to Play.
    private val productDetailsCache = mutableMapOf<String, ProductDetails>()

    // Tracks which product the most recent purchase() call launched, so the
    // cancelled/error branches below — which Google gives no Purchase
    // object for at all — can still tell the JS listener WHICH attempted
    // purchase failed, instead of an ambiguous productId-less event.
    private var lastRequestedProductId: String? = null

    private val purchasesUpdatedListener = PurchasesUpdatedListener { result, purchases ->
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                purchases?.forEach { purchase ->
                    notifyListeners("purchaseUpdated", purchaseToJs(purchase))
                }
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> {
                val obj = JSObject()
                obj.put("state", "cancelled")
                obj.put("productId", lastRequestedProductId ?: "")
                notifyListeners("purchaseUpdated", obj)
            }
            else -> {
                val obj = JSObject()
                obj.put("state", "error")
                obj.put("productId", lastRequestedProductId ?: "")
                obj.put("errorMessage", result.debugMessage)
                notifyListeners("purchaseUpdated", obj)
            }
        }
    }

    private fun ensureClient(): BillingClient {
        val existing = billingClient
        if (existing != null) return existing
        val client = BillingClient.newBuilder(context)
            .setListener(purchasesUpdatedListener)
            .enablePendingPurchases()
            .build()
        billingClient = client
        return client
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val client = ensureClient()
        if (client.isReady) {
            val obj = JSObject()
            obj.put("state", "connected")
            call.resolve(obj)
            return
        }
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                connected = result.responseCode == BillingClient.BillingResponseCode.OK
                val obj = JSObject()
                obj.put("state", if (connected) "connected" else "unavailable")
                call.resolve(obj)
            }

            override fun onBillingServiceDisconnected() {
                connected = false
                // Deliberately not auto-reconnecting here — the next call
                // that needs the client (getProducts/purchase) will call
                // connect() again via ensureConnected(), same as Google's
                // own recommended pattern of reconnecting on next use
                // rather than a background retry loop.
            }
        })
    }

    private fun ensureConnected(call: PluginCall, onReady: () -> Unit) {
        val client = ensureClient()
        if (client.isReady) { onReady(); return }
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    connected = true
                    onReady()
                } else {
                    call.reject("Billing unavailable: ${result.debugMessage}")
                }
            }
            override fun onBillingServiceDisconnected() { connected = false }
        })
    }

    @PluginMethod
    fun getProducts(call: PluginCall) {
        val ids = call.getArray("productIds")?.toList<String>() ?: emptyList()
        if (ids.isEmpty()) {
            call.reject("productIds is required")
            return
        }
        ensureConnected(call) {
            val productList = ids.map { id ->
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(id)
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build()
            }
            val params = QueryProductDetailsParams.newBuilder().setProductList(productList).build()
            billingClient!!.queryProductDetailsAsync(params) { result, productDetailsList ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    call.reject("queryProductDetails failed: ${result.debugMessage}")
                    return@queryProductDetailsAsync
                }
                val jsArray = JSArray()
                productDetailsList.forEach { details ->
                    productDetailsCache[details.productId] = details
                    val allOffers = details.subscriptionOfferDetails.orEmpty()
                    // Explicit offer list (basePlanId / offerId / offerToken) — the JS
                    // layer and purchase() choose from these deliberately instead of
                    // taking whichever offer Play happens to list first.
                    val offersJs = JSArray()
                    allOffers.forEach { offersJs.put(offerToJs(it)) }
                    // Top-level price fields describe the plain base-plan offer (no
                    // promotional offerId) so existing price display keeps working.
                    val defaultOffer = allOffers.firstOrNull { it.offerId == null }
                    val recurring = defaultOffer?.let { recurringPhase(it) }
                    val obj = JSObject()
                    obj.put("productId", details.productId)
                    obj.put("title", details.title)
                    obj.put("description", details.description)
                    obj.put("formattedPrice", recurring?.formattedPrice ?: "")
                    obj.put("priceCurrencyCode", recurring?.priceCurrencyCode ?: "")
                    obj.put("priceAmountMicros", recurring?.priceAmountMicros ?: 0L)
                    obj.put("offers", offersJs)
                    jsArray.put(obj)
                }
                val out = JSObject()
                out.put("products", jsArray)
                call.resolve(out)
            }
        }
    }

    @PluginMethod
    fun purchase(call: PluginCall) {
        val productId = call.getString("productId")
        if (productId == null) {
            call.reject("productId is required")
            return
        }
        // FIX (async purchase bug): this used to resolve with
        // {state:"pending", productId} and the JS side (usePurchase.ts)
        // incorrectly read that as a real purchase-state value and looked
        // for a purchaseToken on it. There never was one to find here —
        // launchBillingFlow() is fire-and-forget; the *actual* result only
        // ever arrives via purchasesUpdatedListener below, asynchronously,
        // in a separate callback that can fire seconds later or in a
        // different app lifecycle entirely. This method now resolves with
        // a distinctly-shaped PurchaseLaunchResult (`launched: Boolean`, no
        // `state` field at all) so it can never again be mistaken for a
        // purchase outcome by the JS side or by future contributors.
        val obfuscatedAccountId = call.getString("obfuscatedAccountId")
        if (obfuscatedAccountId.isNullOrBlank()) {
            call.reject("obfuscatedAccountId is required for account binding")
            return
        }
        ensureConnected(call) {
            val details = productDetailsCache[productId]
            if (details == null) {
                call.reject("Call getProducts() for '$productId' before purchase() — no cached ProductDetails.")
                return@ensureConnected
            }
            // Explicit offer selection — never "whichever is first". The caller
            // names the base plan (and optionally a promotional offer); if that
            // doesn't resolve to exactly one offer we refuse rather than guess.
            val wantedBasePlanId = call.getString("basePlanId")
            val wantedOfferId = call.getString("offerId")
            val candidates = details.subscriptionOfferDetails.orEmpty().filter { offer ->
                (wantedBasePlanId == null || offer.basePlanId == wantedBasePlanId) &&
                    offer.offerId == wantedOfferId
            }
            if (candidates.size != 1) {
                call.reject(
                    "Expected exactly one offer for '$productId' (basePlanId=$wantedBasePlanId, " +
                        "offerId=$wantedOfferId) but found ${candidates.size}. Pass basePlanId/offerId explicitly."
                )
                return@ensureConnected
            }
            val offerToken = candidates[0].offerToken
            val productDetailsParams = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(details)
                .setOfferToken(offerToken)
                .build()
            val flowParams = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(productDetailsParams))
                // Account binding (PHASE 6): ties this specific purchase to
                // the DuoSpace account that launched it. The value is an
                // HMAC computed server-side (get-billing-account-token),
                // never the raw user id or email. verify-google-play-purchase
                // recomputes the same HMAC for whoever is CALLING the verify
                // endpoint and rejects the purchase if it doesn't match what
                // Google reports back — so a stolen/shared purchaseToken
                // can't be claimed by a different account.
                .setObfuscatedAccountId(obfuscatedAccountId)
                .build()

            lastRequestedProductId = productId
            val launchResult = billingClient!!.launchBillingFlow(activity, flowParams)
            val obj = JSObject()
            if (launchResult.responseCode != BillingClient.BillingResponseCode.OK) {
                obj.put("launched", false)
                obj.put("productId", productId)
                obj.put("errorMessage", launchResult.debugMessage)
                call.resolve(obj) // resolve, not reject — this is a real, typed outcome the JS layer branches on
                return@ensureConnected
            }
            obj.put("launched", true)
            obj.put("productId", productId)
            call.resolve(obj)
        }
    }

    @PluginMethod
    fun queryActivePurchases(call: PluginCall) {
        ensureConnected(call) {
            val params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build()
            billingClient!!.queryPurchasesAsync(params) { result, purchases ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    call.reject("queryPurchases failed: ${result.debugMessage}")
                    return@queryPurchasesAsync
                }
                val jsArray = JSArray()
                purchases.forEach { jsArray.put(purchaseToJs(it)) }
                val out = JSObject()
                out.put("purchases", jsArray)
                call.resolve(out)
            }
        }
    }

    @PluginMethod
    fun acknowledgePurchase(call: PluginCall) {
        val token = call.getString("purchaseToken")
        if (token == null) {
            call.reject("purchaseToken is required")
            return
        }
        ensureConnected(call) {
            val params = AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build()
            billingClient!!.acknowledgePurchase(params) { result ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    call.resolve()
                } else {
                    call.reject("acknowledgePurchase failed: ${result.debugMessage}")
                }
            }
        }
    }

    // FIX: previously collapsed Purchase.PurchaseState.UNSPECIFIED_STATE (0)
    // into "pending" alongside the real PENDING state (2) — a mismatch that
    // matters because PENDING purchases can still complete (e.g. a cash
    // payment method finishing later) while UNSPECIFIED_STATE genuinely
    // shouldn't grant anything and shouldn't be confused with "waiting on
    // payment". Now maps each of Billing's three real values explicitly.
    // The recurring (infinite) pricing phase is the steady-state price; earlier
    // phases are free trials / introductory pricing.
    private fun recurringPhase(offer: ProductDetails.SubscriptionOfferDetails): ProductDetails.PricingPhase? =
        offer.pricingPhases.pricingPhaseList.lastOrNull {
            it.recurrenceMode == ProductDetails.RecurrenceMode.INFINITE_RECURRING
        }

    private fun offerToJs(offer: ProductDetails.SubscriptionOfferDetails): JSObject {
        val phases = offer.pricingPhases.pricingPhaseList
        val recurring = recurringPhase(offer)
        val obj = JSObject()
        obj.put("basePlanId", offer.basePlanId)
        obj.put("offerId", offer.offerId) // null for the plain base plan
        obj.put("offerToken", offer.offerToken)
        obj.put("formattedPrice", recurring?.formattedPrice ?: "")
        obj.put("priceCurrencyCode", recurring?.priceCurrencyCode ?: "")
        obj.put("priceAmountMicros", recurring?.priceAmountMicros ?: 0L)
        obj.put("billingPeriod", recurring?.billingPeriod ?: "") // ISO-8601, e.g. P1M
        obj.put("isFreeTrial", phases.any { it.priceAmountMicros == 0L })
        obj.put("isIntroductory", phases.size > 1)
        return obj
    }

    private fun purchaseToJs(purchase: Purchase): JSObject {
        val obj = JSObject()
        obj.put(
            "state",
            when (purchase.purchaseState) {
                Purchase.PurchaseState.PURCHASED -> "purchased"
                Purchase.PurchaseState.PENDING -> "pending"
                else -> "unspecified"
            },
        )
        obj.put("productId", purchase.products.firstOrNull() ?: "")
        obj.put("purchaseToken", purchase.purchaseToken)
        obj.put("orderId", purchase.orderId)
        obj.put("purchaseTimeMillis", purchase.purchaseTime)
        obj.put("isAutoRenewing", purchase.isAutoRenewing)
        obj.put("isAcknowledged", purchase.isAcknowledged)
        // AccountIdentifiers is only populated if setObfuscatedAccountId/
        // ProfileId was used when the purchase was launched — echoed back
        // here for logging/debugging only; the backend re-derives and
        // compares this independently during verification, so this field
        // is never trusted by itself.
        purchase.accountIdentifiers?.obfuscatedAccountId?.let { obj.put("obfuscatedAccountId", it) }
        return obj
    }
}
