// =========================================================
// Amazon siparişleri ve kargo bildirimi (zamanlanmış, 15 dk; CRON_SECRET)
// 1) Satıcı başına TEK istekle (tüm bağlı pazarlar) son güncellenen siparişleri çeker (Orders API v2026-01-01) -> marketplace_orders
//    - Alıcı adı / adres siparişle gelir; uygulamada kişisel veri izni yoksa adres boş gelir
//    - SKU (SLT-<ürün>[-<seçenek>]) -> Seltigo ürünü / seçeneği; AliExpress / CJ ürünü ise tetikleyici tedarikçi siparişi açar
// 2) Tedarikçi takip numarası gelince (orders.tracking_number) Amazon'a "gönderildi" bildirir (confirmShipment)
// 3) Kabul edilen ilanların ASIN'ini ve Amazon kontrol sonucunu ilana yazar (getListingsItem)
// Sandbox bağlantılarında sipariş çekilmez (statik sandbox gerçek sipariş üretmez; deneme amazon-connect selftest ile).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
import { amazonConfigured, marketByCode, sp, type Ctx } from "../_shared/amazon.ts";
import { feesEstimate } from "../_shared/amazon-listing.ts";
import { confirmShipments, syncSellerOrders } from "../_shared/amazon-orders.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const TIME_BUDGET_MS = 120_000;

// Kabul edilen ilanların durumu (ASIN, Amazon uyarıları)
async function refreshListings(conn: any, cred: any) {
  const market = marketByCode(conn.marketplace_code)!;
  const ctx: Ctx = { region: cred.region || market.region, refreshToken: cred.refresh_token, sandbox: conn.environment === "sandbox",
    simulate: conn.environment === "sandbox" && conn.settings?.simulate === true };
  const { data: ls } = await db.from("listings").select("id, external_listing_id, validation, price").eq("connection_id", conn.id).eq("status", "published").is("deleted_at", null)
    .is("external_url", null).not("external_listing_id", "is", null).limit(20);
  let n = 0;
  for (const l of ls || []) {
    if (!l.validation?.amazon?.accepted) continue;
    try {
      const d = await sp(ctx, "GET", `/listings/2021-08-01/items/${encodeURIComponent(conn.external_seller_id || cred.seller_id)}/${encodeURIComponent(l.external_listing_id)}`, {
        query: { marketplaceIds: market.id, includedData: ["summaries", "issues"], issueLocale: market.locale },
      });
      const s = (d?.summaries || [])[0];
      const issues = (d?.issues || []).map((i: any) => ({ code: String(i.code), field: (i.attributeNames || [])[0], msg: String(i.message), severity: i.severity }));
      const hasError = issues.some((i: any) => i.severity === "ERROR");
      // Gerçek Amazon kesintisi henüz okunmadıysa (ilan yeni kabul edildi): SKU ile sor, ilanın komisyon oranını güncelle
      const fees = !l.validation?.amazon?.fees && Number(l.price) > 0 ? await feesEstimate(ctx, market, { sku: l.external_listing_id }, Number(l.price)) : null;
      // Amazon sonradan itiraz ettiyse: ilan günde en fazla bir kez kuyruğa döner, sync-worker hatayı okuyup düzeltir ve yeniden gönderir
      const lastFix = l.validation?.amazon?.autoFixQueuedAt ? new Date(l.validation.amazon.autoFixQueuedAt).getTime() : 0;
      const requeue = hasError && Date.now() - lastFix > 86400_000;
      const v = { ...(l.validation || {}), amazon: { ...(l.validation?.amazon || {}), asin: s?.asin || null, status: s?.status || null, issues,
        ...(requeue ? { autoFixQueuedAt: new Date().toISOString() } : {}), ...(fees ? { fees } : {}) } };
      await db.from("listings").update({ validation: v, ...(s?.asin ? { external_url: `https://${market.domain}/dp/${s.asin}` } : {}),
        last_sync_error: hasError ? "amazon_issue" : null, ...(fees && fees.pct > 0 ? { commission_pct: fees.pct } : {}) }).eq("id", l.id);
      if (requeue) await db.rpc("enqueue_sync_job", { p_user_id: conn.user_id, p_job_type: "listing_sync", p_listing_id: l.id, p_connection_id: conn.id,
        p_payload: { reason: "amazon_fix" }, p_dedupe_key: "listing:" + l.id, p_priority: 50 });
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
  // Aynı satıcının pazarları (aynı Amazon satıcı no + bölge) birlikte: searchOrders kotası satıcı başına
  const groups = new Map<string, { cred: any; conns: any[] }>();
  const fail = async (c: any, e: unknown) => {
    const msg = short((e as Error).message);
    // Satıcı yetkiyi geri aldıysa (invalid_grant) bağlantı "süresi doldu" olur -> panelde ve asistanda uyarı
    const revoked = /invalid_grant|unauthorized_client|revoked/i.test(msg);
    await db.from("store_connections").update({ last_error: msg, ...(revoked ? { status: "expired" } : {}) }).eq("id", c.id);
    if (revoked) await db.rpc("assistant_enqueue", { p_user: c.user_id, p_kind: "connection", p_payload: { name: "Amazon" }, p_dedupe: "conn:amazon:" + c.id + ":" + new Date().toISOString().slice(0, 10) });
    out.push({ id: c.id, error: msg });
  };
  for (const c of conns || []) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const market = marketByCode(c.marketplace_code);
    if (!market) continue;
    if (!(await featureEnabled(c.user_id, "marketplace_orders"))) { out.push({ id: c.id, skipped: "paket" }); continue; }
    try {
      const { data: cred } = await db.rpc("store_connection_get_credentials", { p_connection_id: c.id });
      if (!cred?.refresh_token) throw new Error("Yenileme anahtarı yok");
      const listings = await refreshListings(c, cred);
      if (c.environment !== "live") { out.push({ id: c.id, listings, orders: "sandbox" }); continue; }
      const key = [c.user_id, c.external_seller_id || cred.seller_id, cred.region || market.region].join("|");
      const g = groups.get(key) || { cred, conns: [] };
      g.conns.push(c);
      groups.set(key, g);
      out.push({ id: c.id, listings });
    } catch (e) { await fail(c, e); }
  }
  for (const { cred, conns: gc } of groups.values()) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const ctx: Ctx = { region: cred.region || marketByCode(gc[0].marketplace_code)!.region, refreshToken: cred.refresh_token, sandbox: false };
    try {
      const r = await syncSellerOrders(db, ctx, gc, started + TIME_BUDGET_MS);
      let shipped = 0;
      for (const c of gc) shipped += await confirmShipments(db, ctx, c);
      if (r.complete) {
        for (const c of gc) await db.from("store_connections").update({ settings: { ...(c.settings || {}), orders_synced_at: r.startedAt }, last_verified_at: new Date().toISOString(), last_error: null }).eq("id", c.id);
      }
      out.push({ seller: gc.map((c) => c.marketplace_code), orders: r.inserted, updated: r.updated, shipped });
    } catch (e) { for (const c of gc) await fail(c, e); }
  }
  return json({ ok: true, ms: Date.now() - started, results: out });
});
