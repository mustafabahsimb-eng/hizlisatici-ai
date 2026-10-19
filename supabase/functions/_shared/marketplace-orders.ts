// =========================================================
// Pazaryeri siparişlerini çekme — ortak okuyucular (Amazon ayrı: amazon-orders)
// Her okuyucu siparişleri tek biçime çevirir (NormLine: sipariş satırı başına bir kayıt).
// Ortam: bağlantı environment = 'sandbox' ise pazaryerinin test/stage adresi (varsa) kullanılır.
// Kaynaklar:
//   Trendyol  : developers.trendyol.com getShipmentPackages v2 (/v2/orders; v1 15 Ekim 2026'da kapanıyor), Basic auth + User-Agent "<sellerId> - SelfIntegration", stage: stageapigw
//   N11       : developer.n11.com Sipariş Listeleme (GET /rest/delivery/v1/shipmentPackages, appKey/appSecret başlıkları, ms tarih, 15 gün pencere)
//   Hepsiburada: OMS (oms-external[-sit].hepsiburada.com /orders/merchantid/{id}), Basic auth — resmi belge bu ağdan erişilemedi; alanlar esnek okunur
//   Çiçeksepeti: apis.ciceksepeti.com /api/v1/Order/GetOrders (x-api-key) — alanlar esnek okunur (satıcı belgesiyle doğrulanacak)
//   Pazarama  : isortagimapi.pazarama.com /order/getOrdersForApi (client_credentials token) — alanlar esnek okunur
//   Trendruum : _shared/trendruum.ts (Client ID + Secret -> JWT; webhook yok, düzenli çekme); takip: kendi kargosuyla gönderilen pakete takip no. TRENDRUUM_ENABLED olmadan çalışmaz
//   Shopify   : Admin REST /orders.json (X-Shopify-Access-Token); takip: fulfillment_orders + fulfillments
//   WooCommerce: /wp-json/wc/v3/orders (Basic ck:cs); takip: sipariş notu + durum completed
//   Etsy      : /v3/application/shops/{shop}/receipts; takip: createReceiptShipment
//   eBay      : Sell Fulfillment /sell/fulfillment/v1/order; takip: shipping_fulfillment (sandbox: api.sandbox.ebay.com)
//   Walmart   : /v3/orders (WM_SEC.ACCESS_TOKEN; sandbox.walmartapis.com); takip: /v3/orders/{po}/shipping
//   Wix       : eCommerce /ecom/v1/orders/search; takip: fulfillments
// =========================================================
import { etsyApiKey } from "./etsy.ts";
import { credsFromVault, fetchTrendruumOrders, pushTrendruumTracking, trendruumEnabled } from "./trendruum.ts";

export type NormLine = {
  externalId: string;            // satır bazında benzersiz (sipariş no [+ satır no])
  orderNo: string;               // pazaryeri sipariş / paket numarası (takip bildirimi için)
  lineRef?: string | null;       // pazaryeri satır kimliği
  orderedAt: string;             // ISO
  status: "new" | "shipped" | "delivered" | "cancelled" | "returned";
  currency: string;
  unitPrice: number | null;
  quantity: number;
  sku?: string | null;
  barcode?: string | null;
  productName?: string | null;
  buyerName?: string | null;
  phone?: string | null;
  email?: string | null;
  address: { line1: string; line2?: string; city?: string; district?: string; state?: string; zip?: string; country?: string };
  tracking?: string | null;
  carrier?: string | null;
  marketplaceShips?: boolean;    // kargoyu pazaryeri ayarlıyor (Trendyol, Hepsiburada, n11 ...)
  raw?: unknown;
};
export type Ctx = { code: string; env: "live" | "sandbox"; creds: any; sellerId?: string | null; since: Date; until: Date; fetch?: typeof fetch };
export type Adapter = {
  fetchOrders(ctx: Ctx): Promise<NormLine[]>;
  pushTracking?(ctx: Ctx, mo: any, tracking: string, carrier: string | null): Promise<void>;
};

const num = (v: unknown) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();
const pick = (o: any, ...keys: string[]) => { for (const k of keys) { const v = k.split(".").reduce((a: any, p) => (a == null ? a : a[p]), o); if (v !== undefined && v !== null && v !== "") return v; } return null; };
const iso = (v: unknown) => { if (v == null || v === "") return new Date().toISOString(); const n = Number(v); const d = Number.isFinite(n) && n > 1e9 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v)); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); };
export function statusOf(s: unknown): NormLine["status"] {
  const x = str(s).toLowerCase();
  if (/(cancel|iptal|unsupplied|refused|voided)/.test(x)) return "cancelled";
  if (/(return|iade|undelivered|refund)/.test(x)) return "returned";
  if (/(deliver|teslim|completed$)/.test(x)) return "delivered";
  if (/(ship|transit|kargo|atcollectionpoint|fulfilled|in_transit)/.test(x)) return "shipped";
  return "new";
}
class HttpError extends Error { status: number; constructor(s: number, m: string) { super(m); this.status = s; } }
async function http(ctx: Ctx, url: string, init: RequestInit = {}, tries = 3): Promise<any> {
  const f = ctx.fetch || fetch;
  for (let i = 0; ; i++) {
    const r = await f(url, { ...init, signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : {}; } catch { /* düz metin */ }
    if (r.ok) return body;
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await new Promise((res) => setTimeout(res, 800 * 2 ** i)); continue; }
    throw new HttpError(r.status, `${ctx.code} ${r.status}: ${String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 200)}`);
  }
}
const basic = (a: string, b: string) => "Basic " + btoa(`${a}:${b}`);
function windows(since: Date, until: Date, days: number): [Date, Date][] {
  const out: [Date, Date][] = [];
  let a = since.getTime();
  const end = until.getTime();
  while (a < end) { const b = Math.min(end, a + days * 86400_000); out.push([new Date(a), new Date(b)]); a = b; }
  return out;
}
const fmtHB = (d: Date) => { const t = new Date(d.getTime() + 3 * 3600_000).toISOString(); return t.slice(0, 10) + " " + t.slice(11, 16); }; // yyyy-MM-dd HH:mm (TR saati)

// ---------------- Trendyol ----------------
const trendyol: Adapter = {
  async fetchOrders(ctx) {
    const { sellerId, apiKey, apiSecret } = ctx.creds;
    const host = ctx.env === "sandbox" ? "https://stageapigw.trendyol.com" : "https://apigw.trendyol.com";
    const out: NormLine[] = [];
    for (const [a, b] of windows(ctx.since, ctx.until, 14)) {
      for (let page = 0; page < 50; page++) {
        const q = new URLSearchParams({ startDate: String(a.getTime()), endDate: String(b.getTime()), page: String(page), size: "200", orderByField: "PackageLastModifiedDate", orderByDirection: "ASC" });
        const d = await http(ctx, `${host}/integration/order/sellers/${encodeURIComponent(sellerId)}/v2/orders?${q}`, {
          headers: { Authorization: basic(apiKey, apiSecret), "User-Agent": `${sellerId} - SelfIntegration`, storeFrontCode: "TR" },
        });
        for (const p of d?.content || []) {
          const ad = p.shipmentAddress || {};
          for (const l of p.lines || []) {
            out.push({
              externalId: `${p.shipmentPackageId || p.id}/${l.lineId || l.id}`, orderNo: String(p.shipmentPackageId || p.id), lineRef: String(l.lineId || l.id),
              orderedAt: iso(p.orderDate), status: statusOf(l.orderLineItemStatusName || p.status || p.shipmentPackageStatus),
              currency: l.currencyCode || p.currencyCode || "TRY", unitPrice: num(l.lineUnitPrice ?? l.price ?? l.amount), quantity: Number(l.quantity) || 1,
              sku: str(l.merchantSku || l.stockCode) || null, barcode: str(l.barcode) || null, productName: l.productName || null,
              buyerName: ad.fullName || [ad.firstName, ad.lastName].filter(Boolean).join(" ") || [p.customerFirstName, p.customerLastName].filter(Boolean).join(" ") || null,
              phone: ad.phone || null, email: p.customerEmail || null,
              address: { line1: str(ad.address1 || ad.fullAddress), line2: str(ad.address2), city: ad.city, district: ad.district, zip: ad.postalCode, country: ad.countryCode || "TR" },
              tracking: p.cargoTrackingNumber != null ? String(p.cargoTrackingNumber) : null, carrier: p.cargoProviderName || null, marketplaceShips: true,
              raw: { orderNumber: p.orderNumber, packageId: p.shipmentPackageId || p.id, lineId: l.lineId || l.id },
            });
          }
        }
        if (page + 1 >= Number(d?.totalPages || 1)) break;
      }
    }
    return out;
  },
};

// ---------------- N11 ----------------
const n11: Adapter = {
  async fetchOrders(ctx) {
    const { apiKey, apiSecret } = ctx.creds;
    const out: NormLine[] = [];
    for (const [a, b] of windows(ctx.since, ctx.until, 14)) {
      for (let page = 0; page < 50; page++) {
        const q = new URLSearchParams({ startDate: String(a.getTime()), endDate: String(b.getTime()), page: String(page), size: "100", orderByField: "true", orderByDirection: "ASC" });
        const d = await http(ctx, `https://api.n11.com/rest/delivery/v1/shipmentPackages?${q}`, { headers: { appKey: apiKey, appSecret: apiSecret } });
        for (const p of d?.content || []) {
          const ad = p.shippingAddress || {};
          for (const l of p.lines || []) {
            out.push({
              externalId: `${p.id}/${l.orderLineId}`, orderNo: String(p.id), lineRef: String(l.orderLineId),
              orderedAt: iso(p.packageHistories?.[0]?.createdDate || p.lastModifiedDate), status: statusOf(l.orderItemLineItemStatusName || p.shipmentPackageStatus),
              currency: "TRY", unitPrice: num(l.price), quantity: Number(l.quantity) || 1, sku: str(l.stockCode) || null, barcode: str(l.barcode) || null, productName: l.productName || null,
              buyerName: ad.fullName || p.customerfullName || null, phone: ad.gsm || ad.phone || null, email: p.customerEmail || null,
              address: { line1: str(ad.address || ad.fullAddress), city: ad.city, district: ad.district, zip: ad.postalCode, country: "TR" },
              tracking: p.cargoTrackingNumber ? String(p.cargoTrackingNumber) : null, carrier: p.cargoProviderName || null, marketplaceShips: true,
              raw: { orderNumber: p.orderNumber, packageId: p.id, lineId: l.orderLineId },
            });
          }
        }
        if (page + 1 >= Number(d?.totalPages || 1)) break;
      }
    }
    return out;
  },
};

// ---------------- Hepsiburada (OMS) ----------------
const hepsiburada: Adapter = {
  async fetchOrders(ctx) {
    const { sellerId, apiKey, apiSecret } = ctx.creds;
    const host = ctx.env === "sandbox" ? "https://oms-external-sit.hepsiburada.com" : "https://oms-external.hepsiburada.com";
    const out: NormLine[] = [];
    for (let offset = 0; offset < 5000; offset += 50) {
      const q = new URLSearchParams({ offset: String(offset), limit: "50", begindate: fmtHB(ctx.since), enddate: fmtHB(ctx.until) });
      const d = await http(ctx, `${host}/orders/merchantid/${encodeURIComponent(sellerId)}?${q}`, {
        headers: { Authorization: basic(apiKey, apiSecret), "User-Agent": `${sellerId} - Seltigo`, Accept: "application/json" },
      });
      const items: any[] = Array.isArray(d) ? d : (d?.items || d?.data || []);
      for (const it of items) {
        const ad = pick(it, "shippingAddress", "deliveryAddress") || {};
        const lines: any[] = Array.isArray(it.items) ? it.items : [it];
        for (const l of lines) {
          const orderNo = str(pick(it, "orderNumber", "orderId", "id"));
          const lineId = str(pick(l, "lineItemId", "id", "orderLineId"));
          out.push({
            externalId: `${orderNo}/${lineId}`, orderNo, lineRef: lineId, orderedAt: iso(pick(it, "orderDate", "createdDate")),
            status: statusOf(pick(l, "status", "orderLineStatus") || pick(it, "status")),
            currency: str(pick(l, "totalPrice.currency", "unitPrice.currency", "price.currency")) || "TRY",
            unitPrice: num(pick(l, "unitPrice.amount", "price.amount", "unitPrice")) ?? (num(pick(l, "totalPrice.amount", "totalPrice")) != null ? Number(pick(l, "totalPrice.amount", "totalPrice")) / (Number(l.quantity) || 1) : null),
            quantity: Number(pick(l, "quantity")) || 1, sku: str(pick(l, "merchantSku", "merchantSKU", "sku")) || null, barcode: str(pick(l, "barcode", "hbSku")) || null,
            productName: pick(l, "productName", "name"), buyerName: pick(ad, "name", "fullName") || pick(it, "customerName", "recipientName"),
            phone: pick(ad, "phoneNumber", "phone") || pick(it, "phoneNumber"), email: pick(ad, "email") || pick(it, "email"),
            address: { line1: str(pick(ad, "address", "addressDetail") || pick(it, "shippingAddressDetail")), city: pick(ad, "city") || pick(it, "shippingCity"), district: pick(ad, "town", "district") || pick(it, "shippingTown"), zip: pick(ad, "postalCode"), country: pick(ad, "countryCode") || "TR" },
            tracking: str(pick(l, "cargoTrackingNumber", "trackingInfoCode") || pick(it, "barcode", "cargoTrackingNumber")) || null, carrier: pick(l, "cargoCompany") || pick(it, "cargoCompany"), marketplaceShips: true,
            raw: { orderNumber: orderNo, lineId },
          });
        }
      }
      const total = Number(d?.totalCount ?? items.length);
      if (!items.length || offset + 50 >= total) break;
    }
    return out;
  },
};

// ---------------- Çiçeksepeti ----------------
const ciceksepeti: Adapter = {
  async fetchOrders(ctx) {
    const { apiKey } = ctx.creds;
    const host = ctx.env === "sandbox" ? "https://sandbox-apis.ciceksepeti.com" : "https://apis.ciceksepeti.com";
    const out: NormLine[] = [];
    for (const [a, b] of windows(ctx.since, ctx.until, 7)) {
      for (let page = 0; page < 50; page++) {
        const d = await http(ctx, `${host}/api/v1/Order/GetOrders`, {
          method: "POST", headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ startDate: a.toISOString(), endDate: b.toISOString(), pageSize: 100, page }),
        });
        const list: any[] = d?.supplierOrderListWithBranch || d?.orders || d?.data || [];
        for (const o of list) {
          const orderNo = str(pick(o, "orderId", "orderNumber"));
          const lineId = str(pick(o, "orderItemId", "orderProductId")) || "1";
          const qty = Number(pick(o, "quantity")) || 1;
          out.push({
            externalId: `${orderNo}/${lineId}`, orderNo, lineRef: lineId, orderedAt: iso(pick(o, "orderCreateDate", "orderDate")),
            status: statusOf(pick(o, "orderItemStatus", "orderProductStatus", "status")), currency: "TRY",
            unitPrice: num(pick(o, "itemPrice", "unitPrice")) ?? (num(pick(o, "totalPrice")) != null ? Number(pick(o, "totalPrice")) / qty : null), quantity: qty,
            sku: str(pick(o, "code", "productCode", "stockCode")) || null, barcode: str(pick(o, "barcode")) || null, productName: pick(o, "name", "productName"),
            buyerName: pick(o, "receiverName", "customerName"), phone: pick(o, "receiverPhone", "customerPhone"), email: pick(o, "customerEmail"),
            address: { line1: str(pick(o, "receiverAddress", "deliveryAddress")), city: pick(o, "receiverCity", "city"), district: pick(o, "receiverDistrict", "district"), country: "TR" },
            tracking: str(pick(o, "cargoNumber", "cargoTrackingNumber")) || null, carrier: pick(o, "cargoCompany"), marketplaceShips: true,
            raw: { orderNumber: orderNo, lineId },
          });
        }
        const pages = Number(d?.pageCount ?? d?.totalPages ?? 1);
        if (!list.length || page + 1 >= pages) break;
      }
    }
    return out;
  },
};

// ---------------- Pazarama ----------------
const pazaramaToken = new Map<string, { t: string; exp: number }>();
const pazarama: Adapter = {
  async fetchOrders(ctx) {
    const { apiKey, apiSecret } = ctx.creds;
    let tok = pazaramaToken.get(apiKey);
    if (!tok || tok.exp < Date.now()) {
      const t = await http(ctx, "https://isortagimgiris.pazarama.com/connect/token", {
        method: "POST", headers: { Authorization: basic(apiKey, apiSecret), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: "merchantgatewayapi.fullaccess" }).toString(),
      });
      tok = { t: t?.data?.accessToken || t?.access_token, exp: Date.now() + 50 * 60_000 };
      pazaramaToken.set(apiKey, tok);
    }
    const out: NormLine[] = [];
    for (const [a, b] of windows(ctx.since, ctx.until, 7)) {
      const d = await http(ctx, "https://isortagimapi.pazarama.com/order/getOrdersForApi", {
        method: "POST", headers: { Authorization: `Bearer ${tok.t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: a.toISOString().slice(0, 10), endDate: b.toISOString().slice(0, 10) }),
      });
      for (const o of d?.data || []) {
        const ad = pick(o, "shipmentAddress", "deliveryAddress") || {};
        for (const l of o.items || o.orderItems || []) {
          const orderNo = str(pick(o, "orderNumber", "orderId"));
          const lineId = str(pick(l, "orderItemId", "id"));
          out.push({
            externalId: `${orderNo}/${lineId}`, orderNo, lineRef: lineId, orderedAt: iso(pick(o, "orderDate")),
            status: statusOf(pick(l, "orderItemStatusName", "orderItemStatus") || pick(o, "orderStatus")), currency: "TRY",
            unitPrice: num(pick(l, "salePrice.value", "listPrice.value", "price")), quantity: Number(pick(l, "quantity")) || 1,
            sku: str(pick(l, "product.stockCode", "stockCode", "code")) || null, barcode: str(pick(l, "product.barcode", "barcode")) || null, productName: pick(l, "product.name", "productName"),
            buyerName: pick(ad, "nameSurname", "fullName") || pick(o, "customerName"), phone: pick(ad, "phoneNumber"), email: pick(o, "customerEmail"),
            address: { line1: str(pick(ad, "addressDetail", "address")), city: pick(ad, "cityName", "city"), district: pick(ad, "districtName", "district"), country: "TR" },
            tracking: str(pick(l, "cargo.trackingNumber", "trackingNumber")) || null, carrier: pick(l, "cargo.companyName", "cargoCompany"), marketplaceShips: true,
            raw: { orderNumber: orderNo, lineId },
          });
        }
      }
    }
    return out;
  },
};

// ---------------- Trendruum ----------------
const trCtx = (ctx: Ctx) => ({ creds: credsFromVault(ctx.creds), env: ctx.env, fetch: ctx.fetch });
const trendruum: Adapter = {
  async fetchOrders(ctx) {
    if (!trendruumEnabled()) return [];
    const lines = await fetchTrendruumOrders(trCtx(ctx), ctx.since, ctx.until);
    return lines.map((l) => ({ ...l, status: statusOf(l.status), sku: str(l.sku) || null, barcode: str(l.barcode) || null, address: { ...l.address, line1: str(l.address.line1), line2: str(l.address.line2) } }));
  },
  async pushTracking(ctx, mo, tracking, carrier) {
    if (!trendruumEnabled()) throw new Error("trendruum_disabled");
    if (mo.raw?.marketplaceShips) return; // Trendruum Kargo ile giden pakette takip numarası zaten Trendruum'da
    await pushTrendruumTracking(trCtx(ctx), String(mo.raw?.packageId || mo.raw?.orderNo || ""), tracking, carrier);
  },
};

// ---------------- Shopify ----------------
const shopify: Adapter = {
  async fetchOrders(ctx) {
    const { access_token, shop_domain } = ctx.creds;
    const out: NormLine[] = [];
    let url: string | null = `https://${shop_domain}/admin/api/2024-10/orders.json?status=any&limit=250&updated_at_min=${encodeURIComponent(ctx.since.toISOString())}`;
    for (let i = 0; url && i < 40; i++) {
      const f = ctx.fetch || fetch;
      const r = await f(url, { headers: { "X-Shopify-Access-Token": access_token, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new HttpError(r.status, `shopify ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = await r.json();
      for (const o of d?.orders || []) {
        const ad = o.shipping_address || o.billing_address || {};
        const status: NormLine["status"] = o.cancelled_at ? "cancelled" : o.fulfillment_status === "fulfilled" ? "shipped" : o.financial_status === "refunded" ? "returned" : "new";
        if (o.financial_status && !["paid", "partially_paid", "partially_refunded", "refunded"].includes(o.financial_status) && status === "new") continue; // ödenmemiş
        for (const l of o.line_items || []) {
          out.push({
            externalId: `${o.id}/${l.id}`, orderNo: String(o.id), lineRef: String(l.id), orderedAt: iso(o.created_at), status,
            currency: o.currency || "USD", unitPrice: num(l.price), quantity: Number(l.quantity) || 1, sku: l.sku || null, barcode: null,
            productName: [l.title, l.variant_title].filter(Boolean).join(" - "), buyerName: ad.name || [ad.first_name, ad.last_name].filter(Boolean).join(" ") || null,
            phone: ad.phone || o.phone || null, email: o.email || null,
            address: { line1: str(ad.address1), line2: str(ad.address2), city: ad.city, state: ad.province, zip: ad.zip, country: ad.country_code },
            tracking: o.fulfillments?.[0]?.tracking_number || null, carrier: o.fulfillments?.[0]?.tracking_company || null,
            raw: { orderNumber: o.name, orderId: o.id, lineId: l.id },
          });
        }
      }
      const link = r.headers.get("link") || "";
      url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] || null;
    }
    return out;
  },
  async pushTracking(ctx, mo, tracking, carrier) {
    const { access_token, shop_domain } = ctx.creds;
    const h = { "X-Shopify-Access-Token": access_token, "Content-Type": "application/json" };
    const fo = await http(ctx, `https://${shop_domain}/admin/api/2024-10/orders/${mo.raw?.orderId}/fulfillment_orders.json`, { headers: h });
    const open = (fo?.fulfillment_orders || []).filter((x: any) => ["open", "in_progress"].includes(x.status));
    if (!open.length) return;
    await http(ctx, `https://${shop_domain}/admin/api/2024-10/fulfillments.json`, {
      method: "POST", headers: h,
      body: JSON.stringify({ fulfillment: { line_items_by_fulfillment_order: open.map((x: any) => ({ fulfillment_order_id: x.id })), tracking_info: { number: tracking, company: carrier || "Other" }, notify_customer: true } }),
    });
  },
};

// ---------------- WooCommerce ----------------
const woocommerce: Adapter = {
  async fetchOrders(ctx) {
    const { sellerId: storeUrl, apiKey, apiSecret } = ctx.creds;
    const base = String(storeUrl).replace(/\/+$/, "");
    const out: NormLine[] = [];
    for (let page = 1; page <= 40; page++) {
      const q = new URLSearchParams({ per_page: "100", page: String(page), modified_after: ctx.since.toISOString().slice(0, 19), orderby: "modified", order: "asc" });
      const d = await http(ctx, `${base}/wp-json/wc/v3/orders?${q}`, { headers: { Authorization: basic(apiKey, apiSecret) } });
      const list: any[] = Array.isArray(d) ? d : [];
      for (const o of list) {
        if (["pending", "failed", "checkout-draft"].includes(o.status)) continue; // ödenmemiş
        const ad = o.shipping?.address_1 ? o.shipping : o.billing || {};
        const status: NormLine["status"] = o.status === "cancelled" ? "cancelled" : o.status === "refunded" ? "returned" : o.status === "completed" ? "shipped" : "new";
        for (const l of o.line_items || []) {
          out.push({
            externalId: `${o.id}/${l.id}`, orderNo: String(o.id), lineRef: String(l.id), orderedAt: iso(o.date_created_gmt ? o.date_created_gmt + "Z" : o.date_created), status,
            currency: o.currency || "TRY", unitPrice: num(l.price), quantity: Number(l.quantity) || 1, sku: l.sku || null, barcode: null, productName: l.name || null,
            buyerName: [ad.first_name, ad.last_name].filter(Boolean).join(" ") || null, phone: o.billing?.phone || ad.phone || null, email: o.billing?.email || null,
            address: { line1: str(ad.address_1), line2: str(ad.address_2), city: ad.city, state: ad.state, zip: ad.postcode, country: ad.country },
            raw: { orderNumber: o.number, orderId: o.id, lineId: l.id },
          });
        }
      }
      if (list.length < 100) break;
    }
    return out;
  },
  async pushTracking(ctx, mo, tracking, carrier) {
    const { sellerId: storeUrl, apiKey, apiSecret } = ctx.creds;
    const base = String(storeUrl).replace(/\/+$/, "");
    const h = { Authorization: basic(apiKey, apiSecret), "Content-Type": "application/json" };
    await http(ctx, `${base}/wp-json/wc/v3/orders/${mo.raw?.orderId}/notes`, { method: "POST", headers: h, body: JSON.stringify({ note: `Kargo: ${carrier || ""} ${tracking}`.trim(), customer_note: true }) });
    await http(ctx, `${base}/wp-json/wc/v3/orders/${mo.raw?.orderId}`, { method: "PUT", headers: h, body: JSON.stringify({ status: "completed" }) });
  },
};

// ---------------- Etsy ----------------
// x-api-key "<keystring>:<shared secret>" (Etsy 2026 kuralı)
const ETSY_KEY = () => etsyApiKey();
const etsy: Adapter = {
  async fetchOrders(ctx) {
    const shop = ctx.creds.shop_id || ctx.sellerId;
    const out: NormLine[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const q = new URLSearchParams({ limit: "100", offset: String(offset), min_last_modified: String(Math.floor(ctx.since.getTime() / 1000)), was_paid: "true" });
      const d = await http(ctx, `https://api.etsy.com/v3/application/shops/${shop}/receipts?${q}`, { headers: { "x-api-key": ETSY_KEY(), Authorization: `Bearer ${ctx.creds.access_token}` } });
      for (const r of d?.results || []) {
        const status: NormLine["status"] = /cancel/i.test(r.status) ? "cancelled" : r.is_shipped ? "shipped" : /refund/i.test(r.status) ? "returned" : "new";
        for (const t of r.transactions || []) {
          const price = t.price ? Number(t.price.amount) / Number(t.price.divisor || 100) : null;
          out.push({
            externalId: `${r.receipt_id}/${t.transaction_id}`, orderNo: String(r.receipt_id), lineRef: String(t.transaction_id), orderedAt: iso(r.create_timestamp || r.created_timestamp), status,
            currency: t.price?.currency_code || "USD", unitPrice: price, quantity: Number(t.quantity) || 1, sku: t.sku || null, barcode: null, productName: t.title || null,
            buyerName: r.name || null, phone: null, email: r.buyer_email || null,
            address: { line1: str(r.first_line), line2: str(r.second_line), city: r.city, state: r.state, zip: r.zip, country: r.country_iso },
            raw: { orderNumber: r.receipt_id, receiptId: r.receipt_id, lineId: t.transaction_id },
          });
        }
      }
      if ((d?.results || []).length < 100) break;
    }
    return out;
  },
  async pushTracking(ctx, mo, tracking, carrier) {
    const shop = ctx.creds.shop_id || ctx.sellerId;
    await http(ctx, `https://api.etsy.com/v3/application/shops/${shop}/receipts/${mo.raw?.receiptId}/tracking`, {
      method: "POST", headers: { "x-api-key": ETSY_KEY(), Authorization: `Bearer ${ctx.creds.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tracking_code: tracking, carrier_name: carrier || "other" }),
    });
  },
};

// ---------------- eBay ----------------
const ebayHost = (ctx: Ctx) => (ctx.env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com");
const ebay: Adapter = {
  async fetchOrders(ctx) {
    const out: NormLine[] = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const q = new URLSearchParams({ limit: "200", offset: String(offset), filter: `lastmodifieddate:[${ctx.since.toISOString()}..]` });
      const d = await http(ctx, `${ebayHost(ctx)}/sell/fulfillment/v1/order?${q}`, { headers: { Authorization: `Bearer ${ctx.creds.access_token}`, Accept: "application/json" } });
      for (const o of d?.orders || []) {
        if (o.orderPaymentStatus && !["PAID", "PARTIALLY_REFUNDED", "FULLY_REFUNDED"].includes(o.orderPaymentStatus)) continue;
        const st = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
        const ca = st.contactAddress || {};
        const status: NormLine["status"] = o.cancelStatus?.cancelState === "CANCELED" ? "cancelled" : o.orderPaymentStatus === "FULLY_REFUNDED" ? "returned" : o.orderFulfillmentStatus === "FULFILLED" ? "shipped" : "new";
        for (const l of o.lineItems || []) {
          out.push({
            externalId: `${o.orderId}/${l.lineItemId}`, orderNo: String(o.orderId), lineRef: String(l.lineItemId), orderedAt: iso(o.creationDate), status,
            currency: l.lineItemCost?.currency || o.pricingSummary?.total?.currency || "USD",
            unitPrice: l.lineItemCost?.value != null ? Number(l.lineItemCost.value) / (Number(l.quantity) || 1) : null, quantity: Number(l.quantity) || 1,
            sku: l.sku || null, barcode: null, productName: l.title || null, buyerName: st.fullName || o.buyer?.username || null,
            phone: st.primaryPhone?.phoneNumber || null, email: st.email || null,
            address: { line1: str(ca.addressLine1), line2: str(ca.addressLine2), city: ca.city, state: ca.stateOrProvince, zip: ca.postalCode, country: ca.countryCode },
            raw: { orderNumber: o.orderId, orderId: o.orderId, lineId: l.lineItemId },
          });
        }
      }
      if ((d?.orders || []).length < 200) break;
    }
    return out;
  },
  async pushTracking(ctx, mo, tracking, carrier) {
    await http(ctx, `${ebayHost(ctx)}/sell/fulfillment/v1/order/${encodeURIComponent(mo.raw?.orderId)}/shipping_fulfillment`, {
      method: "POST", headers: { Authorization: `Bearer ${ctx.creds.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lineItems: [{ lineItemId: String(mo.raw?.lineId), quantity: mo.quantity }], shippedDate: new Date().toISOString(), shippingCarrierCode: carrier || "Other", trackingNumber: tracking }),
    });
  },
};

// ---------------- Walmart ----------------
const walmartToken = new Map<string, { t: string; exp: number }>();
const wmHost = (ctx: Ctx) => (ctx.env === "sandbox" ? "https://sandbox.walmartapis.com" : "https://marketplace.walmartapis.com");
async function wmHeaders(ctx: Ctx) {
  const { apiKey, apiSecret } = ctx.creds;
  let tok = walmartToken.get(apiKey);
  if (!tok || tok.exp < Date.now()) {
    const t = await http(ctx, `${wmHost(ctx)}/v3/token`, {
      method: "POST", headers: { Authorization: basic(apiKey, apiSecret), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "WM_QOS.CORRELATION_ID": crypto.randomUUID(), "WM_SVC.NAME": "Walmart Marketplace" },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });
    tok = { t: t.access_token, exp: Date.now() + (Number(t.expires_in || 900) - 60) * 1000 };
    walmartToken.set(apiKey, tok);
  }
  return { "WM_SEC.ACCESS_TOKEN": tok.t, "WM_QOS.CORRELATION_ID": crypto.randomUUID(), "WM_SVC.NAME": "Walmart Marketplace", Accept: "application/json", "Content-Type": "application/json" };
}
const walmart: Adapter = {
  async fetchOrders(ctx) {
    const out: NormLine[] = [];
    let url: string | null = `${wmHost(ctx)}/v3/orders?limit=200&lastModifiedStartDate=${encodeURIComponent(ctx.since.toISOString())}`;
    for (let i = 0; url && i < 40; i++) {
      const d = await http(ctx, url, { headers: await wmHeaders(ctx) });
      const list = d?.list?.elements?.order || [];
      for (const o of list) {
        const pa = o.shippingInfo?.postalAddress || {};
        for (const l of o.orderLines?.orderLine || []) {
          const charge = (l.charges?.charge || []).find((c: any) => c.chargeType === "PRODUCT") || l.charges?.charge?.[0];
          const qty = Number(l.orderLineQuantity?.amount) || 1;
          const st = l.orderLineStatuses?.orderLineStatus?.[0]?.status;
          out.push({
            externalId: `${o.purchaseOrderId}/${l.lineNumber}`, orderNo: String(o.purchaseOrderId), lineRef: String(l.lineNumber), orderedAt: iso(o.orderDate), status: statusOf(st),
            currency: charge?.chargeAmount?.currency || "USD", unitPrice: charge?.chargeAmount?.amount != null ? Number(charge.chargeAmount.amount) / qty : null, quantity: qty,
            sku: l.item?.sku || null, barcode: null, productName: l.item?.productName || null, buyerName: pa.name || null, phone: o.shippingInfo?.phone || null, email: o.customerEmailId || null,
            address: { line1: str(pa.address1), line2: str(pa.address2), city: pa.city, state: pa.state, zip: pa.postalCode, country: pa.country },
            raw: { orderNumber: o.customerOrderId, purchaseOrderId: o.purchaseOrderId, lineId: l.lineNumber },
          });
        }
      }
      const next = d?.list?.meta?.nextCursor;
      url = next ? `${wmHost(ctx)}/v3/orders${next}` : null;
    }
    return out;
  },
  async pushTracking(ctx, mo, tracking, carrier) {
    await http(ctx, `${wmHost(ctx)}/v3/orders/${mo.raw?.purchaseOrderId}/shipping`, {
      method: "POST", headers: await wmHeaders(ctx),
      body: JSON.stringify({ orderShipment: { orderLines: { orderLine: [{ lineNumber: String(mo.raw?.lineId), sellerOrderId: String(mo.raw?.purchaseOrderId),
        orderLineStatuses: { orderLineStatus: [{ status: "Shipped", statusQuantity: { unitOfMeasurement: "EACH", amount: String(mo.quantity) },
          trackingInfo: { shipDateTime: Date.now(), carrierName: { otherCarrier: carrier || "Other" }, methodCode: "Standard", trackingNumber: tracking } }] } }] } } }),
    });
  },
};

// ---------------- Wix ----------------
const wix: Adapter = {
  async fetchOrders(ctx) {
    const out: NormLine[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 40; i++) {
      const body: any = { search: { cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) } } };
      if (!cursor) body.search.filter = { updatedDate: { $gte: ctx.since.toISOString() }, paymentStatus: { $in: ["PAID", "PARTIALLY_REFUNDED", "FULLY_REFUNDED"] } };
      const d = await http(ctx, "https://www.wixapis.com/ecom/v1/orders/search", { method: "POST", headers: { Authorization: ctx.creds.access_token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      for (const o of d?.orders || []) {
        const dest = o.shippingInfo?.logistics?.shippingDestination || o.recipientInfo || {};
        const ad = dest.address || {};
        const cd = dest.contactDetails || {};
        const status: NormLine["status"] = o.status === "CANCELED" ? "cancelled" : o.paymentStatus === "FULLY_REFUNDED" ? "returned" : o.fulfillmentStatus === "FULFILLED" ? "shipped" : "new";
        for (const l of o.lineItems || []) {
          out.push({
            externalId: `${o.id}/${l.id}`, orderNo: String(o.id), lineRef: String(l.id), orderedAt: iso(o.createdDate), status, currency: o.currency || "USD",
            unitPrice: num(l.price?.amount), quantity: Number(l.quantity) || 1, sku: l.physicalProperties?.sku || null, barcode: null, productName: l.productName?.original || null,
            buyerName: [cd.firstName, cd.lastName].filter(Boolean).join(" ") || null, phone: cd.phone || null, email: o.buyerInfo?.email || null,
            address: { line1: str(ad.addressLine || ad.addressLine1), line2: str(ad.addressLine2), city: ad.city, state: ad.subdivision, zip: ad.postalCode, country: ad.country },
            raw: { orderNumber: o.number, orderId: o.id, lineId: l.id },
          });
        }
      }
      cursor = d?.metadata?.cursors?.next || null;
      if (!cursor) break;
    }
    return out;
  },
  async pushTracking(ctx, mo, tracking, carrier) {
    await http(ctx, `https://www.wixapis.com/ecom/v1/fulfillments/orders/${mo.raw?.orderId}/create-fulfillment`, {
      method: "POST", headers: { Authorization: ctx.creds.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ fulfillment: { lineItems: [{ id: String(mo.raw?.lineId), quantity: mo.quantity }], trackingInfo: { trackingNumber: tracking, shippingProvider: carrier || "other" } } }),
    });
  },
};

// marketplaces.code -> okuyucu (eBay ülkeleri aynı API)
export function adapterFor(code: string): Adapter | null {
  if (code === "trendyol_tr") return trendyol;
  if (code === "n11_tr") return n11;
  if (code === "hepsiburada_tr") return hepsiburada;
  if (code === "ciceksepeti_tr") return ciceksepeti;
  if (code === "pazarama_tr") return pazarama;
  if (code === "trendruum_tr") return trendruum;
  if (code === "shopify") return shopify;
  if (code === "woocommerce") return woocommerce;
  if (code === "etsy") return etsy;
  if (code.startsWith("ebay_")) return ebay;
  if (code.startsWith("walmart_")) return walmart;
  if (code === "wix") return wix;
  return null;
}
export const SUPPORTED_NOTE: Record<string, string> = {
  pttavm_tr: "PTT AVM sipariş servisinin belgesi satıcı panelinde; hesapla doğrulanınca eklenecek",
};
export { HttpError };
