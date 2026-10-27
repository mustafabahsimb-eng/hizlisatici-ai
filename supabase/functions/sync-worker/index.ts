// =========================================================
// HızlıSatıcı AI - sync-worker
// Kuyruktaki (sync_jobs) işleri alır, ilgili pazaryerine uygular, sonucu yazar.
// Zamanlanmış görev (cron) çağırır. Güvenlik: CRON_SECRET.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { AMAZON_MARKETS, marketByCode, amazonConfigured } from "../_shared/amazon.ts";
import { submitListing, withdrawListing } from "../_shared/amazon-listing.ts";
import { storageUploader } from "../_shared/amazon-images.ts";
import { buildItems, categoryAttributes, credsFromVault, fillAttributes, findBrand, localChecks, pickCategory, submitProducts, trendruumEnabled, updatePriceStock } from "../_shared/trendruum.ts";
import { featureEnabled } from "../_shared/features.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SITE_URL = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const BATCH_SIZE = 10;        // tek seferde alınan iş sayısı
const MAX_ROUNDS = 40;        // bir çalışmada en fazla kaç tur (asıl sınır süre bütçesi)
const TIME_BUDGET_MS = 45000; // Edge Function süresini aşmamak için
const CONCURRENCY = 6;         // aynı anda işlenen ilan sayısı (pazaryeri kotalarına adaptörlerin tekrar denemesi uyar)

// En fazla n işi aynı anda çalıştırır
async function runPool(items, n, fn) {
  let i = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  });
  await Promise.all(lanes);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errMsg(e) {
  if (!e) return "unknown_error";
  if (typeof e === "string") return e;
  return e.message || JSON.stringify(e);
}

// ---------------------------------------------------------
// Pazaryeri adaptörleri
// Her adaptör: (action: 'publish' | 'unpublish', listing, ctx) => { patch?: {...}, info?: {...} }
// Hata olursa throw eder; işçi işi yeniden denemeye bırakır.
// ---------------------------------------------------------

// 🏪 Kendi Mağazam (dış API yok - vitrin bizim sitemiz)
async function ownStoreAdapter(action, listing) {
  // Mağaza adresi
  const { data: store } = await db
    .from("store_settings")
    .select("store_slug")
    .eq("user_id", listing.user_id)
    .limit(1)
    .maybeSingle();
  const slug = store && store.store_slug ? store.store_slug : null;

  // Ürün stoğu (varyantlara "gönderilen stok" olarak yazılır)
  let stockQty = null;
  if (listing.product_id != null) {
    const { data: prod } = await db
      .from("products")
      .select("stock_qty, stock_status")
      .eq("id", listing.product_id)
      .maybeSingle();
    if (prod) stockQty = prod.stock_qty;
  }

  if (action === "publish") {
    // Eski vitrin sorgusu (products.store_visible) ile uyumlu kal
    if (listing.product_id != null) {
      await db.from("products").update({ store_visible: true }).eq("id", listing.product_id);
    }
    if (stockQty != null) {
      await db.from("listing_variants").update({ stock_pushed: stockQty }).eq("listing_id", listing.id);
    }
    return {
      patch: {
        external_url: slug ? SITE_URL + "/magaza.html?slug=" + encodeURIComponent(slug) : null,
        published_at: listing.published_at || new Date().toISOString(),
      },
      info: { slug, stock_pushed: stockQty },
    };
  }

  // unpublish: bu ürünün başka yayında Kendi Mağazam ilanı yoksa vitrinden kaldır
  if (listing.product_id != null) {
    const { count } = await db
      .from("listings")
      .select("id", { count: "exact", head: true })
      .eq("product_id", listing.product_id)
      .eq("marketplace_code", "own_store")
      .eq("status", "published")
      .is("deleted_at", null)
      .neq("id", listing.id);
    if (!count) {
      await db.from("products").update({ store_visible: false }).eq("id", listing.product_id);
    }
  }
  await db.from("listing_variants").update({ stock_pushed: 0 }).eq("listing_id", listing.id);
  return { patch: {}, info: { removed_from_store: true } };
}

// 🟠 Trendyol
// Şimdilik sadece PROVA MODU: ilanı Trendyol'un istediği biçime çevirir,
// kurallara göre kontrol eder, sonucu ilana yazar. Trendyol'a HİÇBİR ŞEY gönderilmez.
// Canlı gönderim ayrı bir adımda, bağlantı ayarında dry_run=false yapılınca açılacak.
const TY_VAT_RATES = [0, 1, 10, 20];

function tyIssue(list, code, field, msg, params) {
  list.push({ code, field, msg, ...(params ? { params } : {}) });
}

async function trendyolAdapter(action, listing) {
  const now = new Date().toISOString();

  // Bağlantı ve prova ayarı (bağlantı yoksa her zaman prova)
  let conn = null;
  if (listing.connection_id) {
    const { data } = await db
      .from("store_connections")
      .select("id, status, external_seller_id, settings")
      .eq("id", listing.connection_id)
      .maybeSingle();
    conn = data || null;
  }
  const settings = (conn && conn.settings) || {};
  const dryRun = !conn || settings.dry_run !== false;

  if (action === "unpublish") {
    const validation = {
      ok: true, dry_run: dryRun, action: "unpublish", errors: [], warnings: [],
      note: "Trendyol'da ürün silinmez; stok 0 yapılarak satışa kapatılır.",
      checked_at: now,
    };
    if (!dryRun) throw new Error("trendyol_live_not_enabled");
    return { patch: { validation, validated_at: now, last_sync_error: "prova_ok" }, info: { dry_run: true, action } };
  }

  // Ürün, varyant, görseller
  let product = null, variant = null, images = [];
  if (listing.product_id != null) {
    const { data: p } = await db.from("products").select("*").eq("id", listing.product_id).maybeSingle();
    product = p || null;
    const { data: v } = await db
      .from("product_variants")
      .select("*")
      .eq("product_id", listing.product_id)
      .eq("is_default", true)
      .maybeSingle();
    variant = v || null;
    const { data: imgs } = await db
      .from("product_images")
      .select("url, position")
      .eq("product_id", listing.product_id)
      .order("position");
    images = (imgs || []).map((i) => i.url).filter(Boolean);
    if (!images.length && product && product.image_url) images = [product.image_url];
  }

  const errors = [];
  const warnings = [];
  const ty = (listing.attributes && listing.attributes.trendyol) || {};

  // Başlık
  const title = String(listing.title || "").trim();
  if (!title) tyIssue(errors, "title_missing", "title", "Başlık boş.");
  else if (title.length > 100) tyIssue(errors, "title_too_long", "title", "Başlık en fazla 100 karakter olabilir (şu an " + title.length + ").", { len: title.length, max: 100 });

  // Açıklama
  const description = String(listing.description || "").trim();
  if (!description) tyIssue(errors, "description_missing", "description", "Açıklama boş.");
  else if (description.length > 30000) tyIssue(errors, "description_too_long", "description", "Açıklama çok uzun (en fazla 30.000 karakter).", { len: description.length });

  // Kategori ve marka
  const categoryId = Number(listing.marketplace_category_id) || null;
  if (!categoryId) tyIssue(errors, "category_missing", "category", "Trendyol kategorisi seçilmemiş.");
  const brandId = Number(listing.marketplace_brand_id) || null;
  if (!brandId) tyIssue(errors, "brand_missing", "brand", "Trendyol markası seçilmemiş.");

  // Zorunlu özellikler
  const attrs = Array.isArray(ty.attributes) ? ty.attributes : [];
  const requiredCount = Number(ty.required_count) || 0;
  if (categoryId && requiredCount && attrs.length < requiredCount) {
    tyIssue(errors, "attributes_missing", "attributes", (requiredCount - attrs.length) + " zorunlu özellik boş.", { missing: requiredCount - attrs.length });
  }
  if (categoryId && !requiredCount && !attrs.length) {
    tyIssue(warnings, "attributes_unchecked", "attributes", "Zorunlu özellikler kontrol edilmemiş (Trendyol bilgileri bölümünü doldur).");
  }

  // Fiyat
  const salePrice = Number(listing.price) || 0;
  const listPrice = Number(listing.compare_at_price) || salePrice;
  if (salePrice <= 0) tyIssue(errors, "price_missing", "price", "Satış fiyatı yok.");
  if (listPrice < salePrice) tyIssue(errors, "list_price_low", "price", "Liste fiyatı satış fiyatından düşük olamaz.");
  if ((listing.currency || "TRY") !== "TRY") tyIssue(errors, "currency_not_try", "price", "Trendyol'da fiyat TL olmalı.", { currency: listing.currency });

  // KDV
  let vatRate = listing.vat_rate_pct != null ? Number(listing.vat_rate_pct) : null;
  if (vatRate == null) {
    vatRate = 20;
    tyIssue(warnings, "vat_default", "vat", "KDV oranı girilmemiş, %20 varsayıldı.");
  } else if (!TY_VAT_RATES.includes(vatRate)) {
    tyIssue(errors, "vat_invalid", "vat", "KDV oranı 0, 1, 10 ya da 20 olmalı.", { vat: vatRate });
  }

  // Görseller
  const httpsImages = images.filter((u) => /^https:\/\//i.test(u));
  if (!httpsImages.length) tyIssue(errors, "images_missing", "images", "En az 1 görsel (https adresli) gerekli.");
  if (httpsImages.length < images.length) tyIssue(warnings, "images_not_https", "images", "https olmayan görseller gönderilmeyecek.");
  if (httpsImages.length > 8) tyIssue(warnings, "images_too_many", "images", "Trendyol en fazla 8 görsel alır, ilk 8'i gönderilecek.");

  // Stok
  const quantity = product && product.stock_qty != null ? Math.max(0, Math.floor(Number(product.stock_qty))) : 0;
  if (!product || product.stock_qty == null) tyIssue(warnings, "stock_unknown", "stock", "Stok bilgisi yok, 0 gönderilecek (ürün satışa kapalı açılır).");
  else if (quantity === 0) tyIssue(warnings, "stock_zero", "stock", "Stok 0, ürün satışa kapalı açılır.");

  // Barkod
  let barcode = (variant && (variant.barcode || variant.sku)) || (product && (product.barcode || product.sku)) || null;
  if (!barcode) {
    barcode = "HS" + String(listing.product_id || listing.id).replace(/[^0-9A-Za-z]/g, "").slice(0, 30);
    tyIssue(warnings, "barcode_generated", "barcode", "Barkod yok, otomatik barkod kullanılacak: " + barcode, { barcode });
  }

  // Desi
  const weight = product && product.weight_kg ? Number(product.weight_kg) : null;
  const dimensionalWeight = weight && weight > 0 ? Math.max(1, Math.ceil(weight)) : 1;
  if (!weight) tyIssue(warnings, "weight_missing", "weight", "Ağırlık yok, desi 1 varsayıldı.");

  // Kargo firması (canlı gönderimde gerekli)
  const cargoCompanyId = settings.cargo_company_id ? Number(settings.cargo_company_id) : null;
  if (!cargoCompanyId) tyIssue(warnings, "cargo_missing", "cargo", "Kargo firması seçilmemiş (canlı gönderimde gerekli).");

  // Bağlantı
  if (!conn) tyIssue(warnings, "no_connection", "connection", "Trendyol mağaza bağlantısı yok; sadece prova yapılabilir.");

  const item = {
    barcode,
    title: title.slice(0, 100),
    productMainId: "HS" + String(listing.product_id || listing.id),
    brandId,
    categoryId,
    quantity,
    stockCode: barcode,
    dimensionalWeight,
    description,
    currencyType: "TRY",
    listPrice,
    salePrice,
    vatRate,
    ...(cargoCompanyId ? { cargoCompanyId } : {}),
    images: httpsImages.slice(0, 8).map((url) => ({ url })),
    attributes: attrs.map((a) =>
      a.attributeValueId != null
        ? { attributeId: a.attributeId, attributeValueId: a.attributeValueId }
        : { attributeId: a.attributeId, customAttributeValue: a.customAttributeValue }
    ),
  };

  const validation = {
    ok: errors.length === 0,
    dry_run: dryRun,
    action: "publish",
    errors,
    warnings,
    payload: { items: [item] },
    checked_at: now,
  };

  if (!dryRun) {
    // Canlı gönderim henüz açık değil: güvenlik için dur
    throw new Error("trendyol_live_not_enabled");
  }

  return {
    patch: {
      validation,
      validated_at: now,
      last_sync_error: errors.length ? "prova_failed" : "prova_ok",
    },
    info: { dry_run: true, ok: validation.ok, errors: errors.length, warnings: warnings.length },
  };
}

// 🟢 Diğer pazaryerleri (Hepsiburada, N11, Çiçeksepeti, PTT AVM, Pazarama, Amazon TR)
// Sadece PROVA: pazaryeri tablosundaki kurallara göre genel kontrol yapar, HİÇBİR YERE göndermez.
// (Kategori/özellik eşleştirmesi bu pazaryerlerinde satıcı anahtarı gerektirdiği için sonra eklenecek.)
const marketplaceRulesCache = {};

async function marketplaceRules(code) {
  if (marketplaceRulesCache[code]) return marketplaceRulesCache[code];
  const { data } = await db.from("marketplaces").select("*").eq("code", code).maybeSingle();
  marketplaceRulesCache[code] = data || {};
  return marketplaceRulesCache[code];
}

async function genericProvaAdapter(action, listing) {
  const now = new Date().toISOString();

  if (action === "unpublish") {
    const validation = { ok: true, dry_run: true, action: "unpublish", errors: [], warnings: [], checked_at: now };
    return { patch: { validation, validated_at: now, last_sync_error: "prova_ok" }, info: { dry_run: true, action } };
  }

  const rules = await marketplaceRules(listing.marketplace_code);

  // Ürün, varyant, görseller
  let product = null, variant = null, images = [];
  if (listing.product_id != null) {
    const { data: p } = await db.from("products").select("*").eq("id", listing.product_id).maybeSingle();
    product = p || null;
    const { data: v } = await db
      .from("product_variants")
      .select("*")
      .eq("product_id", listing.product_id)
      .eq("is_default", true)
      .maybeSingle();
    variant = v || null;
    const { data: imgs } = await db
      .from("product_images")
      .select("url, position")
      .eq("product_id", listing.product_id)
      .order("position");
    images = (imgs || []).map((i) => i.url).filter(Boolean);
    if (!images.length && product && product.image_url) images = [product.image_url];
  }

  const errors = [];
  const warnings = [];

  // Başlık
  const title = String(listing.title || "").trim();
  const maxTitle = Number(rules.max_title_length) || 0;
  if (!title) tyIssue(errors, "title_missing", "title", "Başlık boş.");
  else if (maxTitle && title.length > maxTitle) {
    tyIssue(errors, "title_too_long", "title", "Başlık en fazla " + maxTitle + " karakter olabilir (şu an " + title.length + ").", { len: title.length, max: maxTitle });
  }

  // Açıklama
  const description = String(listing.description || "").trim();
  if (!description) tyIssue(errors, "description_missing", "description", "Açıklama boş.");

  // Fiyat ve para birimi
  const salePrice = Number(listing.price) || 0;
  if (salePrice <= 0) tyIssue(errors, "price_missing", "price", "Satış fiyatı yok.");
  const expectedCurrency = rules.currency || (String(listing.marketplace_code).endsWith("_tr") ? "TRY" : null);
  if (expectedCurrency && (listing.currency || "TRY") !== expectedCurrency) {
    tyIssue(errors, "currency_not_try", "price", "Bu pazaryerinde fiyat " + expectedCurrency + " olmalı.", { currency: listing.currency, expected: expectedCurrency });
  }

  // KDV
  if (listing.vat_rate_pct == null) tyIssue(warnings, "vat_default", "vat", "KDV oranı girilmemiş, %20 varsayıldı.");

  // Görseller
  const httpsImages = images.filter((u) => /^https:\/\//i.test(u));
  if (!httpsImages.length) tyIssue(errors, "images_missing", "images", "En az 1 görsel (https adresli) gerekli.");
  const maxImages = Number(rules.max_images) || 0;
  if (maxImages && httpsImages.length > maxImages) {
    tyIssue(warnings, "images_too_many", "images", "Bu pazaryeri en fazla " + maxImages + " görsel alır, ilk " + maxImages + "'i gönderilecek.", { max: maxImages });
  }

  // Barkod (EAN/GTIN)
  const barcode = (variant && (variant.barcode || variant.gtin)) || (product && (product.gtin || product.barcode)) || null;
  if (!barcode) {
    if (rules.requires_ean) tyIssue(errors, "barcode_missing", "barcode", "Bu pazaryeri barkod (EAN/GTIN) istiyor, üründe barkod yok.");
    else tyIssue(warnings, "barcode_generated", "barcode", "Barkod yok, gönderimde otomatik barkod kullanılacak.");
  }

  // Marka
  if (!(product && product.brand)) tyIssue(warnings, "brand_missing", "brand", "Üründe marka bilgisi yok.");

  // Stok
  if (!product || product.stock_qty == null) tyIssue(warnings, "stock_unknown", "stock", "Stok bilgisi yok.");
  else if (Number(product.stock_qty) <= 0) tyIssue(warnings, "stock_zero", "stock", "Stok 0, ürün satışa kapalı açılır.");

  // Bağlantı
  if (!listing.connection_id) tyIssue(warnings, "no_connection", "connection", "Mağaza bağlantısı yok; sadece prova yapılabilir.");

  // Kategori/özellik eşleştirmesi henüz yok
  tyIssue(warnings, "category_unchecked", "category", "Kategori ve zorunlu özellikler mağaza bağlanınca kontrol edilecek.");

  const validation = {
    ok: errors.length === 0,
    dry_run: true,
    action: "publish",
    marketplace: listing.marketplace_code,
    errors,
    warnings,
    checked_at: now,
  };

  return {
    patch: {
      validation,
      validated_at: now,
      last_sync_error: errors.length ? "prova_failed" : "prova_ok",
    },
    info: { dry_run: true, ok: validation.ok, errors: errors.length, warnings: warnings.length },
  };
}

// 🟡 Amazon (TR + Global; SP-API Listings Items)
// Bağlantı yoksa / Amazon uygulaması tanımlı değilse genel prova. Bağlantıda dry_run açıksa (varsayılan) Amazon'un
// kendi kontrolü (VALIDATION_PREVIEW) çalışır, hiçbir şey yayınlanmaz. Sandbox bağlantısı sandbox uç noktasına gider.
async function amazonAdapter(action, listing) {
  const now = new Date().toISOString();
  const market = marketByCode(listing.marketplace_code);
  let conn = null;
  if (listing.connection_id) {
    const { data } = await db.from("store_connections").select("id, status, environment, external_seller_id, settings").eq("id", listing.connection_id).maybeSingle();
    conn = data || null;
  }
  if (!market || !conn || conn.status !== "connected" || !amazonConfigured()) return genericProvaAdapter(action, listing);
  const { data: cred } = await db.rpc("store_connection_get_credentials", { p_connection_id: conn.id });
  if (!cred || !cred.refresh_token) throw new Error("amazon_credentials_missing");
  // Test kullanıcısının sandbox bağlantısı: Amazon cevapları benzetimden (amazon-sim.ts), geri kalan her şey gerçek
  const ctx = { region: cred.region || market.region, refreshToken: cred.refresh_token, sandbox: conn.environment === "sandbox",
    simulate: conn.environment === "sandbox" && (conn.settings || {}).simulate === true };
  const sellerId = conn.external_seller_id || cred.seller_id;
  const preview = (conn.settings || {}).dry_run !== false;

  if (action === "unpublish") {
    if (preview) {
      const validation = { ...(listing.validation || {}), ok: true, dry_run: true, action: "unpublish", note: "Amazon'da stok 0 yapılarak satışa kapatılır.", checked_at: now };
      return { patch: { validation, validated_at: now, last_sync_error: "prova_ok" }, info: { dry_run: true, action } };
    }
    const n = await withdrawListing(ctx, sellerId, market, listing);
    return { patch: { validated_at: now }, info: { withdrawn: n } };
  }

  let product = null, variants = [], images = [];
  if (listing.product_id != null) {
    const { data: p } = await db.from("products").select("*").eq("id", listing.product_id).maybeSingle();
    product = p || null;
    const { data: v } = await db.from("product_variants").select("*").eq("product_id", listing.product_id).is("deleted_at", null).order("created_at");
    variants = v || [];
    const { data: imgs } = await db.from("product_images").select("url, position").eq("product_id", listing.product_id).order("position");
    images = (imgs || []).map((i) => i.url).filter(Boolean);
    if (!images.length && product && product.image_url) images = [product.image_url];
  }
  if (!product) throw new Error("product_not_found");

  // Pazar kuralları (başlık sınırı) + zarar kontrolü için maliyet pazar para biriminde
  const { data: mk } = await db.from("marketplaces").select("max_title_length, default_commission_pct").eq("code", listing.marketplace_code).maybeSingle();
  let unitCost = null;
  const cost = Number(product.supplier_price) || 0;
  if (cost > 0) {
    const from = product.cost_currency || "TRY";
    if (from === market.currency) unitCost = cost;
    else {
      const { data: k } = await db.rpc("fx_rate", { p_from: from, p_to: market.currency, p_date: null });
      if (Number(k) > 0) unitCost = Math.round(cost * Number(k) * 100) / 100;
    }
  }
  const r = await submitListing({ db, ctx, market, sellerId, listing, product, variants, images, stockQty: product.stock_qty, preview,
    // Ana görsel düzeltme ayrı çağrıda (amazon-connect prepare_images): bu işçinin işlemci süresini yemez, ürünün tüm pazarları tek sonucu paylaşır
    prepareImagesFn: async (urls) => {
      const r = await fetch(SUPABASE_URL + "/functions/v1/amazon-connect", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + (Deno.env.get("SUPABASE_ANON_KEY") ?? "") },
        body: JSON.stringify({ action: "prepare_images", urls, pathPrefix: `amazon/${listing.user_id}/${product.id}`, cronSecret: CRON_SECRET }),
        signal: AbortSignal.timeout(100000),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !Array.isArray(d.images)) throw new Error("görsel hazırlığı: " + (d?.error || r.status));
      return d;
    },
    upload: storageUploader(db), imagePrefix: `amazon/${listing.user_id}/${product.id}`, maxTitle: mk?.max_title_length || 200,
    commissionPct: listing.commission_pct ?? mk?.default_commission_pct ?? 15, unitCost });
  const validation = {
    ok: r.ok, dry_run: preview, action: "publish", marketplace: listing.marketplace_code, errors: r.errors, warnings: r.warnings,
    amazon: r.amazon, checked_at: now,
  };
  // Amazon kataloğunda eşleşen ürünün barkodu: üründe yoksa yazılır (diğer pazaryerleri de kullanır)
  if (r.amazon.foundGtin && !product.gtin) await db.from("products").update({ gtin: r.amazon.foundGtin }).eq("id", product.id).is("gtin", null);
  const amzSkus: any[] = Array.isArray(r.amazon.skus) ? r.amazon.skus : [];
  const main = amzSkus.find((x) => x.parent) || amzSkus[0];
  return {
    patch: {
      validation, validated_at: now,
      last_sync_error: preview ? (r.ok ? "prova_ok" : "prova_failed") : (r.ok ? null : "amazon_rejected"),
      external_listing_id: main ? main.sku : listing.external_listing_id,
      ...(r.amazon.url ? { external_url: r.amazon.url } : {}),
      ...(Number((r.amazon.fees as any)?.pct) > 0 ? { commission_pct: (r.amazon.fees as any).pct } : {}), // Amazon'un gerçek kesintisi (zarar kontrolü bununla)
      ...(!preview && r.ok && !listing.published_at ? { published_at: now } : {}),
    },
    info: { dry_run: preview, ok: r.ok, errors: r.errors.length, warnings: r.warnings.length, skus: r.skus.length },
  };
}

// 🟠 Etsy: büyük dosyalar (5 × 20 MB) yüzünden her ilan ayrı çağrıda (etsy-listings) arka planda gönderilir
async function etsyAdapter(action, listing) {
  const call = fetch(SUPABASE_URL + "/functions/v1/etsy-listings", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + (Deno.env.get("SUPABASE_ANON_KEY") ?? "") },
    body: JSON.stringify({ action: action === "publish" ? "push" : "deactivate", listingId: listing.id, cronSecret: CRON_SECRET }),
  }).then((r) => r.body?.cancel()).catch((e) => console.error("etsy", String(e)));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(call); else await call;
  return { patch: { last_sync_error: action === "publish" ? "etsy_sending" : listing.last_sync_error }, info: { handed_off: "etsy-listings", action } };
}

// 🟣 Trendruum (_shared/trendruum.ts). TRENDRUUM_ENABLED yoksa / bağlantı canlı ve bağlı değilse yalnız PROVA (hiçbir şey gönderilmez).
// Canlıda: kategori (önceki benzer ilandan öğrenilir, yoksa AI en alt kategoriyi seçer), marka (Trendruum listesinden), zorunlu nitelikler
// (üründen + AI) tek seferde doldurulur, seçenekler ayrı barkodla aynı ana kodda gruplanır. İçerik değişmediyse ve iş stok / fiyat
// değişikliğiyse yalnız fiyat-stok güncellenir (AI yok, saniyeler). Satıştan kaldırma = stok 0.
async function trendruumAdapter(action, listing, opts) {
  const now = new Date().toISOString();
  let conn = null;
  if (listing.connection_id) {
    const { data } = await db.from("store_connections").select("id, user_id, status, environment, settings").eq("id", listing.connection_id).maybeSingle();
    conn = data || null;
  }
  let product = null, variants = [], images = [];
  if (listing.product_id != null) {
    const { data: p } = await db.from("products").select("*").eq("id", listing.product_id).maybeSingle();
    product = p || null;
    const { data: v } = await db.from("product_variants").select("*").eq("product_id", listing.product_id).is("deleted_at", null).order("created_at");
    variants = v || [];
    const { data: imgs } = await db.from("product_images").select("url, position").eq("product_id", listing.product_id).order("position");
    images = (imgs || []).map((i) => i.url).filter(Boolean);
    if (!images.length && product && product.image_url) images = [product.image_url];
  }
  const args = { listing, product, variants, images };
  const { errors, warnings } = localChecks(args);
  const live = trendruumEnabled() && conn && conn.status === "connected" && conn.environment === "live" && (await featureEnabled(listing.user_id, "trendruum"));

  if (!live) {
    if (!trendruumEnabled()) warnings.push({ code: "trendruum_off", field: "connection", msg: "Trendruum entegrasyonu henüz açılmadı; ilan prova olarak kontrol edildi, gönderilmedi." });
    else if (!conn) warnings.push({ code: "no_connection", field: "connection", msg: "Trendruum mağaza bağlantısı yok; sadece prova yapılabilir." });
    else if (conn.status !== "connected") warnings.push({ code: "connection_pending", field: "connection", msg: "Trendruum bağlantısı henüz doğrulanmadı." });
    const validation = { ok: action === "unpublish" || errors.length === 0, dry_run: true, action, marketplace: listing.marketplace_code, errors: action === "unpublish" ? [] : errors, warnings, checked_at: now };
    return { patch: { validation, validated_at: now, last_sync_error: validation.ok ? "prova_ok" : "prova_failed" }, info: { dry_run: true, ok: validation.ok } };
  }

  const { data: cred } = await db.rpc("store_connection_get_credentials", { p_connection_id: conn.id });
  const ctx = { creds: credsFromVault(cred), env: "live" as const };
  const prev = (listing.validation && listing.validation.trendruum) || {};

  if (action === "unpublish") {
    const barcodes = Array.isArray(prev.barcodes) ? prev.barcodes : [];
    if (barcodes.length) await updatePriceStock(ctx, barcodes.map((b) => ({ barcode: b, quantity: 0, salePrice: Number(listing.price) || 0, listPrice: Math.max(Number(listing.price) || 0, Number(listing.compare_at_price) || 0) })));
    const validation = { ...(listing.validation || {}), ok: true, dry_run: false, action, note: "Trendruum'da stok 0 yapılarak satışa kapatıldı.", checked_at: now };
    return { patch: { validation, validated_at: now }, info: { withdrawn: barcodes.length } };
  }
  if (!product) throw new Error("product_not_found");
  if (errors.length) {
    const validation = { ok: false, dry_run: false, action, marketplace: listing.marketplace_code, errors, warnings, trendruum: prev, checked_at: now };
    return { patch: { validation, validated_at: now, last_sync_error: "trendruum_rejected" }, info: { ok: false, errors: errors.length } };
  }

  const facts = { title: String(listing.title || ""), description: String(listing.description || ""), brand: product.brand, specs: product.specs, categoryHint: listing.category_key };
  const contentHash = JSON.stringify([listing.title, listing.description, images, product.brand, product.specs, listing.category_key, listing.marketplace_category_id, listing.marketplace_brand_id, variants.map((v) => [v.id, v.attributes, v.gtin, v.sku, v.image_url])]);
  const sameContent = prev.contentHash === contentHash && Array.isArray(prev.barcodes) && prev.barcodes.length > 0 && prev.categoryId != null;
  const job = opts && opts.job;

  // Hızlı yol: içerik aynı -> yalnız fiyat / stok
  if (sameContent && (job?.payload?.reason === "stock" || prev.status === "ok")) {
    const items = buildItems(args, { categoryId: prev.categoryId, brandId: prev.brandId, attributes: prev.attributes || [], perVariant: prev.perVariant || {} });
    const batchId = await updatePriceStock(ctx, items);
    const validation = { ...(listing.validation || {}), ok: true, dry_run: false, action, warnings, checked_at: now, trendruum: { ...prev, priceStockBatchId: batchId, priceStockAt: now } };
    return { patch: { validation, validated_at: now, last_sync_error: null }, info: { priceStock: items.length } };
  }

  // Tam yol: kategori -> marka -> nitelikler -> gönder
  let learned = prev.categoryId ?? (listing.marketplace_category_id || null);
  if (learned == null && listing.category_key) {
    const { data: same } = await db.from("listings").select("validation").eq("user_id", listing.user_id).eq("marketplace_code", listing.marketplace_code)
      .eq("category_key", listing.category_key).neq("id", listing.id).not("validation->trendruum->categoryId", "is", null).limit(1).maybeSingle();
    learned = same?.validation?.trendruum?.categoryId ?? null;
  }
  const cat = await pickCategory(ctx, facts, learned);
  if (!cat) errors.push({ code: "category_missing", field: "category", msg: "Uygun Trendruum kategorisi bulunamadı." });
  const brand = listing.marketplace_brand_id ? { id: listing.marketplace_brand_id, name: listing.marketplace_brand_name } : await findBrand(ctx, product.brand);
  if (!brand) errors.push({ code: "brand_not_listed", field: "brand", msg: product.brand ? `"${product.brand}" markası Trendruum listesinde yok; Trendruum'dan marka talebi gerekir.` : "Üründe marka yok; Trendruum marka ister." });
  let attributes = [];
  const perVariant = {};
  if (cat) {
    const all = await categoryAttributes(ctx, cat.id);
    const common = await fillAttributes(all.filter((a) => !a.varianter), facts);
    attributes = common.list;
    const missing = [...common.missing];
    const varianters = all.filter((a) => a.varianter);
    const options = variants.filter((x) => !x.is_default && x.is_active !== false);
    if (varianters.length && options.length > 1) {
      for (const v of options) {
        const r = await fillAttributes(varianters, facts, v.attributes || {});
        perVariant[String(v.id)] = r.list;
        for (const m of r.missing) if (!missing.includes(m)) missing.push(m);
      }
    } else if (varianters.length) {
      const r = await fillAttributes(varianters, facts, (options[0] || variants[0] || {}).attributes || {});
      attributes = [...attributes, ...r.list];
      for (const m of r.missing) if (!missing.includes(m)) missing.push(m);
    }
    if (missing.length) errors.push({ code: "attributes_missing", field: "attributes", msg: "Doldurulamayan zorunlu nitelik: " + missing.join(", "), params: { missing } });
  }
  const meta = { categoryId: cat?.id ?? null, categoryPath: cat?.path ?? null, brandId: brand?.id ?? null, brandName: brand?.name ?? null, attributes, perVariant, contentHash };
  if (errors.length) {
    const validation = { ok: false, dry_run: false, action, marketplace: listing.marketplace_code, errors, warnings, trendruum: { ...prev, ...meta, status: "failed" }, checked_at: now };
    return { patch: { validation, validated_at: now, last_sync_error: "trendruum_rejected" }, info: { ok: false, errors: errors.length } };
  }
  const items = buildItems(args, { categoryId: cat.id, brandId: brand.id, attributes, perVariant });
  const r = await submitProducts(ctx, items);
  if (Array.isArray(prev.barcodes) && prev.barcodes.length) await updatePriceStock(ctx, items); // var olan üründe fiyat / stok ayrı uçtan güncellenir
  const failed = r.results.filter((x) => /fail|error|reject/.test(x.status));
  const pending = r.results.some((x) => x.status === "pending" || x.status === "in_progress");
  for (const f of failed) errors.push({ code: "trendruum_rejected", field: "trendruum", msg: `${f.barcode}: ${f.reason || "Trendruum reddetti"}` });
  const ok = failed.length === 0;
  const validation = {
    ok, dry_run: false, action, marketplace: listing.marketplace_code, errors, warnings, checked_at: now,
    trendruum: { ...meta, barcodes: items.map((i) => i.barcode), batchId: r.batchId, results: r.results, status: ok ? (pending ? "pending" : "ok") : "failed", sentAt: now },
  };
  return {
    patch: {
      validation, validated_at: now, external_batch_id: r.batchId, external_listing_id: String(items[0].productMainId),
      last_sync_error: ok ? (pending ? "trendruum_pending" : null) : "trendruum_rejected",
      ...(ok && !listing.published_at ? { published_at: now } : {}),
    },
    info: { ok, items: items.length, pending, batchId: r.batchId },
  };
}

const ADAPTERS = {
  etsy: etsyAdapter,
  own_store: ownStoreAdapter,
  trendyol_tr: trendyolAdapter,
  hepsiburada_tr: genericProvaAdapter,
  n11_tr: genericProvaAdapter,
  ciceksepeti_tr: genericProvaAdapter,
  pttavm_tr: genericProvaAdapter,
  pazarama_tr: genericProvaAdapter,
  trendruum_tr: trendruumAdapter,
};
for (const m of AMAZON_MARKETS) ADAPTERS[m.code] = amazonAdapter;

// ---------------------------------------------------------
// Tek bir işi işle
// ---------------------------------------------------------
async function processJob(job) {
  // PDF + link ile ürün yükleme parçaları: catalog-import kendi isteğinde (kendi süre sınırıyla) işler ve işi kendisi kapatır.
  // Kapatamazsa (çökme) iş 3 dk sonra claim_sync_jobs ile yeniden sıraya döner.
  if (job.job_type === "catalog_import") {
    const r = await fetch(SUPABASE_URL + "/functions/v1/catalog-import", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (Deno.env.get("SUPABASE_ANON_KEY") ?? "") },
      body: JSON.stringify({ cronSecret: CRON_SECRET, action: "run", jobId: job.id }), signal: AbortSignal.timeout(20000),
    });
    await r.body?.cancel();
    if (!r.ok) throw new Error("catalog-import HTTP " + r.status);
    return { id: job.id, outcome: "delegated", step: job.payload?.step };
  }
  if (job.job_type !== "listing_sync") {
    await db.rpc("complete_sync_job", { p_job_id: job.id, p_result: { skipped: "unknown_job_type", job_type: job.job_type } });
    return { id: job.id, outcome: "skipped", reason: "unknown_job_type" };
  }

  const { data: listing, error: lErr } = await db
    .from("listings")
    .select("*")
    .eq("id", job.listing_id)
    .maybeSingle();
  if (lErr) throw lErr;

  if (!listing) {
    await db.rpc("complete_sync_job", { p_job_id: job.id, p_result: { skipped: "listing_not_found" } });
    return { id: job.id, outcome: "skipped", reason: "listing_not_found" };
  }

  // İlanın ŞU ANKİ durumuna bak (sırada beklerken değişmiş olabilir)
  const action = (listing.status === "published" && !listing.deleted_at) ? "publish" : "unpublish";
  const adapter = ADAPTERS[listing.marketplace_code];

  if (!adapter) {
    // Bu pazaryeri için otomatik gönderim henüz yok: hata sayma, ilana not düş
    await db.from("listings").update({ last_sync_error: "adapter_not_ready" }).eq("id", listing.id);
    await db.rpc("complete_sync_job", {
      p_job_id: job.id,
      p_result: { skipped: "adapter_not_ready", marketplace: listing.marketplace_code, action },
    });
    return { id: job.id, outcome: "skipped", reason: "adapter_not_ready", marketplace: listing.marketplace_code };
  }

  const res = (await adapter(action, listing, { job })) || {};
  // Adaptör kendi durum notunu yazabilir (ör. prova sonucu), yazmazsa hata temizlenir
  const patch = Object.assign({
    last_synced_at: new Date().toISOString(),
    last_sync_error: null,
  }, res.patch || {});
  const { error: uErr } = await db.from("listings").update(patch).eq("id", listing.id);
  if (uErr) throw uErr;

  await db.rpc("complete_sync_job", {
    p_job_id: job.id,
    p_result: { ok: true, action, marketplace: listing.marketplace_code, info: res.info || null },
  });
  return { id: job.id, outcome: "done", action, marketplace: listing.marketplace_code };
}

// ---------------------------------------------------------
// Giriş noktası
// ---------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Güvenlik: sadece CRON_SECRET bilen çağırabilir.
  // Şifre hangi başlıkta / gövde alanında / adres parametresinde gelirse gelsin kabul edilir
  // (stok takibinin zamanlamasıyla aynı biçimde çağrılabilsin diye); değer birebir eşleşmeli.
  const candidates = [];
  req.headers.forEach((value) => {
    if (!value) return;
    candidates.push(value.trim());
    if (value.startsWith("Bearer ")) candidates.push(value.slice(7).trim());
  });
  const url = new URL(req.url);
  url.searchParams.forEach((value) => candidates.push(String(value).trim()));
  try {
    const b = await req.clone().json();
    if (b && typeof b === "object") {
      Object.values(b).forEach((v) => { if (typeof v === "string") candidates.push(v.trim()); });
    }
  } catch (_) { /* gövde yok */ }

  if (!CRON_SECRET || !candidates.includes(CRON_SECRET.trim())) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const started = Date.now();
  const worker = "sync-worker-" + crypto.randomUUID().slice(0, 8);
  const results = [];
  let claimed = 0;
  let graced = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() - started > TIME_BUDGET_MS) break;

    const { data: jobs, error } = await db.rpc("claim_sync_jobs", { p_limit: BATCH_SIZE, p_worker: worker });
    if (error) return json({ ok: false, error: "claim_failed", detail: errMsg(error) }, 500);
    if (!jobs || jobs.length === 0) {
      // Kuyruk boş: 6 sn bekleyip bir kez daha bak. Ürün eklenince önce mağaza ilanı, 1-2 sn sonra pazaryeri ilanları gelir;
      // tetikleyici 5 sn'de en fazla bir kez çalıştığından geç gelenler yoksa 2 dk'lık zamanlanmış çalışmayı beklerdi.
      if (!graced && Date.now() - started < TIME_BUDGET_MS - 10000) { graced = true; await new Promise((r) => setTimeout(r, 6000)); continue; }
      break;
    }
    claimed += jobs.length;

    const runJob = async (job) => {
      if (Date.now() - started > TIME_BUDGET_MS) {
        // Süre doldu: alınan ama işlenemeyen işi hata saymadan sıraya geri bırak
        await db.rpc("fail_sync_job", { p_job_id: job.id, p_error: "time_budget_exceeded" });
        results.push({ id: job.id, outcome: "requeued" });
        return;
      }
      try {
        results.push(await processJob(job));
      } catch (e) {
        const msg = errMsg(e).slice(0, 500);
        if (job.listing_id) {
          await db.from("listings").update({ last_sync_error: msg }).eq("id", job.listing_id);
        }
        await db.rpc("fail_sync_job", { p_job_id: job.id, p_error: msg });
        results.push({ id: job.id, outcome: "failed", error: msg });
      }
    };
    // HIZ KURALI: kanallara yayın PARALEL. Aynı ilanın işleri kendi içinde sırayla (yarış olmasın), farklı ilanlar aynı anda.
    const groups = new Map();
    for (const job of jobs) {
      const k = job.listing_id || job.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(job);
    }
    await runPool([...groups.values()], CONCURRENCY, async (g) => { for (const job of g) await runJob(job); });

    // Kuyruk boşalana kadar yeni tur (bu sırada eklenen ilanlar bir sonraki zamanlanmış çalışmayı beklemesin; boş tur break eder)
  }

  // Süre bitti ama kuyrukta iş kaldıysa beklemeden yeni bir çalışma başlat (HIZ: 2 dk'lık görevi bekleme)
  if (Date.now() - started > TIME_BUDGET_MS || claimed >= MAX_ROUNDS * BATCH_SIZE) {
    const next = fetch(SUPABASE_URL + "/functions/v1/sync-worker", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (Deno.env.get("SUPABASE_ANON_KEY") ?? "") },
      body: JSON.stringify({ cronSecret: CRON_SECRET, chained: true }),
    }).then((r) => r.body?.cancel()).catch(() => {});
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(next);
  }

  const summary = {
    ok: true,
    worker,
    claimed,
    done: results.filter((r) => r.outcome === "done").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    ms: Date.now() - started,
    results,
  };
  console.log(JSON.stringify(summary));
  return json(summary);
});