// =========================================================
// Seltigo - product-ingest (ürünü tek seferde kaydet ve yayınla; sunucu tarafı)
// Chrome eklentisi, Seltigo Asistan (WhatsApp / Telegram) ve diğer hızlı ekleme yolları kullanır.
// Toplu Ürün Yükleme'deki kaydetmenin aynısı (HIZ KURALI: ağır işler arkada, ilan önce açılır):
//   - satış fiyatı: Ayarlar'daki kâr kuralı (import_rules: base, margin, round, currency) ya da istekteki oran
//   - ürün kaynağı kuralı: yalnız AliExpress / CJ tedarikçi olabilir; AliExpress'te satıcının seçimi (aeSource) şart
//   - ürün + görseller (kaynağıyla) + seçenekler + Kendi Mağazam ilanı (TL'ye çevrilmiş fiyat)
//   - eksik görsel / özellik -> arka plan görsel tamamlama işi; AliExpress tedarikçili -> CJ eşdeğer araması
//   - kullanım hakkı kaydı (import_consents)
// Satıcı (oturum): POST { items: [...], sourceUrl, via, publish?, aeSource?, margin?, sync?, syncHours?, dedupe? }
// Sistem: aynı gövde + { cronSecret, userId }
// items: product-import çıktısıyla aynı biçim (name, price, list_price, currency, images, specs, variants, url,
//        source_platform, source_item_id, stock, model_code, brand, category, description)
//        + isteğe bağlı: barcode (GTIN), sku, sale_price (satış fiyatı belliyse; ör. perakende PDF), existing_id, imgSrc
// dedupe: true -> aynı barkod / SKU / model kodu satıcıda varsa yeni ürün açılmaz; maliyet, satış fiyatı ve stok güncellenir
//         (PDF + link ile yükleme; catalog-import). Cevapta her ürün için action: "created" | "updated" (items ile aynı sıra).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const MAX_ITEMS = 500;

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const CONSENT_LOG = "Kullanıcı, içe aktarılan ürün görsellerini ve içeriklerini kullanma hakkı olduğunu ve sorumluluğun kendisine ait olduğunu onayladı.";

function roundPrice(v: number, mode: string): number | null {
  if (!(v > 0)) return null;
  if (mode === "1") return Math.ceil(v);
  if (mode === "5") return Math.ceil(v / 5) * 5;
  if (mode === "10") return Math.ceil(v / 10) * 10;
  if (mode === "99") return Math.round((Math.ceil((v + 0.1) / 10) * 10 - 0.1) * 100) / 100;
  return Math.round(v * 100) / 100;
}
const fxCache = new Map<string, number | null>();
async function fx(from: string, to: string): Promise<number | null> {
  const f = (from || "").toUpperCase(), t = (to || "").toUpperCase();
  if (!f || !t || f === t) return 1;
  const k = f + ">" + t;
  if (fxCache.has(k)) return fxCache.get(k)!;
  const { data, error } = await db.rpc("fx_rate", { p_from: f, p_to: t, p_date: null });
  const r = error || data == null ? null : Number(data);
  fxCache.set(k, r);
  return r;
}
function fullDescription(it: any): string {
  let d = String(it.description || "").trim();
  const specs = Array.isArray(it.specs) ? it.specs : [];
  if (specs.length) d += (d ? "\n\n" : "") + "Teknik Özellikler:\n" + specs.map((s: any) => "• " + s.k + ": " + s.v).join("\n");
  return d.slice(0, 8000);
}

// ---------- Kopya önleme: barkod > SKU / model kodu ----------
async function findExisting(userId: string, it: any): Promise<any | null> {
  const cols = "id, name, image_url, image_missing, sale_price, store_visible";
  if (Number(it.existing_id) > 0) {
    const { data } = await db.from("products").select(cols).eq("id", Number(it.existing_id)).eq("user_id", userId).is("deleted_at", null).maybeSingle();
    if (data) return data;
  }
  const vars = Array.isArray(it.variants) ? it.variants : [];
  const barcodes = [it.barcode, ...vars.map((v: any) => v?.barcode)].map((x) => String(x || "").trim()).filter((x) => /^\d{8,14}$/.test(x));
  if (barcodes.length) {
    const { data: p } = await db.from("products").select(cols).eq("user_id", userId).is("deleted_at", null).in("gtin", barcodes).limit(1);
    if (p?.length) return p[0];
    const { data: v } = await db.from("product_variants").select("product_id").eq("user_id", userId).is("deleted_at", null).in("gtin", barcodes).limit(1);
    if (v?.length) {
      const { data } = await db.from("products").select(cols).eq("id", v[0].product_id).is("deleted_at", null).maybeSingle();
      if (data) return data;
    }
  }
  // Aynı ürün sayfası (kaynak linki) daha önce eklendiyse
  if (/^https?:\/\//i.test(String(it.url || ""))) {
    const { data: p } = await db.from("products").select(cols).eq("user_id", userId).is("deleted_at", null).eq("source_url", String(it.url)).limit(1);
    if (p?.length) return p[0];
  }
  const codes = [it.sku, it.model_code, ...vars.map((v: any) => v?.sku)].map((x) => clean(x, 80)).filter((x) => x.length >= 3);
  if (codes.length) {
    const { data: p } = await db.from("products").select(cols).eq("user_id", userId).is("deleted_at", null).in("model_code", codes).limit(1);
    if (p?.length) return p[0];
    const { data: v } = await db.from("product_variants").select("product_id").eq("user_id", userId).is("deleted_at", null).in("supplier_sku", codes).limit(1);
    if (v?.length) {
      const { data } = await db.from("products").select(cols).eq("id", v[0].product_id).is("deleted_at", null).maybeSingle();
      if (data) return data;
    }
  }
  return null;
}
// Var olan ürün: maliyet, satış fiyatı, stok (ve eksikse görsel / açıklama / barkod) güncellenir; ad ve satıcının düzenlemeleri korunur
async function updateExisting(userId: string, ex: any, it: any, sale: number | null, cur: string) {
  const patch: any = { updated_at: new Date().toISOString() };
  if (Number(it.price) > 0) { patch.supplier_price = Number(it.price); patch.cost_currency = cur; }
  if (sale && sale > 0) patch.sale_price = sale;
  if (it.stock != null && Number.isFinite(Number(it.stock))) patch.stock_qty = Math.max(0, Math.round(Number(it.stock)));
  if (/^\d{8,14}$/.test(String(it.barcode || ""))) patch.gtin = String(it.barcode);
  const images: string[] = (Array.isArray(it.images) ? it.images : []).filter((u: any) => /^https?:\/\//i.test(String(u))).slice(0, 12);
  if (images.length && (!ex.image_url || ex.image_missing)) {
    patch.image_url = images[0]; patch.image_missing = false;
    await db.from("product_images").insert(images.map((u, i) => ({ product_id: ex.id, user_id: userId, url: u, position: i, source: "supplier", source_kind: it.imgSrc?.kind || "link", source_url: it.imgSrc?.url || it.url || null })));
  }
  if (it.description && String(it.description).length > 40) {
    const { data: cur0 } = await db.from("products").select("generated_description").eq("id", ex.id).maybeSingle();
    if (!cur0?.generated_description || String(cur0.generated_description).length < 40) patch.generated_description = fullDescription(it);
  }
  await db.from("products").update(patch).eq("id", ex.id).eq("user_id", userId);
  // Seçenekler: barkod ya da SKU eşleşirse stok / maliyet
  for (const v of (Array.isArray(it.variants) ? it.variants : []).slice(0, 100)) {
    const vp: any = {};
    if (v?.stock != null && Number.isFinite(Number(v.stock))) vp.stock_qty = Math.max(0, Math.round(Number(v.stock)));
    if (Number(v?.price) > 0) vp.cost = Number(v.price);
    if (!Object.keys(vp).length) continue;
    if (/^\d{8,14}$/.test(String(v.barcode || ""))) await db.from("product_variants").update(vp).eq("product_id", ex.id).eq("gtin", String(v.barcode));
    else if (v.sku) await db.from("product_variants").update(vp).eq("product_id", ex.id).eq("supplier_sku", clean(v.sku, 80));
  }
  // Kendi Mağazam ilanı varsa fiyatı da (TL)
  if (sale && sale > 0) {
    let price = sale;
    if (cur !== "TRY") { const k = await fx(cur, "TRY"); price = k != null ? Math.round(sale * k * 100) / 100 : sale; }
    await db.from("listings").update({ price }).eq("product_id", ex.id).eq("marketplace_code", "own_store");
  }
}

async function ingest(userId: string, b: any) {
  const items: any[] = (Array.isArray(b.items) ? b.items : []).filter((i: any) => i && clean(i.name, 300)).slice(0, MAX_ITEMS);
  if (!items.length) return { ok: false, error: "Eklenecek ürün yok" };
  const hasAe = items.some((i) => i.source_platform === "aliexpress");
  if (hasAe && !["aliexpress", "own"].includes(String(b.aeSource || ""))) {
    return { ok: false, error: "AliExpress ürünleri için kaynak seçilmeli (AliExpress / Kendi stoğum)", needAeSource: true };
  }
  const aeDropship = b.aeSource === "aliexpress";

  // Onaylar: kullanım hakkı daha önce verilmiş olmalı ya da bu istekte verilmeli
  const { count: consents } = await db.from("import_consents").select("id", { count: "exact", head: true }).eq("user_id", userId);
  const { data: prof } = await db.from("user_profiles").select("image_terms_accepted_at").eq("user_id", userId).maybeSingle();
  if (!consents && b.consent !== true) return { ok: false, error: "Kullanım hakkı onayı gerekli", needConsent: true };
  if (!prof?.image_terms_accepted_at) {
    if (b.imageTerms !== true) return { ok: false, error: "Görsel kullanım onayı gerekli", needImageTerms: true };
    const text = "Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir";
    const up = await db.from("user_profiles").update({ image_terms_accepted_at: new Date().toISOString(), image_terms_text: text }).eq("user_id", userId).select("user_id");
    if (!up.data?.length) await db.from("user_profiles").insert({ user_id: userId, image_terms_accepted_at: new Date().toISOString(), image_terms_text: text });
  }
  await db.from("import_consents").insert({ user_id: userId, source_url: clean(b.sourceUrl || items[0].url || b.via || "", 500), item_count: items.length, consent_text: CONSENT_LOG });

  const { data: ruleRow } = await db.from("import_rules").select("rules").eq("user_id", userId).maybeSingle();
  const r = ruleRow?.rules || {};
  const margin = b.margin != null && Number.isFinite(Number(b.margin)) ? Math.max(0, Number(b.margin)) : Math.max(0, Number(r.margin ?? 30));
  const roundMode = String(r.round || "");
  const publish = b.publish !== false;
  const sync = b.sync !== false;
  const syncHours = Number(b.syncHours) === 6 ? 6 : 24;

  const priceOf = (it: any) => {
    if (b.salePrice != null && Number(b.salePrice) > 0 && items.length === 1) return Number(b.salePrice); // satıcının söylediği fiyat ("350'ye sat")
    if (r.base === "list" && Number(it.list_price) > 0) return roundPrice(Number(it.list_price), roundMode);
    const c = Number(it.price);
    return c > 0 ? roundPrice(c * (1 + margin / 100), roundMode) : null;
  };
  const curOf = (it: any) => (r.currency && r.currency !== "auto" ? r.currency : (it.currency || "TRY"));

  const created: any[] = [];
  const needJobs: number[] = [];
  for (const it of items) {
    const cur = curOf(it);
    const sale = Number(it.sale_price) > 0 ? Number(it.sale_price) : priceOf(it);
    if (b.dedupe) {
      const ex = await findExisting(userId, it);
      if (ex) {
        await updateExisting(userId, ex, it, sale, cur);
        if ((!ex.image_url || ex.image_missing) && !(Array.isArray(it.images) && it.images.length)) needJobs.push(ex.id);
        created.push({ id: ex.id, name: ex.name, sale_price: sale, currency: cur, action: "updated" });
        continue;
      }
    }
    const images: string[] = (Array.isArray(it.images) ? it.images : []).filter((u: any) => /^https?:\/\//i.test(String(u))).slice(0, 12);
    const isAe = it.source_platform === "aliexpress";
    const row: any = {
      user_id: userId, name: clean(it.name, 300), generated_title: clean(it.name, 300), generated_description: fullDescription(it),
      supplier_price: Number(it.price) > 0 ? Number(it.price) : 0, sale_price: sale || 0, weight_kg: 0, platform: null, commission_rate: 0,
      supplier: aeDropship && isAe && it.source_item_id ? "aliexpress" : null,
      supplier_item_id: aeDropship && isAe ? (it.source_item_id || null) : null,
      supplier_cost: aeDropship && isAe && Number(it.price) > 0 ? Number(it.price) : null,
      image_url: images[0] || null, image_missing: !images.length, cost_currency: cur, content_language: "tr", store_visible: publish,
      specs: Array.isArray(it.specs) && it.specs.length ? it.specs.slice(0, 80) : null,
      source_url: it.url || null, source_platform: it.source_platform || (it.url ? "web" : null), source_item_id: it.source_item_id || null,
      source_sync: !!(sync && it.url), source_sync_hours: syncHours,
      stock_qty: b.stock != null && items.length === 1 ? Math.max(0, parseInt(b.stock, 10) || 0) : (Number.isFinite(Number(it.stock)) && it.stock !== null ? Number(it.stock) : null),
      model_code: it.model_code || it.sku || null, brand: r.brand || it.brand || null,
      gtin: /^\d{8,14}$/.test(String(it.barcode || "")) ? String(it.barcode) : null,
    };
    const ins = await db.from("products").insert(row).select("id").single();
    if (ins.error) throw new Error("Ürün kaydı: " + ins.error.message);
    const pid = ins.data.id;

    if (images.length) {
      const srcKind = it.imgSrc?.kind || (it.url ? "link" : "catalog");
      const srcUrl = it.imgSrc?.url || it.url || null;
      await db.from("product_images").insert(images.map((u, i) => ({ product_id: pid, user_id: userId, url: u, position: i, source: "supplier", source_kind: srcKind, source_url: srcUrl })));
    }
    const vars = (Array.isArray(it.variants) ? it.variants : []).filter((v: any) => v?.attributes && Object.keys(v.attributes).length).slice(0, 100);
    if (vars.length) {
      await db.from("product_variants").insert(vars.map((v: any, k: number) => ({
        product_id: pid, user_id: userId, sku: "HS-" + pid + "-" + (k + 1), supplier_variant_id: v.supplier_variant_id || null, supplier_sku: v.sku || null,
        attributes: v.attributes, cost: Number(v.price) > 0 ? Number(v.price) : null, cost_currency: cur,
        gtin: /^\d{8,14}$/.test(String(v.barcode || "")) ? String(v.barcode) : null,
        stock_qty: Number.isFinite(Number(v.stock)) && v.stock !== null ? Number(v.stock) : null, stock_status: v.stock === 0 ? "tukendi" : null,
        image_url: v.image || null, is_default: false, is_active: true,
      })));
    }
    if (publish) {
      let price = sale || 0;
      if (cur !== "TRY" && price > 0) { const k = await fx(cur, "TRY"); price = k != null ? Math.round(price * k * 100) / 100 : price; }
      const li = await db.from("listings").insert({
        user_id: userId, product_id: pid, source_product_id: pid, marketplace_code: "own_store", language: "tr", currency: "TRY",
        title: row.name, description: row.generated_description, keywords: [], category_key: null, price, commission_pct: 0, vat_payer: "seller",
        price_mode: "manual", status: "published", published_at: new Date().toISOString(),
      }).select("id").single();
      if (li.error) throw new Error("İlan kaydı: " + li.error.message);
      const { data: dv } = await db.from("product_variants").select("id").eq("product_id", pid).eq("is_default", true).maybeSingle();
      if (dv) await db.from("listing_variants").insert({ listing_id: li.data.id, variant_id: dv.id, user_id: userId, price, status: "published" });
    }
    if (!images.length || !(Array.isArray(it.specs) && it.specs.length)) needJobs.push(pid);
    if (row.supplier === "aliexpress") {
      fetch(`${SUPABASE_URL}/functions/v1/cj-alt-match`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
        body: JSON.stringify({ productId: pid, cronSecret: CRON_SECRET }),
      }).catch(() => {});
    }
    if (it.sku) await db.from("product_variants").update({ supplier_sku: clean(it.sku, 80) }).eq("product_id", pid).eq("is_default", true);
    created.push({ id: pid, name: row.name, sale_price: sale, currency: cur, action: "created" });
  }
  // Arka plan görsel tamamlama (ilan önce açıldı)
  let batchId: string | null = null;
  if (needJobs.length) {
    const bt = await db.from("image_job_batches").insert({ user_id: userId, total: needJobs.length }).select("id").single();
    if (!bt.error) {
      batchId = bt.data.id;
      await db.from("image_jobs").insert(needJobs.map((id) => ({ batch_id: batchId, user_id: userId, product_id: id, wholesaler_site: b.wholesalerSite || null })));
    }
  }
  return { ok: true, products: created, imageJobs: needJobs.length, batchId };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    let userId: string | null = null;
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim() && typeof b?.userId === "string") userId = b.userId;
    else {
      const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      const { data } = bearer.split(".").length === 3 ? await db.auth.getUser(bearer) : { data: { user: null } };
      userId = data?.user?.id || null;
    }
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    const res = await ingest(userId, b);
    return json(res, res.ok ? 200 : 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message).slice(0, 300) }, 500);
  }
});
