// =========================================================
// Etsy senkronu — bağlı Etsy mağazasındaki TÜM ilanlar Seltigo ürün listesine (Printify'dan / Etsy panelinden eklenenler dahil)
//  - Saatte bir (cron) tüm satıcılar; Etsy bağlanınca hemen (etsy-token-exchange); Printify'da ürün yayınlanınca / değişince hemen (webhook)
//  - Eşleştirme: listings.external_listing_id (ya da validation.etsy.listing_id). Aynı ilan iki kez eklenmez.
//  - Yeni (Seltigo dışı) aktif ilan -> products + listings (attributes.managed_by = 'printify' | 'etsy'; Seltigo bu ilanı Etsy'ye geri yazmaz)
//  - Etsy'de artık olmayan ilan -> validation.etsy.state = 'removed' (panelde "Etsy'de yok")
//  - Printify ürünü: maliyet Printify API'den (ilan fiyatındaki varyantın ürün maliyeti + ABD ilk ürün kargosu), mağaza para birimine çevrilir;
//    Etsy kesintileri: commission_rate %9,5 (işlem %6,5 + ödeme %3) + fixed_fee 0,45 $ (ilan 0,20 + ödeme 0,25). Panel gerçek net kârı gösterir.
// Sistem (CRON_SECRET): { cronSecret } (tüm satıcılar) | { cronSecret, userId } | { cronSecret, action: "printify_webhooks", userId } (webhook kaydı)
// Printify webhook: POST ?t=<PRINTIFY_WEBHOOK_TOKEN> (gövde: { type, resource: { id, data: { shop_id } } })
// Paket anahtarı: etsy_sync
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { convertPrice, etsy, etsyShopCurrency, etsyToken } from "../_shared/etsy.ts";
import { featureEnabled } from "../_shared/features.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const WEBHOOK_TOKEN = Deno.env.get("PRINTIFY_WEBHOOK_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const ETSY_PCT = 9.5, ETSY_FIXED_USD = 0.45;
const STATES = ["active", "inactive", "draft", "expired", "sold_out"];
const decode = (s: string) => String(s || "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// ---------------- Printify ----------------
async function pf(token: string, path: string) {
  for (let i = 0; ; i++) {
    const r = await fetch("https://api.printify.com/v1" + path, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Seltigo" }, signal: AbortSignal.timeout(60000) });
    if (r.ok) return await r.json();
    if ((r.status === 429 || r.status >= 500) && i < 3) { await new Promise((x) => setTimeout(x, 1500 * 2 ** i)); continue; }
    throw new Error(`Printify ${r.status}`);
  }
}
// Satıcının Printify anahtarları: mağazaya özel secret (PRINTIFY_TOKEN_<shopId>) + Seltigo'daki Printify bağlantısı
async function printifyTokens(userId: string): Promise<string[]> {
  const out = new Set<string>();
  const { data: pods } = await db.from("pod_products").select("provider_shop_id").eq("user_id", userId).eq("provider", "printify");
  for (const p of pods || []) { const t = Deno.env.get(`PRINTIFY_TOKEN_${p.provider_shop_id}`); if (t) out.add(t.trim()); }
  const { data: conn } = await db.from("printify_connections").select("api_token").eq("user_id", userId).maybeSingle();
  if (conn?.api_token) out.add(String(conn.api_token).trim());
  return [...out];
}
type PfInfo = { productId: string; shopId: string; costUsd: number; shipUsd: number; blueprint: number; provider: number };
// Etsy ilan no -> Printify ürünü (ilan fiyatındaki en ucuz etkin varyantın maliyeti + ABD ilk ürün kargosu)
async function printifyMap(userId: string): Promise<Map<string, PfInfo>> {
  const map = new Map<string, PfInfo>(); const shipCache = new Map<string, Map<number, number>>();
  for (const token of await printifyTokens(userId)) {
    let shops: any[] = [];
    try { shops = await pf(token, "/shops.json"); } catch { continue; }
    for (const s of shops.filter((x: any) => String(x.sales_channel).toLowerCase() === "etsy")) {
      for (let page = 1; page <= 20; page++) {
        const d = await pf(token, `/shops/${s.id}/products.json?limit=50&page=${page}`);
        for (const p of d.data || []) {
          const ext = p.external?.id ? String(p.external.id) : null;
          if (!ext) continue;
          const vs = (p.variants || []).filter((v: any) => v.is_enabled);
          if (!vs.length) continue;
          const v = vs.reduce((a: any, b: any) => (b.price < a.price || (b.price === a.price && b.cost > a.cost) ? b : a));
          const key = `${p.blueprint_id}:${p.print_provider_id}`;
          if (!shipCache.has(key)) {
            const m = new Map<number, number>();
            try {
              const sh = await pf(token, `/catalog/blueprints/${p.blueprint_id}/print_providers/${p.print_provider_id}/shipping.json`);
              for (const prof of sh.profiles || []) if ((prof.countries || []).includes("US")) for (const id of prof.variant_ids || []) m.set(Number(id), Number(prof.first_item?.cost || 0) / 100);
            } catch { /* kargo bilinmiyor */ }
            shipCache.set(key, m);
          }
          map.set(ext, { productId: String(p.id), shopId: String(s.id), costUsd: Number(v.cost) / 100, shipUsd: shipCache.get(key)!.get(Number(v.id)) ?? 0, blueprint: p.blueprint_id, provider: p.print_provider_id });
        }
        if (page >= (d.last_page || 1)) break;
      }
    }
  }
  return map;
}

// ---------------- Etsy ----------------
async function shopListings(ctx: any, shopId: string) {
  const all = new Map<string, any>();
  for (const state of STATES) {
    for (let offset = 0; offset < 5000; offset += 100) {
      const d = await etsy(ctx, "GET", `/shops/${shopId}/listings`, { query: { state, limit: "100", offset: String(offset), ...(state === "active" ? { includes: "Images" } : {}) } });
      for (const l of d.results || []) all.set(String(l.listing_id), l);
      if ((d.results || []).length < 100) break;
    }
  }
  return all;
}

async function syncConnection(conn: any) {
  const userId = conn.user_id; const now = new Date().toISOString();
  const { token, cred } = await etsyToken(db, conn.id); const ctx = { token };
  const shopId = String(cred.shop_id || conn.external_seller_id);
  const cur = await etsyShopCurrency(ctx, shopId, cred);
  const etsyAll = await shopListings(ctx, shopId);
  const pfMap = await printifyMap(userId).catch(() => new Map<string, PfInfo>());
  const usdTo = async (v: number) => (await convertPrice(db, v, "USD", cur)) ?? null;
  const fixedFee = await usdTo(ETSY_FIXED_USD);
  // Seltigo'daki Etsy ilanları
  const { data: mine } = await db.from("listings").select("id, product_id, external_listing_id, validation, attributes, status").eq("user_id", userId).eq("marketplace_code", "etsy").is("deleted_at", null);
  const byExt = new Map<string, any>();
  for (const l of mine || []) { const e = String(l.external_listing_id || l.validation?.etsy?.listing_id || ""); if (e) byExt.set(e, l); }
  const stats = { etsy: etsyAll.size, created: 0, updated: 0, removed: 0, printify: 0 };
  // 1) Etsy'deki ilanlar
  for (const [ext, l] of etsyAll) {
    const price = Number(l.price?.amount || 0) / (Number(l.price?.divisor) || 100);
    const pfi = pfMap.get(ext);
    const managed = pfi ? "printify" : "etsy";
    const img = (l.images || []).sort((a: any, b: any) => a.rank - b.rank)[0]?.url_fullxfull || null;
    const ex = byExt.get(ext);
    // Ürün maliyeti / kesintiler (Printify ürünü: gerçek maliyet; Etsy ürünü: kesintiler)
    const prodCost: Record<string, unknown> = { commission_rate: ETSY_PCT, fixed_fee: fixedFee, cost_currency: cur };
    if (pfi) {
      const c = await usdTo(pfi.costUsd + pfi.shipUsd);
      Object.assign(prodCost, { supplier: "printify", supplier_item_id: pfi.productId, supplier_price: c != null ? Math.round(c * 100) / 100 : null, supplier_cost: c != null ? Math.round(c * 100) / 100 : null });
      stats.printify++;
    }
    const etsyState = { listing_id: ext, state: l.state, url: l.url, synced_at: now };
    if (ex) {
      const extManaged = ex.attributes?.managed_by;
      // Dışarıda yönetilen ilan: içerik + fiyat Etsy'den güncellenir. Seltigo'nun kendi ilanında yalnız durum yazılır (içeriğe dokunulmaz).
      const lp: Record<string, unknown> = { validation: { ...(ex.validation || {}), etsy: { ...(ex.validation?.etsy || {}), ...etsyState, removed_at: null } }, last_synced_at: now };
      if (extManaged) Object.assign(lp, { title: decode(l.title), price, currency: cur, status: l.state === "active" ? "published" : "paused", external_url: l.url,
        attributes: { ...(ex.attributes || {}), managed_by: pfi ? "printify" : extManaged } });
      await db.from("listings").update(lp).eq("id", ex.id);
      const pp: Record<string, unknown> = { ...prodCost };
      if (extManaged) Object.assign(pp, { name: decode(l.title), generated_title: decode(l.title), sale_price: price, ...(img ? { image_url: img } : {}) });
      else if (!pfi) { delete pp.cost_currency; }   // Seltigo ürünü: para birimi ve fiyat Seltigo'nun
      await db.from("products").update(pp).eq("id", ex.product_id);
      stats.updated++;
      continue;
    }
    if (l.state !== "active") continue;   // yalnız aktif ilanlar içe aktarılır
    const { data: prod, error: pe } = await db.from("products").insert({
      user_id: userId, name: decode(l.title), generated_title: decode(l.title), generated_description: decode(l.description), sale_price: price,
      stock_qty: l.quantity ?? null, product_type: l.listing_type === "download" ? "digital" : "physical", image_url: img, image_missing: !img,
      store_visible: false, source_platform: "etsy", source_item_id: ext, source_url: l.url, platform: "etsy", content_language: "en", ...prodCost,
    }).select("id").single();
    if (pe || !prod) { console.error("ürün eklenemedi", ext, pe?.message); continue; }
    if (img) await db.from("product_images").insert({ product_id: prod.id, user_id: userId, url: img, position: 0, source: "other", source_kind: "marketplace", source_url: l.url });
    await db.from("listings").insert({
      user_id: userId, product_id: prod.id, source_product_id: prod.id, connection_id: conn.id, marketplace_code: "etsy", language: "en", currency: cur,
      title: decode(l.title), description: decode(l.description), keywords: l.tags || [], price, price_mode: "manual", status: "published",
      external_listing_id: ext, external_url: l.url, published_at: now, last_synced_at: now,
      attributes: { managed_by: managed, imported_at: now, ...(pfi ? { printify_product_id: pfi.productId, printify_shop_id: pfi.shopId } : {}) },
      validation: { ok: true, etsy: etsyState },
    });
    stats.created++;
  }
  // 2) Etsy'de artık olmayan ilanlar
  for (const [ext, l] of byExt) {
    if (etsyAll.has(ext) || l.validation?.etsy?.state === "removed") continue;
    await db.from("listings").update({ validation: { ...(l.validation || {}), etsy: { ...(l.validation?.etsy || {}), state: "removed", removed_at: now } }, last_synced_at: now }).eq("id", l.id);
    stats.removed++;
  }
  await db.from("app_cache").upsert({ key: `etsy_sync:${userId}`, value: { ...stats, at: now }, updated_at: now });
  return stats;
}

async function run(userId?: string) {
  let q = db.from("store_connections").select("id, user_id, external_seller_id").eq("marketplace_code", "etsy").eq("status", "connected").is("deleted_at", null);
  if (userId) q = q.eq("user_id", userId);
  const { data: conns } = await q;
  const out: any[] = [];
  for (const c of conns || []) {
    if (!(await featureEnabled(c.user_id, "etsy_sync"))) { out.push({ userId: c.user_id, skipped: "paket" }); continue; }
    try { out.push({ userId: c.user_id, ...(await syncConnection(c)) }); }
    catch (e) { out.push({ userId: c.user_id, error: short((e as Error).message) }); }
  }
  return { ok: true, results: out };
}

// Printify webhook kaydı (ürün yayınlanınca / değişince / silinince anında senkron)
async function registerWebhooks(userId: string) {
  if (!WEBHOOK_TOKEN) return { ok: false, error: "PRINTIFY_WEBHOOK_TOKEN yok" };
  const url = `${SUPABASE_URL}/functions/v1/etsy-sync?t=${WEBHOOK_TOKEN}`; const out: any[] = [];
  for (const token of await printifyTokens(userId)) {
    let shops: any[] = []; try { shops = await pf(token, "/shops.json"); } catch { continue; }
    for (const s of shops.filter((x: any) => String(x.sales_channel).toLowerCase() === "etsy")) {
      const have = await pf(token, `/shops/${s.id}/webhooks.json`).catch(() => []);
      for (const topic of ["product:publish:started", "product:updated", "product:deleted"]) {
        if ((have || []).some((w: any) => w.topic === topic && String(w.url).startsWith(`${SUPABASE_URL}/functions/v1/etsy-sync`))) { out.push({ shop: s.id, topic, ok: true, existed: true }); continue; }
        const r = await fetch(`https://api.printify.com/v1/shops/${s.id}/webhooks.json`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "Seltigo" }, body: JSON.stringify({ topic, url }) });
        out.push({ shop: s.id, topic, ok: r.ok, status: r.status });
      }
      await db.from("app_cache").upsert({ key: `printify_shop_owner:${s.id}`, value: { userId }, updated_at: new Date().toISOString() });
    }
  }
  return { ok: out.every((x) => x.ok), webhooks: out };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Printify webhook: Printify yayını Etsy'ye birkaç saniye-dakikada tamamlar; 90 sn sonra o satıcı senkronlanır
  if (url.searchParams.get("t")) {
    if (!WEBHOOK_TOKEN || url.searchParams.get("t") !== WEBHOOK_TOKEN) return json({ ok: false }, 401);
    const b = await req.json().catch(() => ({}));
    const shop = String(b?.resource?.data?.shop_id ?? b?.resource?.shop_id ?? "");
    const { data: own } = shop ? await db.from("app_cache").select("value").eq("key", `printify_shop_owner:${shop}`).maybeSingle() : { data: null };
    const userId = own?.value?.userId;
    if (userId) {
      const job = (async () => { await new Promise((r) => setTimeout(r, 90_000)); await run(userId); })();
      // @ts-ignore: Supabase Edge Runtime
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job);
    }
    return json({ ok: true });
  }
  const b = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(b?.cronSecret || "").trim() !== CRON_SECRET.trim()) return json({ ok: false, error: "unauthorized" }, 401);
  try {
    if (b.action === "printify_webhooks" && b.userId) return json(await registerWebhooks(String(b.userId)));
    return json(await run(b.userId ? String(b.userId) : undefined));
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
