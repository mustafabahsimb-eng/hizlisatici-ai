// =========================================================
// Pazaryeri siparişlerini çekme (zamanlanmış, 15 dk; CRON_SECRET) — Amazon hariç (amazon-orders)
// Trendyol, Hepsiburada, n11, Çiçeksepeti, Pazarama, Shopify, WooCommerce, Etsy, eBay, Walmart, Wix
// 1) Bağlı her mağazadan son değişen siparişler -> marketplace_orders (satır başına bir kayıt; varsa durum / takip güncellenir)
//    Ürün eşleme: barkod / stok kodu / SKU -> Seltigo ürünü ve seçeneği
//    Tetikleyiciler: AliExpress / CJ ürünü -> tedarikçi siparişi; kendi gönderdiği ürün + kargoyu pazaryeri ayarlamıyorsa -> gönderi/etiket; asistana bildirim
// 2) Satıcının / tedarikçinin takip numarası -> pazaryerine "gönderildi" (destekleyenlerde: Shopify, WooCommerce, Etsy, eBay, Walmart, Wix)
// Sistem: { cronSecret } | { cronSecret, connectionId } (tek bağlantı) | { cronSecret, test: { code, env, creds, sellerId, since } } (okuyucu denemesi, kayıt yok)
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { adapterFor, HttpError, type NormLine } from "../_shared/marketplace-orders.ts";
import { featureEnabled } from "../_shared/features.ts";
import { etsyToken } from "../_shared/etsy.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const TIME_BUDGET_MS = 120_000;

// Pazaryeri ürün kodu -> Seltigo ürünü / seçeneği
async function resolveProduct(userId: string, code: string, l: NormLine, cache: Map<string, any>) {
  const key = `${l.barcode || ""}|${l.sku || ""}`;
  if (cache.has(key)) return cache.get(key);
  let r: any = { productId: null, variantId: null, listingId: null };
  const sku = String(l.sku || "").trim(), bc = String(l.barcode || "").trim();
  const m = /^(?:SLT|HS)-(\d+)(?:-(\d+))?$/.exec(sku);
  if (m) r.productId = Number(m[1]);
  if (!r.productId && (bc || sku)) {
    const ors = [bc && `gtin.eq.${bc}`, sku && `sku.eq.${sku}`, sku && `supplier_sku.eq.${sku}`].filter(Boolean).join(",");
    const { data: v } = await db.from("product_variants").select("id, product_id").eq("user_id", userId).is("deleted_at", null).or(ors).limit(1).maybeSingle();
    if (v) { r.productId = v.product_id; r.variantId = v.id; }
  }
  if (!r.productId && (bc || sku)) {
    const ors = [bc && `gtin.eq.${bc}`, sku && `model_code.eq.${sku}`, sku && `supplier_sku_attr.eq.${sku}`].filter(Boolean).join(",");
    const { data: p } = await db.from("products").select("id").eq("user_id", userId).is("deleted_at", null).or(ors).limit(1).maybeSingle();
    if (p) r.productId = p.id;
  }
  if (r.productId) {
    const { data: li } = await db.from("listings").select("id").eq("user_id", userId).eq("marketplace_code", code).eq("product_id", r.productId).is("deleted_at", null).limit(1).maybeSingle();
    r.listingId = li?.id || null;
  }
  cache.set(key, r);
  return r;
}

async function syncConnection(c: any, deadline: number) {
  const ad = adapterFor(c.marketplace_code);
  if (!ad) return { skipped: "okuyucu yok" };
  let { data: creds } = await db.rpc("store_connection_get_credentials", { p_connection_id: c.id });
  if (!creds) throw new Error("Bağlantı bilgileri yok");
  // Etsy erişim anahtarı 1 saatte biter: süresi dolmuşsa önce yenilenir (yoksa 401 alınıp bağlantı yanlışlıkla "süresi doldu"ya düşer)
  if (c.marketplace_code === "etsy") creds = (await etsyToken(db, c.id)).cred;
  const startedAt = new Date();
  const since = c.settings?.orders_synced_at ? new Date(new Date(c.settings.orders_synced_at).getTime() - 10 * 60_000) : new Date(Date.now() - 7 * 86400_000);
  const ctx = { code: c.marketplace_code, env: c.environment === "sandbox" ? "sandbox" as const : "live" as const, creds, sellerId: c.external_seller_id, since, until: startedAt };
  const lines = await ad.fetchOrders(ctx);
  const cache = new Map<string, any>();
  let inserted = 0, updated = 0;
  for (const l of lines) {
    if (Date.now() > deadline) break;
    const { data: ex } = await db.from("marketplace_orders").select("id, status, tracking_number").eq("user_id", c.user_id).eq("marketplace_code", c.marketplace_code).eq("external_order_id", l.externalId).maybeSingle();
    if (ex) {
      const patch: Record<string, unknown> = {};
      if (ex.status !== l.status && !(["shipped", "delivered"].includes(ex.status) && l.status === "new")) {
        patch.status = l.status;
        if (l.status === "cancelled") patch.cancelled_at = new Date().toISOString();
        if (l.status === "delivered") patch.delivered_at = new Date().toISOString();
        if (l.status === "shipped") patch.shipped_at = new Date().toISOString();
      }
      if (l.tracking && l.tracking !== ex.tracking_number) { patch.tracking_number = l.tracking; patch.carrier = l.carrier; }
      if (Object.keys(patch).length) { await db.from("marketplace_orders").update(patch).eq("id", ex.id); updated++; }
      continue;
    }
    if (l.status === "cancelled") continue; // hiç görmediğimiz iptal siparişi kaydetmeye gerek yok
    const r = await resolveProduct(c.user_id, c.marketplace_code, l, cache);
    const { error } = await db.from("marketplace_orders").insert({
      user_id: c.user_id, connection_id: c.id, marketplace_code: c.marketplace_code, external_order_id: l.externalId,
      listing_id: r.listingId, product_id: r.productId, variant_id: r.variantId, quantity: Math.max(1, l.quantity),
      buyer_country: (l.address.country || "TR").slice(0, 2).toUpperCase(), currency: (l.currency || "TRY").slice(0, 3).toUpperCase(), item_price: l.unitPrice,
      vat_payer: "unknown", status: l.status, ordered_at: l.orderedAt, buyer_name: l.buyerName, buyer_phone: l.phone, buyer_email: l.email,
      buyer_address: { line1: l.address.line1 || "", line2: l.address.line2 || "", city: l.address.city || "", district: l.address.district || "", state: l.address.state || "", zip: l.address.zip || "", country: l.address.country || "" },
      tracking_number: l.tracking || null, carrier: l.carrier || null,
      pii_anonymize_after: new Date(Date.now() + 90 * 86400_000).toISOString(),
      raw: { ...(l.raw as object || {}), sku: l.sku, barcode: l.barcode, productName: l.productName, orderNo: l.orderNo, lineRef: l.lineRef, marketplaceShips: !!l.marketplaceShips },
      source_table: c.marketplace_code, source_id: l.orderNo,
    });
    if (!error) inserted++;
  }
  await db.from("store_connections").update({ settings: { ...(c.settings || {}), orders_synced_at: startedAt.toISOString() }, last_verified_at: new Date().toISOString(), last_error: null }).eq("id", c.id);
  // Takip numarasını pazaryerine bildir (satıcı kendi gönderiyorsa)
  let pushed = 0;
  if (ad.pushTracking) {
    const { data: open } = await db.from("marketplace_orders").select("id, external_order_id, quantity, raw, tracking_number, carrier, product_id")
      .eq("connection_id", c.id).in("status", ["new", "awaiting_supplier", "ordered_from_supplier"]).is("tracking_pushed_at", null).limit(50);
    for (const mo of open || []) {
      if (Date.now() > deadline) break;
      let tracking = mo.tracking_number, carrier = mo.carrier;
      if (!tracking) {
        const { data: so } = await db.from("orders").select("tracking_number, tracking_carrier").eq("user_id", c.user_id).eq("platform", c.marketplace_code)
          .eq("marketplace_order_no", mo.external_order_id).not("tracking_number", "is", null).limit(1).maybeSingle();
        if (!so) continue;
        tracking = so.tracking_number; carrier = so.tracking_carrier;
      }
      try {
        await ad.pushTracking(ctx, mo, tracking, carrier);
        await db.from("marketplace_orders").update({ tracking_number: tracking, carrier, tracking_pushed_at: new Date().toISOString(), status: "shipped", shipped_at: new Date().toISOString() }).eq("id", mo.id);
        pushed++;
      } catch (e) {
        await db.from("marketplace_orders").update({ raw: { ...(mo.raw || {}), push_error: short((e as Error).message) } }).eq("id", mo.id);
      }
    }
  }
  return { lines: lines.length, inserted, updated, pushed };
}

Deno.serve(async (req) => {
  const b = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(b?.cronSecret || "").trim() !== CRON_SECRET.trim()) return json({ error: "unauthorized" }, 401);
  // Okuyucu denemesi (kayıt yapmaz): verilen bilgilerle pazaryerinden okur, ilk satırları döndürür
  if (b.test?.code) {
    const ad = adapterFor(String(b.test.code));
    if (!ad) return json({ ok: false, error: "okuyucu yok" });
    try {
      const lines = await ad.fetchOrders({ code: b.test.code, env: b.test.env === "sandbox" ? "sandbox" : "live", creds: b.test.creds || {}, sellerId: b.test.sellerId, since: new Date(b.test.since || Date.now() - 86400_000), until: new Date() });
      return json({ ok: true, count: lines.length, sample: lines.slice(0, 3) });
    } catch (e) { return json({ ok: false, error: short((e as Error).message), status: (e as any).status }); }
  }
  const started = Date.now();
  let q = db.from("store_connections").select("id, user_id, marketplace_code, environment, external_seller_id, settings, status").eq("status", "connected").is("deleted_at", null)
    .neq("marketplace_code", "own_store").not("marketplace_code", "like", "amazon_%");
  if (b.connectionId) q = q.eq("id", String(b.connectionId));
  const { data: conns } = await q;
  const out: unknown[] = [];
  for (const c of conns || []) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    if (!adapterFor(c.marketplace_code)) continue;
    if (!(await featureEnabled(c.user_id, "marketplace_orders"))) { out.push({ id: c.id, skipped: "paket" }); continue; }
    try {
      out.push({ id: c.id, code: c.marketplace_code, ...(await syncConnection(c, started + TIME_BUDGET_MS)) });
    } catch (e) {
      const msg = short((e as Error).message);
      const status = (e as HttpError).status;
      const authFail = status === 401; // 403 çoğunlukla IP izni (Trendyol stage) -> bağlantıyı düşürme
      await db.from("store_connections").update({ last_error: msg, ...(authFail ? { status: "expired" } : {}) }).eq("id", c.id);
      if (authFail) await db.rpc("assistant_enqueue", { p_user: c.user_id, p_kind: "connection", p_payload: { name: c.marketplace_code }, p_dedupe: "conn:" + c.id + ":" + new Date().toISOString().slice(0, 10) });
      out.push({ id: c.id, code: c.marketplace_code, error: msg });
    }
  }
  return json({ ok: true, ms: Date.now() - started, results: out });
});
