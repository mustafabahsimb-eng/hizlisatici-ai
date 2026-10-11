// =========================================================
// Amazon siparişleri ve kargo bildirimi (zamanlanmış, 15 dk; CRON_SECRET)
// 1) Bağlı her Amazon pazarından son güncellenen siparişleri çeker (Orders API v0) -> marketplace_orders
//    - Alıcı adı / adres için kısıtlı veri anahtarı (RDT); uygulamada kişisel veri izni yoksa adres boş gelir
//    - SKU (SLT-<ürün>[-<seçenek>]) -> Seltigo ürünü / seçeneği; AliExpress / CJ ürünü ise tetikleyici tedarikçi siparişi açar
// 2) Tedarikçi takip numarası gelince (orders.tracking_number) Amazon'a "gönderildi" bildirir (confirmShipment)
// 3) Kabul edilen ilanların ASIN'ini ve Amazon kontrol sonucunu ilana yazar (getListingsItem)
// Sandbox bağlantılarında sipariş çekilmez (statik sandbox gerçek sipariş üretmez; deneme amazon-connect selftest ile).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
import { amazonConfigured, marketByCode, restrictedToken, sp, type Ctx } from "../_shared/amazon.ts";
import { buildOrderRow, confirmBody, STATUS } from "../_shared/amazon-orders.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const TIME_BUDGET_MS = 120_000;

// SKU -> ürün / seçenek (Seltigo SKU'su SLT-<ürün no>[-<seçenek sırası>])
async function resolveSku(userId: string, code: string, sku: string) {
  const m = /^SLT-(\d+)(?:-(\d+))?$/.exec(sku || "");
  if (!m) return { productId: null, variantId: null, listingId: null };
  const productId = Number(m[1]);
  const { data: l } = await db.from("listings").select("id, validation").eq("user_id", userId).eq("marketplace_code", code).eq("product_id", productId).is("deleted_at", null).limit(1).maybeSingle();
  const entry = (l?.validation?.amazon?.skus || []).find((s: any) => s.sku === sku);
  return { productId, variantId: entry?.variantId || null, listingId: l?.id || null };
}

async function syncOrders(conn: any, cred: any, deadline: number) {
  const market = marketByCode(conn.marketplace_code)!;
  const ctx: Ctx = { region: cred.region || market.region, refreshToken: cred.refresh_token, sandbox: false };
  const since = conn.settings?.orders_synced_at || new Date(Date.now() - 7 * 86400_000).toISOString();
  const startedAt = new Date(Date.now() - 2 * 60_000).toISOString(); // Amazon: LastUpdatedAfter en az 2 dk önce olmalı
  const rdt = await restrictedToken(ctx, [{ method: "GET", path: "/orders/v0/orders", dataElements: ["buyerInfo", "shippingAddress"] }]);
  let next: string | undefined, n = 0;
  do {
    const d = await sp({ ...ctx, rdt: rdt || undefined }, "GET", "/orders/v0/orders", {
      query: next ? { MarketplaceIds: [market.id], NextToken: next } : { MarketplaceIds: [market.id], LastUpdatedAfter: since, FulfillmentChannels: ["MFN"] },
    });
    next = d?.payload?.NextToken;
    for (const o of d?.payload?.Orders || []) {
      const status = STATUS[o.OrderStatus];
      if (status === null || status === undefined) continue;
      const items = (await sp(ctx, "GET", `/orders/v0/orders/${encodeURIComponent(o.AmazonOrderId)}/orderItems`))?.payload?.OrderItems || [];
      for (const it of items) {
        const extId = items.length > 1 ? `${o.AmazonOrderId}/${it.OrderItemId}` : o.AmazonOrderId;
        const { data: ex } = await db.from("marketplace_orders").select("id, status").eq("user_id", conn.user_id).eq("marketplace_code", conn.marketplace_code).eq("external_order_id", extId).maybeSingle();
        if (ex) {
          if (ex.status !== status && !(ex.status === "shipped" && status === "new")) await db.from("marketplace_orders").update({ status, ...(status === "cancelled" ? { cancelled_at: new Date().toISOString() } : {}) }).eq("id", ex.id);
          continue;
        }
        const r = await resolveSku(conn.user_id, conn.marketplace_code, it.SellerSKU);
        await db.from("marketplace_orders").insert(buildOrderRow(conn, market, o, it, items.length, r));
        n++;
      }
    }
  } while (next && Date.now() < deadline);
  if (!next) await db.from("store_connections").update({ settings: { ...(conn.settings || {}), orders_synced_at: startedAt }, last_verified_at: new Date().toISOString(), last_error: null }).eq("id", conn.id);
  return n;
}

// Tedarikçi takip numarasını Amazon'a bildir
async function confirmShipments(conn: any, cred: any) {
  const market = marketByCode(conn.marketplace_code)!;
  const ctx: Ctx = { region: cred.region || market.region, refreshToken: cred.refresh_token, sandbox: false };
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
      await db.from("marketplace_orders").update({ tracking_number: tracking, carrier, tracking_pushed_at: new Date().toISOString(), status: "shipped", shipped_at: new Date().toISOString() }).eq("id", mo.id);
      n++;
    } catch (e) {
      await db.from("marketplace_orders").update({ raw: { ...(mo.raw || {}), confirm_error: short((e as Error).message) } }).eq("id", mo.id);
    }
  }
  return n;
}

// Kabul edilen ilanların durumu (ASIN, Amazon uyarıları)
async function refreshListings(conn: any, cred: any) {
  const market = marketByCode(conn.marketplace_code)!;
  const ctx: Ctx = { region: cred.region || market.region, refreshToken: cred.refresh_token, sandbox: conn.environment === "sandbox" };
  const { data: ls } = await db.from("listings").select("id, external_listing_id, validation").eq("connection_id", conn.id).eq("status", "published").is("deleted_at", null)
    .is("external_url", null).not("external_listing_id", "is", null).limit(20);
  let n = 0;
  for (const l of ls || []) {
    if (!l.validation?.amazon?.accepted) continue;
    try {
      const d = await sp(ctx, "GET", `/listings/2021-08-01/items/${encodeURIComponent(conn.external_seller_id || cred.seller_id)}/${encodeURIComponent(l.external_listing_id)}`, {
        query: { marketplaceIds: market.id, includedData: ["summaries", "issues"], issueLocale: market.locale },
      });
      const s = (d?.summaries || [])[0];
      const issues = (d?.issues || []).map((i: any) => ({ code: String(i.code), msg: String(i.message), severity: i.severity }));
      const v = { ...(l.validation || {}), amazon: { ...(l.validation?.amazon || {}), asin: s?.asin || null, status: s?.status || null, issues } };
      await db.from("listings").update({ validation: v, ...(s?.asin ? { external_url: `https://${market.domain}/dp/${s.asin}` } : {}),
        last_sync_error: issues.some((i: any) => i.severity === "ERROR") ? "amazon_issue" : null }).eq("id", l.id);
      n++;
    } catch (_) { /* sonraki turda */ }
  }
  return n;
}

Deno.serve(async (req) => {
  const b = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(b?.cronSecret || "").trim() !== CRON_SECRET.trim()) return json({ error: "unauthorized" }, 401);
  if (!amazonConfigured()) return json({ ok: true, skipped: "Amazon uygulaması tanımlı değil (AMAZON_* secrets)" });
  const started = Date.now();
  const { data: conns } = await db.from("store_connections").select("id, user_id, marketplace_code, environment, external_seller_id, settings, status")
    .like("marketplace_code", "amazon_%").eq("status", "connected").is("deleted_at", null);
  const out: unknown[] = [];
  for (const c of conns || []) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    if (!marketByCode(c.marketplace_code)) continue;
    if (!(await featureEnabled(c.user_id, "marketplace_orders"))) { out.push({ id: c.id, skipped: "paket" }); continue; }
    try {
      const { data: cred } = await db.rpc("store_connection_get_credentials", { p_connection_id: c.id });
      if (!cred?.refresh_token) throw new Error("Yenileme anahtarı yok");
      const listings = await refreshListings(c, cred);
      if (c.environment !== "live") { out.push({ id: c.id, listings, orders: "sandbox" }); continue; }
      const orders = await syncOrders(c, cred, started + TIME_BUDGET_MS);
      const shipped = await confirmShipments(c, cred);
      out.push({ id: c.id, market: c.marketplace_code, orders, shipped, listings });
    } catch (e) {
      const msg = short((e as Error).message);
      // Satıcı yetkiyi geri aldıysa (invalid_grant) bağlantı "süresi doldu" olur -> panelde ve asistanda uyarı
      const revoked = /invalid_grant|unauthorized_client|revoked/i.test(msg);
      await db.from("store_connections").update({ last_error: msg, ...(revoked ? { status: "expired" } : {}) }).eq("id", c.id);
      if (revoked) await db.rpc("assistant_enqueue", { p_user: c.user_id, p_kind: "connection", p_payload: { name: "Amazon" }, p_dedupe: "conn:amazon:" + c.id + ":" + new Date().toISOString().slice(0, 10) });
      out.push({ id: c.id, error: msg });
    }
  }
  return json({ ok: true, ms: Date.now() - started, results: out });
});
