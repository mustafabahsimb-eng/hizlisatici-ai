// =========================================================
// Amazon ilanı hazırlama ve gönderme (Listings Items API 2021-08-01 + Product Type Definitions 2020-09-01)
// Akış (HIZ KURALI: tek seferde, satıcı form doldurmaz):
//   1) Barkod (GTIN) geçerliyse katalogda ara -> ASIN varsa yalnız teklif (LISTING_OFFER_ONLY): en hızlı yol
//   2) Yoksa ürün türünü bul (searchDefinitionsProductTypes) -> şemayı al (önbellek: amazon_product_types)
//      -> zorunlu nitelikleri AI doldurur -> tam ilan (LISTING); barkod yoksa muafiyet beyanı
//   3) Seçenekli ürün: ana (parent) + her seçenek için alt (child) SKU, variation_theme şemadan
//   4) Prova (bağlantıda dry_run): mode=VALIDATION_PREVIEW -> Amazon kontrol eder, hiçbir şey yayınlanmaz
//   5) Sonraki fiyat / stok değişiklikleri: içerik aynıysa yalnız PATCH (AI yok, saniyeler)
// Üretilen nitelikler listings.validation.amazon içinde saklanır (listings.attributes'a yazılmaz; yoksa senkron döngüsü olur).
// =========================================================
import { type AmazonMarket, type Ctx, gtinType, makeSku, money, sp, SpApiError, validGtin } from "./amazon.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const AI_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-4-6"]; // hız için önce Haiku

export type Issue = { code: string; field?: string; msg: string; severity?: string };
export type BuildInput = {
  db: any; ctx: Ctx; market: AmazonMarket; sellerId: string; listing: any; product: any; variants: any[]; images: string[];
  stockQty: number | null; preview: boolean;
};

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const lang = (m: AmazonMarket) => m.locale;
const textVal = (m: AmazonMarket, value: string) => [{ value, language_tag: lang(m), marketplace_id: m.id }];
const plainVal = (m: AmazonMarket, value: unknown) => [{ value, marketplace_id: m.id }];

// ---------- Ürün türü ve şema (önbellekli: aynı tür bir daha Amazon'a sorulmaz) ----------
export async function productTypeFor(input: BuildInput): Promise<string> {
  const { db, ctx, market, product, listing } = input;
  // Satıcının önceki benzer ürünü (aynı kategori anahtarı) -> aynı tür (öğrenen sistem)
  if (listing.category_key) {
    const { data: prev } = await db.from("listings").select("validation").eq("user_id", listing.user_id).eq("marketplace_code", listing.marketplace_code)
      .eq("category_key", listing.category_key).not("validation->amazon->productType", "is", null).neq("id", listing.id).limit(1).maybeSingle();
    const t = prev?.validation?.amazon?.productType;
    if (t) return t;
  }
  const title = String(listing.title || product?.generated_title || product?.name || "").slice(0, 180);
  const words = title.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2).slice(0, 6);
  const d = await sp(ctx, "GET", "/definitions/2020-09-01/productTypes", { query: { marketplaceIds: market.id, itemName: title, locale: market.locale } })
    .catch(() => sp(ctx, "GET", "/definitions/2020-09-01/productTypes", { query: { marketplaceIds: market.id, keywords: words } }));
  const t = d?.productTypes?.[0]?.name;
  if (!t) throw new Error("Amazon ürün türü bulunamadı");
  return t;
}

export async function schemaFor(input: BuildInput, productType: string): Promise<{ required: string[]; properties: Record<string, any>; themes: string[] }> {
  const { db, ctx, market } = input;
  const { data: cached } = await db.from("amazon_product_types").select("required, properties, themes, fetched_at")
    .eq("marketplace_id", market.id).eq("product_type", productType).maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 14 * 86400_000) return cached;
  const def = await sp(ctx, "GET", `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`, {
    query: { marketplaceIds: market.id, requirements: "LISTING", locale: market.locale },
  });
  let schema: any = {};
  const link = def?.schema?.link?.resource;
  if (link && /^https:\/\//.test(link)) {
    const r = await fetch(link, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    schema = r?.ok ? await r.json().catch(() => ({})) : {};
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  // Saklanan: zorunlular + kullandığımız nitelikler (şemanın tamamı MB'larca; gerekmez)
  const keep = new Set([...required, "externally_assigned_product_identifier", "external_product_id", "supplier_declared_has_product_identifier_exemption",
    "color", "size", "variation_theme", "parentage_level", "child_parent_sku_relationship", "list_price", "country_of_origin", "bullet_point", "generic_keyword"]);
  const properties: Record<string, any> = {};
  for (const k of keep) if (schema.properties?.[k]) properties[k] = trimSchema(schema.properties[k]);
  const themes = findEnum(schema.properties?.variation_theme) || [];
  const row = { marketplace_id: market.id, product_type: productType, required, properties, themes, fetched_at: new Date().toISOString() };
  await db.from("amazon_product_types").upsert(row);
  return row;
}
function trimSchema(s: any, depth = 0): any {
  if (!s || typeof s !== "object" || depth > 7) return s;
  if (Array.isArray(s)) return s.slice(0, 80).map((x) => trimSchema(x, depth + 1));
  const o: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (["examples", "$comment", "editable", "hidden", "description"].includes(k)) continue;
    if ((k === "enum" || k === "enumNames") && Array.isArray(v)) { o[k] = v.slice(0, 80); continue; }
    o[k] = trimSchema(v, depth + 1);
  }
  return o;
}
function findEnum(s: any): string[] | null {
  if (!s || typeof s !== "object") return null;
  if (Array.isArray(s.enum) && s.enum.every((x: unknown) => typeof x === "string")) return s.enum;
  for (const v of Object.values(s)) { const e = findEnum(v); if (e) return e; }
  return null;
}

// ---------- AI: zorunlu nitelikleri doldur ----------
async function aiAttributes(input: BuildInput, productType: string, names: string[], props: Record<string, any>): Promise<Record<string, unknown>> {
  if (!names.length || !ANTHROPIC_API_KEY) return {};
  const { product, listing, market } = input;
  const facts = {
    title: listing.title || product?.generated_title || product?.name, description: String(listing.description || product?.generated_description || "").slice(0, 2500),
    brand: product?.brand, model: product?.model_code, specs: product?.specs, weight_kg: product?.weight_kg,
    dimensions_cm: [product?.length_cm, product?.width_cm, product?.height_cm], country_of_origin: product?.country_of_origin,
    bullet_points: listing.bullet_points,
  };
  const schemas = Object.fromEntries(names.map((n) => [n, JSON.stringify(props[n] || {}).slice(0, 2500)]));
  const system = `You fill Amazon SP-API Listings Items attributes. Output ONLY a JSON object: keys = attribute names, values = arrays exactly in the Amazon attribute format described by each JSON schema. Use marketplace_id "${market.id}" and language_tag "${market.locale}" where the schema has them. Write texts in the marketplace language (${market.locale}). Choose enum values only from the schema. Never invent safety certifications; for unknown numeric facts choose conservative realistic values. Product type: ${productType}.`;
  const user = `Product facts:\n${JSON.stringify(facts)}\n\nAttributes to fill (schemas):\n${JSON.stringify(schemas)}`;
  for (const model of AI_MODELS) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 6000, system, messages: [{ role: "user", content: user }] }), signal: AbortSignal.timeout(60000),
      });
      const d = await r.json();
      if (!r.ok) continue;
      const text = (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch (_) { /* sonraki model */ }
  }
  return {};
}

// ---------- Ortak nitelikler (kesin bilgiler; AI'ya bırakılmaz) ----------
function offerAttrs(m: AmazonMarket, price: number, qty: number, listPrice?: number | null) {
  const a: Record<string, unknown> = {
    condition_type: [{ value: "new_new", marketplace_id: m.id }],
    purchasable_offer: [{ marketplace_id: m.id, currency: m.currency, our_price: [{ schedule: [{ value_with_tax: money(price) }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: Math.max(0, Math.floor(qty)) }],
  };
  if (listPrice && listPrice > price) a.list_price = [{ marketplace_id: m.id, currency: m.currency, value_with_tax: money(listPrice) }];
  return a;
}
function identifierAttrs(m: AmazonMarket, gtin: string | null, props: Record<string, any>) {
  if (gtin && validGtin(gtin)) {
    const type = gtinType(gtin)!;
    if (props.externally_assigned_product_identifier || !props.external_product_id) return { externally_assigned_product_identifier: [{ type, value: gtin, marketplace_id: m.id }] };
    return { external_product_id: [{ type, value: gtin, marketplace_id: m.id }] };
  }
  // Barkod yok: marka GTIN muafiyeti beyanı (Amazon'da markaya muafiyet onaylıysa geçer; değilse Amazon uyarı döner)
  return { supplier_declared_has_product_identifier_exemption: [{ value: true, marketplace_id: m.id }] };
}
function contentAttrs(m: AmazonMarket, input: BuildInput) {
  const { listing, product, images } = input;
  const a: Record<string, unknown> = {
    item_name: textVal(m, String(listing.title || product?.generated_title || product?.name || "").slice(0, 200)),
    brand: textVal(m, String(product?.brand || "Generic").slice(0, 50)),
    product_description: textVal(m, String(listing.description || product?.generated_description || "").replace(/<[^>]+>/g, " ").slice(0, 2000)),
  };
  const bullets = (Array.isArray(listing.bullet_points) ? listing.bullet_points : []).map(String).filter(Boolean).slice(0, 5);
  if (bullets.length) a.bullet_point = bullets.map((b) => ({ value: b.slice(0, 500), language_tag: m.locale, marketplace_id: m.id }));
  const kw = (Array.isArray(listing.keywords) ? listing.keywords : []).map(String).join(" ").slice(0, 250);
  if (kw) a.generic_keyword = textVal(m, kw);
  const imgs = images.filter((u) => /^https:\/\//i.test(u)).slice(0, 9);
  if (imgs[0]) a.main_product_image_locator = [{ media_location: imgs[0], marketplace_id: m.id }];
  imgs.slice(1).forEach((u, i) => { a[`other_product_image_locator_${i + 1}`] = [{ media_location: u, marketplace_id: m.id }]; });
  if (product?.country_of_origin) a.country_of_origin = plainVal(m, String(product.country_of_origin).toUpperCase());
  return a;
}

// Seçenek adları -> Amazon nitelik / tema
const OPT = (k: string) => {
  const s = k.toLowerCase();
  if (/(size|beden|numara|boyut)/.test(s)) return "size";
  if (/(colou?r|renk)/.test(s)) return "color";
  return null;
};
function themeFor(variants: any[], themes: string[]): string | null {
  const keys = new Set<string>();
  for (const v of variants) for (const k of Object.keys(v.attributes || {})) { const o = OPT(k); if (o) keys.add(o); }
  const want = keys.has("size") && keys.has("color") ? ["SIZE/COLOR", "SIZE_COLOR", "COLOR_SIZE", "COLOR/SIZE"] : keys.has("size") ? ["SIZE", "SIZE_NAME"] : keys.has("color") ? ["COLOR", "COLOR_NAME"] : [];
  for (const w of want) { const f = themes.find((t) => t.toUpperCase() === w); if (f) return f; }
  return want.length && !themes.length ? want[0] : null;
}
function variantOptionAttrs(m: AmazonMarket, v: any) {
  const a: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v.attributes || {})) {
    const o = OPT(k);
    if (o && val != null && String(val).trim()) a[o] = textVal(m, String(val).slice(0, 50));
  }
  return a;
}

// ---------- Ana işlev: bir ilanı Amazon'a gönder (ya da prova et) ----------
export type SubmitResult = { ok: boolean; preview: boolean; skus: { sku: string; status?: string; submissionId?: string; issues: Issue[] }[]; amazon: Record<string, unknown>; errors: Issue[]; warnings: Issue[] };

export async function submitListing(input: BuildInput): Promise<SubmitResult> {
  const { ctx, market, sellerId, listing, product, preview } = input;
  const prev = listing.validation?.amazon || {};
  const active = (input.variants || []).filter((v) => v.is_active !== false && !v.deleted_at);
  const multi = active.length > 1;
  const price = Number(listing.price) || 0;
  const qty = Math.max(0, Number(input.stockQty ?? product?.stock_qty ?? 0));
  const gtin = String(product?.gtin || active.find((v) => v.is_default)?.gtin || "").replace(/\D/g, "") || null;
  const errors: Issue[] = [], warnings: Issue[] = [];
  if (price <= 0) errors.push({ code: "price_missing", field: "price", msg: "Satış fiyatı yok." });
  if (!input.images.some((u) => /^https:\/\//i.test(u))) errors.push({ code: "images_missing", field: "images", msg: "En az 1 görsel gerekli." });
  if (errors.length) return { ok: false, preview, skus: [], amazon: prev, errors, warnings };

  const contentHash = await sha(JSON.stringify([listing.title, listing.description, listing.bullet_points, listing.keywords, input.images, product?.brand, gtin,
    active.map((v) => [v.id, v.attributes, v.gtin])]));
  const query = (mode?: string) => ({ marketplaceIds: market.id, includedData: ["issues", "identifiers"], issueLocale: market.locale, ...(mode ? { mode } : {}) });
  const mode = preview ? "VALIDATION_PREVIEW" : undefined;
  const skus: SubmitResult["skus"] = [];
  const collect = (sku: string, d: any) => {
    const issues: Issue[] = (d?.issues || []).map((i: any) => ({ code: String(i.code), field: (i.attributeNames || [])[0], msg: String(i.message), severity: i.severity }));
    skus.push({ sku, status: d?.status, submissionId: d?.submissionId, issues });
    for (const i of issues) (i.severity === "ERROR" ? errors : warnings).push({ ...i, msg: `${sku}: ${i.msg}` });
  };

  // Hızlı yol: içerik değişmedi, daha önce kabul edildi -> yalnız fiyat / stok
  if (!preview && prev.hash === contentHash && prev.accepted && Array.isArray(prev.skus) && prev.skus.length) {
    for (const s of prev.skus as { sku: string; variantId?: string; parent?: boolean }[]) {
      if (s.parent) continue;
      const v = active.find((x) => x.id === s.variantId);
      const vPrice = v && product?.supplier_price && v.cost ? price * (Number(v.cost) / Number(product.supplier_price)) : price;
      const vQty = v && v.stock_qty != null ? Number(v.stock_qty) : qty;
      const patches = Object.entries(offerAttrs(market, vPrice, vQty, listing.compare_at_price)).map(([path, value]) => ({ op: "replace", path: `/attributes/${path}`, value }));
      const d = await sp(ctx, "PATCH", `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(s.sku)}`, {
        query: query(), body: { productType: prev.productType, patches },
      });
      collect(s.sku, d);
    }
    return { ok: !errors.length, preview, skus, amazon: { ...prev, syncedAt: new Date().toISOString() }, errors, warnings };
  }

  // 1) Katalogda var mı (barkodla)?
  let asin: string | null = null, productType: string | null = null;
  if (gtin && validGtin(gtin) && !multi) {
    const t = gtinType(gtin)!.toUpperCase();
    const d = await sp(ctx, "GET", "/catalog/2022-04-01/items", {
      query: { identifiers: gtin, identifiersType: t === "ISBN" ? "ISBN" : t === "UPC" ? "UPC" : t === "GTIN" ? "GTIN" : "EAN", marketplaceIds: market.id, includedData: ["summaries", "productTypes"] },
    }).catch(() => null);
    const item = d?.items?.[0];
    if (item?.asin) {
      asin = item.asin;
      productType = (item.productTypes || []).find((p: any) => p.marketplaceId === market.id)?.productType || item.productTypes?.[0]?.productType || "PRODUCT";
    }
  } else if (gtin && !validGtin(gtin)) warnings.push({ code: "gtin_invalid", field: "barcode", msg: "Barkod geçersiz (kontrol hanesi tutmuyor); barkodsuz gönderildi." });

  if (asin) {
    const sku = makeSku(product.id);
    const body = { productType, requirements: "LISTING_OFFER_ONLY", attributes: { merchant_suggested_asin: [{ value: asin, marketplace_id: market.id }], ...offerAttrs(market, price, qty, listing.compare_at_price) } };
    collect(sku, await sp(ctx, "PUT", `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`, { query: query(mode), body }));
    const amazon = { productType, asin, offerOnly: true, hash: contentHash, accepted: !preview && !errors.length, skus: [{ sku }], url: `https://${market.domain}/dp/${asin}` };
    return { ok: !errors.length, preview, skus, amazon, errors, warnings };
  }

  // 2) Tam ilan
  productType = await productTypeFor(input);
  const sch = await schemaFor(input, productType);
  const base = { ...contentAttrs(market, input), ...identifierAttrs(market, multi ? null : gtin, sch.properties) };
  const known = new Set([...Object.keys(base), "condition_type", "purchasable_offer", "fulfillment_availability", "list_price", "merchant_suggested_asin",
    "parentage_level", "child_parent_sku_relationship", "variation_theme", "color", "size", "externally_assigned_product_identifier", "external_product_id",
    "supplier_declared_has_product_identifier_exemption", "gtin_exemption_reason"]);
  const missing = sch.required.filter((n) => !known.has(n));
  // Aynı içerikle daha önce AI'nın doldurduğu nitelikler yeniden kullanılır
  const ai = prev.hash === contentHash && prev.productType === productType && prev.ai ? prev.ai : await aiAttributes(input, productType, missing, sch.properties);
  const common = { ...ai, ...base };
  if (!gtin || multi) warnings.push({ code: "gtin_exemption", field: "barcode", msg: "Barkod yok: marka için Amazon GTIN muafiyeti gerekir; muafiyet yoksa Amazon ilanı reddeder." });

  const putSku = async (sku: string, attributes: Record<string, unknown>) =>
    collect(sku, await sp(ctx, "PUT", `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`, {
      query: query(mode), body: { productType, requirements: "LISTING", attributes },
    }));

  const skuList: { sku: string; variantId?: string; parent?: boolean }[] = [];
  if (multi) {
    const theme = themeFor(active, sch.themes);
    if (!theme) warnings.push({ code: "variation_theme", field: "variants", msg: "Bu ürün türünde seçenekler için uygun Amazon teması bulunamadı; seçenekler ayrı ürün olarak gönderildi." });
    const parentSku = makeSku(product.id);
    if (theme) {
      // Ana ilan (satılmaz, seçenekleri toplar)
      await putSku(parentSku, { ...common,
        parentage_level: [{ value: "parent", marketplace_id: market.id }], variation_theme: [{ name: theme }] });
      skuList.push({ sku: parentSku, parent: true });
    }
    // Seçenekler PARALEL gönderilir (HIZ KURALI); Amazon kotasına sp() içindeki tekrar deneme uyar
    await Promise.all(active.map(async (v, i) => {
      const sku = makeSku(product.id, String(i + 1));
      const vPrice = product?.supplier_price && v.cost ? price * (Number(v.cost) / Number(product.supplier_price)) : price;
      const vQty = v.stock_qty != null ? Number(v.stock_qty) : qty;
      const attrs: Record<string, unknown> = { ...common, ...variantOptionAttrs(market, v), ...offerAttrs(market, vPrice, vQty, null),
        ...identifierAttrs(market, v.gtin ? String(v.gtin).replace(/\D/g, "") : null, sch.properties) };
      if (v.image_url && /^https:\/\//.test(v.image_url)) attrs.main_product_image_locator = [{ media_location: v.image_url, marketplace_id: market.id }];
      if (theme) {
        attrs.parentage_level = [{ value: "child", marketplace_id: market.id }];
        attrs.child_parent_sku_relationship = [{ child_relationship_type: "variation", parent_sku: parentSku, marketplace_id: market.id }];
        attrs.variation_theme = [{ name: theme }];
      }
      await putSku(sku, attrs);
      skuList.push({ sku, variantId: v.id });
    }));
  } else {
    const sku = makeSku(product.id);
    await putSku(sku, { ...common, ...offerAttrs(market, price, qty, listing.compare_at_price) });
    skuList.push({ sku, variantId: active[0]?.id });
  }
  const amazon = { productType, offerOnly: false, hash: contentHash, ai, accepted: !preview && !errors.length, skus: skuList };
  return { ok: !errors.length, preview, skus, amazon, errors, warnings };
}

// Satıştan kaldırma: stok 0 (ilan geçmişi korunur; Trendyol ile aynı yaklaşım)
export async function withdrawListing(ctx: Ctx, sellerId: string, market: AmazonMarket, listing: any) {
  const skus = (listing.validation?.amazon?.skus || []).filter((s: any) => !s.parent);
  const productType = listing.validation?.amazon?.productType || "PRODUCT";
  for (const s of skus) {
    await sp(ctx, "PATCH", `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(s.sku)}`, {
      query: { marketplaceIds: market.id },
      body: { productType, patches: [{ op: "replace", path: "/attributes/fulfillment_availability", value: [{ fulfillment_channel_code: "DEFAULT", quantity: 0 }] }] },
    }).catch((e) => { if (!(e instanceof SpApiError && e.status === 404)) throw e; });
  }
  return skus.length;
}
