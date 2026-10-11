// =========================================================
// Amazon siparişi -> Seltigo kaydı dönüşümleri (amazon-orders işçisi ve testler kullanır)
// =========================================================
import type { AmazonMarket } from "./amazon.ts";

// Amazon sipariş durumu -> marketplace_orders.status (null: henüz işlenmez)
export const STATUS: Record<string, string | null> = {
  Pending: null, // ödeme onayı bekliyor: adres yok, henüz işlenmez (Amazon önerisi)
  Unshipped: "new", PartiallyShipped: "new", InvoiceUnconfirmed: "new",
  Shipped: "shipped", Canceled: "cancelled", Unfulfillable: "cancelled",
};

export function buildOrderRow(conn: any, market: AmazonMarket, o: any, it: any, itemCount: number,
  r: { productId: number | null; variantId: string | null; listingId: string | null }) {
  const a = o.ShippingAddress || {};
  const qty = Math.max(1, Number(it.QuantityOrdered) || 1);
  const extId = itemCount > 1 ? `${o.AmazonOrderId}/${it.OrderItemId}` : o.AmazonOrderId;
  return {
    user_id: conn.user_id, connection_id: conn.id, marketplace_code: conn.marketplace_code, external_order_id: extId,
    listing_id: r.listingId, product_id: r.productId, variant_id: r.variantId, quantity: qty,
    buyer_country: a.CountryCode || market.country, currency: it.ItemPrice?.CurrencyCode || market.currency,
    item_price: it.ItemPrice?.Amount ? Math.round(Number(it.ItemPrice.Amount) / qty * 100) / 100 : null,
    shipping_charged: it.ShippingPrice?.Amount ? Number(it.ShippingPrice.Amount) : null,
    vat_payer: o.IsBusinessOrder ? "seller" : "unknown", status: STATUS[o.OrderStatus] || "new", ordered_at: o.PurchaseDate,
    buyer_name: a.Name || o.BuyerInfo?.BuyerName || null, buyer_phone: a.Phone || null, buyer_email: o.BuyerInfo?.BuyerEmail || null,
    buyer_address: { line1: a.AddressLine1 || "", line2: a.AddressLine2 || "", line3: a.AddressLine3 || "", city: a.City || "", district: a.District || a.County || "",
      state: a.StateOrRegion || "", zip: a.PostalCode || "", country: a.CountryCode || market.country },
    pii_anonymize_after: new Date(Date.now() + 30 * 86400_000).toISOString(), // Amazon veri koruma: kişisel veri en fazla 30 gün
    raw: { order: { ...o, ShippingAddress: undefined, BuyerInfo: undefined }, item: it, sku: it.SellerSKU, orderItemId: it.OrderItemId, amazonOrderId: o.AmazonOrderId },
    source_table: "amazon", source_id: o.AmazonOrderId,
  };
}

export function confirmBody(market: AmazonMarket, mo: any, tracking: string, carrier: string | null) {
  return {
    marketplaceId: market.id,
    packageDetail: {
      packageReferenceId: String(mo.id).replace(/-/g, "").slice(0, 20), carrierCode: "Other", carrierName: carrier || "Other", shippingMethod: "Standard",
      trackingNumber: tracking, shipDate: new Date().toISOString(), orderItems: [{ orderItemId: mo.raw?.orderItemId, quantity: mo.quantity }],
    },
  };
}
