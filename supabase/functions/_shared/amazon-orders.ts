// =========================================================
// Amazon siparişleri (Orders API v2026-01-01) -> Seltigo kaydı; kargo bildirimi (Orders API v0 confirmShipment)
// amazon-orders işçisi ve testler kullanır. Veritabanı istemcisi dışarıdan verilir (testte taklit).
// - v0 sipariş okuma uçları (getOrders / getOrderItems / getOrderAddress ...) kullanımdan kalkıyor (son tarih 27 Mart 2027);
//   v2026-01-01 tek istekte sipariş + kalemler + alıcı / adres + paketleri verir, kişisel veri için ayrı anahtar (RDT) gerekmez.
// - searchOrders kotası satıcı başına çok düşük (0,0056 istek/sn, 20 birikim): aynı satıcının tüm pazarları TEK istekte sorulur.
// - confirmShipment v0'da kalıyor (kullanımdan kalkanlar listesinde değil).
// =========================================================
import { type AmazonMarket, type Ctx, marketByCode, marketById, sp } from "./amazon.ts";

export const ORDERS_PATH = "/orders/2026-01-01/orders";
export const INCLUDED = ["BUYER", "RECIPIENT", "PROCEEDS", "FULFILLMENT", "PACKAGES"];

// Amazon gönderim durumu -> marketplace_orders.status (null: henüz işlenmez)
export const STATUS: Record<string, string | null> = {
  PENDING_AVAILABILITY: null, PENDING: null, // ödeme / stok onayı bekliyor: adres yok, henüz işlenmez (Amazon önerisi)
  UNSHIPPED: "new", PARTIALLY_SHIPPED: "new",
  SHIPPED: "shipped", CANCELLED: "cancelled", UNFULFILLABLE: "cancelled",
};
export const orderStatus = (o: any): string | null | undefined => STATUS[String(o?.fulfillment?.fulfillmentStatus || "")];

const num = (m: any) => (m && m.amount != null && m.amount !== "" ? Number(m.amount) : null);
const breakdown = (it: any, type: string) => num((it?.proceeds?.breakdowns || []).find((b: any) => b.type === type)?.subtotal);

// Siparişin satıcının kendisinin girdiği (ya da Amazon etiketiyle oluşan) paket takip numarası
export function orderTracking(o: any, orderItemId: string): { tracking: string; carrier: string | null } | null {
  for (const p of o?.packages || []) {
    if (!p?.trackingNumber || p?.packageStatus?.status === "CANCELLED") continue;
    const items = p.packageItems || [];
    if (!items.length || items.some((x: any) => x.orderItemId === orderItemId)) return { tracking: String(p.trackingNumber), carrier: p.carrier || null };
  }
  return null;
}

export function buildOrderRow(conn: any, market: AmazonMarket, o: any, it: any, itemCount: number,
  r: { productId: number | null; variantId: string | null; listingId: string | null }) {
  const a = o.recipient?.deliveryAddress || {};
  const qty = Math.max(1, Number(it.quantityOrdered) || 1);
  const extId = itemCount > 1 ? `${o.orderId}/${it.orderItemId}` : o.orderId;
  const unit = num(it.product?.price?.unitPrice);
  const itemTotal = breakdown(it, "ITEM");
  const status = orderStatus(o) || "new";
  const tr = orderTracking(o, it.orderItemId);
  return {
    user_id: conn.user_id, connection_id: conn.id, marketplace_code: conn.marketplace_code, external_order_id: extId,
    listing_id: r.listingId, product_id: r.productId, variant_id: r.variantId, quantity: qty,
    buyer_country: a.countryCode || market.country,
    currency: it.product?.price?.unitPrice?.currencyCode || it.proceeds?.proceedsTotal?.currencyCode || market.currency,
    item_price: unit != null ? unit : itemTotal != null ? Math.round(itemTotal / qty * 100) / 100 : null,
    shipping_charged: breakdown(it, "SHIPPING"),
    vat_payer: (o.programs || []).includes("AMAZON_BUSINESS") ? "seller" : "unknown", status, ordered_at: o.createdTime,
    buyer_name: a.name || o.buyer?.buyerName || null, buyer_phone: a.phone || null, buyer_email: o.buyer?.buyerEmail || null,
    buyer_address: { line1: a.addressLine1 || "", line2: a.addressLine2 || "", line3: a.addressLine3 || "", city: a.city || a.municipality || "",
      district: a.districtOrCounty || "", state: a.stateOrRegion || "", zip: a.postalCode || "", country: a.countryCode || market.country },
    ...(status === "shipped" && tr ? { tracking_number: tr.tracking, carrier: tr.carrier, tracking_pushed_at: new Date().toISOString() } : {}),
    pii_anonymize_after: new Date(Date.now() + 30 * 86400_000).toISOString(), // Amazon veri koruma: kişisel veri en fazla 30 gün
    raw: { order: { ...o, buyer: undefined, recipient: undefined, orderItems: undefined }, item: it, sku: it.product?.sellerSku,
      orderItemId: it.orderItemId, amazonOrderId: o.orderId, shipBy: o.fulfillment?.shipByWindow?.latestDateTime || null },
    source_table: "amazon", source_id: o.orderId,
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

// SKU -> ürün / seçenek (Seltigo SKU'su SLT-<ürün no>[-<seçenek sırası>])
export async function resolveSku(db: any, userId: string, code: string, sku: string) {
  const m = /^SLT-(\d+)(?:-(\d+))?$/.exec(sku || "");
  if (!m) return { productId: null, variantId: null, listingId: null };
  const productId = Number(m[1]);
  const { data: l } = await db.from("listings").select("id, validation").eq("user_id", userId).eq("marketplace_code", code).eq("product_id", productId)
    .is("deleted_at", null).limit(1).maybeSingle();
  const entry = (l?.validation?.amazon?.skus || []).find((s: any) => s.sku === sku);
  return { productId, variantId: entry?.variantId || null, listingId: l?.id || null };
}

// Aynı satıcının (aynı yenileme anahtarı) bağlı pazarlarının siparişleri: tek searchOrders, sayfa sayfa.
// conns: o satıcının marketplace_code'ları farklı bağlantıları. Dönüş: eklenen kayıt sayısı + tamamlandı mı.
export async function syncSellerOrders(db: any, ctx: Ctx, conns: any[], deadline: number): Promise<{ inserted: number; updated: number; complete: boolean; startedAt: string }> {
  const byMarket = new Map<string, any>();
  for (const c of conns) {
    const m = marketByCode(c.marketplace_code);
    if (m) byMarket.set(m.id, c);
  }
  const startedAt = new Date(Date.now() - 2 * 60_000).toISOString(); // Amazon: zaman en az 2 dk önce olmalı
  const since = conns.map((c) => c.settings?.orders_synced_at).filter(Boolean).sort()[0] || new Date(Date.now() - 7 * 86400_000).toISOString();
  let token: string | undefined, inserted = 0, updated = 0;
  do {
    const d = await sp(ctx, "GET", ORDERS_PATH, {
      query: token ? { paginationToken: token } : {
        lastUpdatedAfter: since, marketplaceIds: [...byMarket.keys()], fulfilledBy: ["MERCHANT"], includedData: INCLUDED, maxResultsPerPage: "100",
      },
    });
    token = d?.pagination?.nextToken || undefined;
    for (const o of d?.orders || []) {
      const conn = byMarket.get(o.salesChannel?.marketplaceId);
      const market = conn && marketById(o.salesChannel.marketplaceId);
      if (!conn || !market) continue;
      if (o.fulfillment?.fulfilledBy === "AMAZON") continue; // FBA: gönderimi Amazon yapar
      const status = orderStatus(o);
      if (status === null || status === undefined) continue;
      const items: any[] = o.orderItems || [];
      for (const it of items) {
        const extId = items.length > 1 ? `${o.orderId}/${it.orderItemId}` : o.orderId;
        const { data: ex } = await db.from("marketplace_orders").select("id, status, tracking_number").eq("user_id", conn.user_id)
          .eq("marketplace_code", conn.marketplace_code).eq("external_order_id", extId).maybeSingle();
        if (ex) {
          if (ex.status !== status && !(ex.status === "shipped" && status === "new")) {
            const tr = status === "shipped" && !ex.tracking_number ? orderTracking(o, it.orderItemId) : null;
            await db.from("marketplace_orders").update({ status, ...(status === "cancelled" ? { cancelled_at: new Date().toISOString() } : {}),
              ...(status === "shipped" ? { shipped_at: new Date().toISOString() } : {}),
              ...(tr ? { tracking_number: tr.tracking, carrier: tr.carrier, tracking_pushed_at: new Date().toISOString() } : {}) }).eq("id", ex.id);
            updated++;
          }
          continue;
        }
        const r = await resolveSku(db, conn.user_id, conn.marketplace_code, it.product?.sellerSku);
        await db.from("marketplace_orders").insert(buildOrderRow(conn, market, o, it, items.length, r));
        inserted++;
      }
    }
  } while (token && Date.now() < deadline);
  return { inserted, updated, complete: !token, startedAt };
}
// Tedarikçi / Seltigo kargo takip numarasını Amazon'a bildir (confirmShipment)
export async function confirmShipments(db: any, ctx: Ctx, conn: any): Promise<number> {
  const market = marketByCode(conn.marketplace_code)!;
  const { data: open } = await db.from("marketplace_orders").select("id, external_order_id, quantity, raw, tracking_number, carrier")
    .eq("connection_id", conn.id).in("status", ["new", "awaiting_supplier", "ordered_from_supplier"]).is("tracking_pushed_at", null).limit(50);
  let n = 0;
  for (const mo of open || []) {
    let tracking = mo.tracking_number, carrier = mo.carrier;
    const amazonOrderId = mo.raw?.amazonOrderId || String(mo.external_order_id).split("/")[0];
    if (!tracking) {
      const { data: so } = await db.from("orders").select("tracking_number, tracking_carrier").eq("user_id", conn.user_id).eq("platform", conn.marketplace_code)
        .eq("marketplace_order_no", amazonOrderId).not("tracking_number", "is", null).limit(1).maybeSingle();
      if (!so) continue;
      tracking = so.tracking_number; carrier = so.tracking_carrier;
    }
    try {
      await sp(ctx, "POST", `/orders/v0/orders/${encodeURIComponent(amazonOrderId)}/shipmentConfirmation`, { body: confirmBody(market, mo, tracking, carrier) });
      const now = new Date().toISOString();
      await db.from("marketplace_orders").update({ tracking_number: tracking, carrier, tracking_pushed_at: now, status: "shipped", shipped_at: now }).eq("id", mo.id);
      n++;
    } catch (e) {
      await db.from("marketplace_orders").update({ raw: { ...(mo.raw || {}), confirm_error: String((e as Error).message).slice(0, 300) } }).eq("id", mo.id);
    }
  }
  return n;
}
