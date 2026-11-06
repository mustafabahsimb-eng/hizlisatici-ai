// =========================================================
// Seltigo - site-api: "Seltigo bağlantı kodu" REST uç noktaları (satıcının sitesi <-> Seltigo, iki yönlü)
// Kimlik: Authorization: Bearer slt_live_...  (ya da X-Seltigo-Key). Anahtar site-connect "api_key" ile üretilir,
// yalnız özeti saklanır. Sınır: bağlantı başına dakikada 120 istek. Tüm gövdeler JSON.
//   GET    /site-api/ping                          -> bağlantı + mağaza bilgisi
//   GET    /site-api/products?limit=&offset=&updated_since=
//   GET    /site-api/products/{id}
//   POST   /site-api/products                      -> ürün oluştur (aynı barkod / SKU / link varsa günceller; Kendi Mağazam'da yayında)
//   PATCH  /site-api/products/{id}                 -> { name?, title?, description?, price?, stock_qty?, sku?, gtin? }
//   DELETE /site-api/products/{id}
//   POST   /site-api/stock                         -> { items: [{ product_id | sku | gtin, variant_sku?, quantity }] }
//   POST   /site-api/orders                        -> sitede satış: { external_order_id, items: [{ product_id | sku | gtin, variant_sku?, quantity, price }],
//                                                     currency?, customer? } -> ortak stok düşer, tüm pazaryerlerine yansır
//   GET    /site-api/orders?since=                 -> Seltigo'daki diğer kanalların siparişleri (pazaryerleri, Kendi Mağazam)
// Siteden gelen değişiklik siteye webhook olarak geri yollanmaz.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled } from "../_shared/features.ts";
import { sha256Hex } from "../_shared/site-guard.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SITE = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-seltigo-key, content-type", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
const err = (code: string, message: string, s = 400) => json({ error: { code, message } }, s);
const clean = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function auth(req: Request) {
  const raw = (req.headers.get("x-seltigo-key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")).trim();
  if (!/^slt_live_[0-9a-f]{48}$/.test(raw)) return null;
  const { data: c } = await db.from("site_connections").select("*").eq("api_key_hash", await sha256Hex(raw)).is("deleted_at", null).maybeSingle();
  return c;
}

async function productOut(p: any, slug: string | null) {
  const [{ data: imgs }, { data: vars }] = await Promise.all([
    db.from("product_images").select("url, position").eq("product_id", p.id).is("deleted_at", null).order("position").limit(12),
    db.from("product_variants").select("id, sku, supplier_sku, gtin, attributes, stock_qty, stock_status, is_default").eq("product_id", p.id).is("deleted_at", null).eq("is_active", true),
  ]);
  return {
    id: p.id, sku: p.model_code || null, gtin: p.gtin || null, name: p.name, title: p.generated_title || p.name,
    description: p.generated_description || "", price: num(p.sale_price), currency: "TRY", stock_qty: p.stock_qty, stock_status: p.stock_status,
    images: (imgs || []).map((i: any) => i.url).filter(Boolean).length ? (imgs || []).map((i: any) => i.url) : (p.image_url ? [p.image_url] : []),
    variants: (vars || []).filter((v: any) => !v.is_default).map((v: any) => ({ id: v.id, sku: v.supplier_sku || v.sku, gtin: v.gtin, attributes: v.attributes, stock_qty: v.stock_qty, stock_status: v.stock_status })),
    url: slug ? `${SITE}/magaza.html?slug=${slug}&p=${p.id}` : null, updated_at: p.updated_at, deleted: !!p.deleted_at,
  };
}

// Ürün bul: id > sku (model kodu / seçenek SKU) > gtin
async function resolve(userId: string, ref: any): Promise<{ product: any; variant: any } | null> {
  const cols = "id, user_id, model_code, gtin, stock_qty, deleted_at";
  if (ref.product_id) {
    const { data } = await db.from("products").select(cols).eq("id", Number(ref.product_id)).eq("user_id", userId).is("deleted_at", null).maybeSingle();
    if (data) return { product: data, variant: ref.variant_sku ? await variantBySku(data.id, ref.variant_sku) : null };
  }
  for (const [k, col] of [["sku", "model_code"], ["gtin", "gtin"]] as const) {
    if (!ref[k]) continue;
    const { data } = await db.from("products").select(cols).eq("user_id", userId).eq(col, String(ref[k])).is("deleted_at", null).limit(1);
    if (data?.length) return { product: data[0], variant: ref.variant_sku ? await variantBySku(data[0].id, ref.variant_sku) : null };
    const vq = k === "sku" ? db.from("product_variants").select("id, product_id, stock_qty").eq("user_id", userId).or(`sku.eq.${String(ref.sku).replace(/[,()]/g, "")},supplier_sku.eq.${String(ref.sku).replace(/[,()]/g, "")}`)
      : db.from("product_variants").select("id, product_id, stock_qty").eq("user_id", userId).eq("gtin", String(ref.gtin));
    const { data: v } = await vq.is("deleted_at", null).limit(1);
    if (v?.length) {
      const { data: p } = await db.from("products").select(cols).eq("id", v[0].product_id).is("deleted_at", null).maybeSingle();
      if (p) return { product: p, variant: v[0] };
    }
  }
  return null;
}
async function variantBySku(productId: number, sku: string) {
  const s = String(sku).replace(/[,()]/g, "");
  const { data } = await db.from("product_variants").select("id, product_id, stock_qty").eq("product_id", productId).or(`sku.eq.${s},supplier_sku.eq.${s}`).is("deleted_at", null).limit(1);
  return data?.[0] || null;
}

async function createProducts(c: any, body: any) {
  const list = Array.isArray(body.products) ? body.products : [body];
  if (!list.length || list.length > 100) return err("invalid", "1-100 ürün gönder");
  const items = list.map((p: any) => ({
    name: clean(p.name || p.title, 300), description: String(p.description || "").slice(0, 8000), sale_price: num(p.price), price: num(p.cost),
    currency: clean(p.currency || "TRY", 3).toUpperCase(), stock: p.stock_qty ?? p.stock ?? null, sku: clean(p.sku, 80), model_code: clean(p.sku, 80), barcode: clean(p.gtin || p.barcode, 14),
    brand: clean(p.brand, 80), category: clean(p.category, 120), images: (Array.isArray(p.images) ? p.images : []).filter((u: string) => /^https:\/\//.test(String(u))).slice(0, 12),
    url: /^https?:\/\//.test(String(p.url || "")) ? String(p.url) : "", source_platform: "website", source_item_id: clean(p.external_id || p.sku, 80),
    variants: (Array.isArray(p.variants) ? p.variants : []).slice(0, 100).map((v: any) => ({ sku: clean(v.sku, 80) || null, barcode: clean(v.gtin, 14) || null, price: num(v.cost), stock: v.stock_qty ?? v.stock ?? null, attributes: v.attributes || {}, image: v.image || null })),
  }));
  if (items.some((i: any) => !i.name)) return err("invalid", "Her üründe name zorunlu");
  const r = await fetch(`${SUPABASE_URL}/functions/v1/product-ingest`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ items, cronSecret: CRON_SECRET, userId: c.user_id, sourceUrl: c.origin, via: "site-api", publish: true, dedupe: true, aeSource: "own", consent: true, imageTerms: true, sync: false }),
    signal: AbortSignal.timeout(120000),
  }).then((x) => x.json()).catch(() => null);
  if (!r?.ok) return err("save_failed", r?.error || "Kaydedilemedi", 502);
  const prods: any[] = r.products || [];
  const ids = prods.map((p) => p.id);
  // Siteden gelen ürün siteye geri yollanmaz
  if (ids.length) await db.from("site_webhook_events").delete().eq("connection_id", c.id).eq("status", "pending").in("payload->>product_id", ids.map(String));
  const maps = prods.map((p, k) => ({ connection_id: c.id, user_id: c.user_id, product_id: p.id, url: items[k].url || `api:${items[k].sku || p.id}`, external_id: items[k].source_item_id || null, sku: items[k].sku || null, seen_at: new Date().toISOString() }));
  if (maps.length) await db.from("site_product_map").upsert(maps, { onConflict: "connection_id,url" });
  return json({ ok: true, products: prods.map((p) => ({ id: p.id, action: p.action, price: p.sale_price })) }, 201);
}

async function setStock(c: any, body: any) {
  const list = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  if (!list.length) return err("invalid", "items gerekli");
  const out: unknown[] = [];
  for (const it of list) {
    const q = Math.max(0, Math.floor(Number(it.quantity)));
    if (!Number.isFinite(q)) { out.push({ ref: it, ok: false, error: "quantity sayı olmalı" }); continue; }
    const hit = await resolve(c.user_id, it);
    if (!hit) { out.push({ ref: it, ok: false, error: "ürün bulunamadı" }); continue; }
    if (hit.variant && it.variant_sku) {
      await db.rpc("site_variant_stock", { p_user: c.user_id, p_variant: hit.variant.id, p_qty: q });
      // Ürün toplam stoğu = seçeneklerin toplamı
      const { data: vs } = await db.from("product_variants").select("stock_qty").eq("product_id", hit.product.id).eq("is_default", false).is("deleted_at", null);
      const total = (vs || []).reduce((s: number, v: any) => s + (Number(v.stock_qty) || 0), 0);
      await db.rpc("site_product_patch", { p_user: c.user_id, p_product: hit.product.id, p_patch: { stock_qty: total } });
    } else await db.rpc("site_product_patch", { p_user: c.user_id, p_product: hit.product.id, p_patch: { stock_qty: q } });
    out.push({ product_id: hit.product.id, variant_id: hit.variant?.id || null, ok: true, quantity: q });
  }
  return json({ ok: true, results: out });
}

async function createOrder(c: any, body: any) {
  const ext = clean(body.external_order_id || body.id, 80);
  if (!ext) return err("invalid", "external_order_id gerekli");
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
  if (!items.length) return err("invalid", "items gerekli");
  const cur = clean(body.currency || "TRY", 3).toUpperCase();
  const cust = body.customer || {};
  const out: unknown[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const hit = await resolve(c.user_id, it);
    if (!hit) { out.push({ line: k, ok: false, error: "ürün bulunamadı" }); continue; }
    const extId = items.length > 1 ? `${ext}-${k + 1}` : ext;
    const { data, error } = await db.from("marketplace_orders").insert({
      user_id: c.user_id, marketplace_code: "website", external_order_id: extId, product_id: hit.product.id, variant_id: hit.variant?.id || null,
      quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)), currency: cur, item_price: num(it.price), status: "new", ordered_at: new Date().toISOString(),
      buyer_name: clean(cust.name, 120) || null, buyer_phone: clean(cust.phone, 30) || null, buyer_email: clean(cust.email, 160) || null,
      buyer_address: cust.address ? { text: clean(cust.address, 500), city: clean(cust.city, 60), district: clean(cust.district, 60), zip: clean(cust.zip, 12) } : null,
      source_table: "site_api", source_id: c.id, raw: { site: c.origin, order: ext },
    }).select("id").single();
    if (error) {
      if (error.code === "23505") { out.push({ line: k, ok: true, duplicate: true }); continue; }
      out.push({ line: k, ok: false, error: error.message }); continue;
    }
    out.push({ line: k, ok: true, order_id: data.id, product_id: hit.product.id });
  }
  return json({ ok: true, results: out }, 201);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(req.url).pathname.replace(/^.*?\/site-api/, "").replace(/\/+$/, "") || "/";
  try {
    const c = await auth(req);
    if (!c) return err("unauthorized", "Geçersiz ya da eksik API anahtarı (Authorization: Bearer slt_live_...)", 401);
    if (!(await featureEnabled(c.user_id, "site_api"))) return err("disabled", "Bu özellik paketinde kapalı", 403);
    const { data: ok } = await db.rpc("rate_hit", { p_key: "siteapi:" + c.id, p_limit: 120, p_window_seconds: 60 });
    if (ok === false) return err("rate_limited", "Dakikada en fazla 120 istek", 429);
    db.from("site_connections").update({ api_last_used_at: new Date().toISOString() }).eq("id", c.id).then(() => null);
    const { data: st } = await db.from("store_settings").select("store_slug, store_name").eq("user_id", c.user_id).maybeSingle();
    const body = ["POST", "PATCH"].includes(req.method) ? await req.json().catch(() => null) : null;
    if (["POST", "PATCH"].includes(req.method) && !body) return err("invalid_json", "Gövde JSON olmalı");
    const m = path.match(/^\/products\/(\d+)$/);

    if (path === "/ping" && req.method === "GET") return json({ ok: true, site: c.origin, store: st?.store_name || null, store_url: st ? `${SITE}/magaza.html?slug=${st.store_slug}` : null, verified: !!c.verified_at });
    if (path === "/products" && req.method === "GET") {
      const u = new URL(req.url);
      const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit")) || 50)), offset = Math.max(0, Number(u.searchParams.get("offset")) || 0);
      let q = db.from("products").select("*", { count: "exact" }).eq("user_id", c.user_id).is("merged_into", null).order("id").range(offset, offset + limit - 1);
      const since = u.searchParams.get("updated_since");
      q = since ? q.gte("updated_at", since) : q.is("deleted_at", null);
      const { data, count } = await q;
      return json({ ok: true, total: count, products: await Promise.all((data || []).map((p: any) => productOut(p, st?.store_slug || null))) });
    }
    if (m && req.method === "GET") {
      const { data: p } = await db.from("products").select("*").eq("id", Number(m[1])).eq("user_id", c.user_id).maybeSingle();
      return p ? json({ ok: true, product: await productOut(p, st?.store_slug || null) }) : err("not_found", "Ürün bulunamadı", 404);
    }
    if (path === "/products" && req.method === "POST") return await createProducts(c, body);
    if (m && req.method === "PATCH") {
      const patch: any = {};
      for (const k of ["name", "title", "description", "sku", "gtin"]) if (body[k] != null) patch[k] = clean(body[k], k === "description" ? 8000 : 300);
      if (body.price != null) patch.price = num(body.price);
      if (body.cost != null) patch.cost = num(body.cost);
      if (body.stock_qty != null) patch.stock_qty = Math.max(0, Math.floor(Number(body.stock_qty)));
      const { data: done } = await db.rpc("site_product_patch", { p_user: c.user_id, p_product: Number(m[1]), p_patch: patch });
      return done ? json({ ok: true }) : err("not_found", "Ürün bulunamadı", 404);
    }
    if (m && req.method === "DELETE") {
      const { data: done } = await db.rpc("site_product_patch", { p_user: c.user_id, p_product: Number(m[1]), p_patch: { delete: true } });
      return done ? json({ ok: true }) : err("not_found", "Ürün bulunamadı", 404);
    }
    if (path === "/stock" && req.method === "POST") return await setStock(c, body);
    if (path === "/orders" && req.method === "POST") return await createOrder(c, body);
    if (path === "/orders" && req.method === "GET") {
      const since = new URL(req.url).searchParams.get("since") || new Date(Date.now() - 7 * 86400_000).toISOString();
      const { data } = await db.from("marketplace_orders").select("id, marketplace_code, external_order_id, product_id, variant_id, quantity, item_price, currency, status, ordered_at")
        .eq("user_id", c.user_id).neq("marketplace_code", "website").gte("ordered_at", since).order("ordered_at", { ascending: false }).limit(200);
      return json({ ok: true, orders: data || [] });
    }
    return err("not_found", "Bilinmeyen uç nokta: " + req.method + " " + path, 404);
  } catch (e) {
    console.error(e);
    return err("server_error", "Sunucu hatası", 500);
  }
});
