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
import { aiJson, type AmazonContent, localizedContent } from "./amazon-content.ts";
import { prepareImages, type Uploader } from "./amazon-images.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const AI_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-4-6"]; // hız için önce Haiku

export type Issue = { code: string; field?: string; msg: string; severity?: string };
export type BuildInput = {
  db: any; ctx: Ctx; market: AmazonMarket; sellerId: string; listing: any; product: any; variants: any[]; images: string[];
  stockQty: number | null; preview: boolean;
  // İsteğe bağlı: pazar dilindeki metin (yoksa üretilir), görsel düzeltme için depo, başlık sınırı, komisyon (%), maliyet (pazar para biriminde)
  content?: AmazonContent | null; upload?: Uploader | null; imagePrefix?: string; maxTitle?: number | null; commissionPct?: number | null; unitCost?: number | null;
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
  const cands: { name: string; displayName?: string }[] = (d?.productTypes || []).slice(0, 6);
  if (!cands.length) throw new Error("Amazon ürün türü bulunamadı");
  if (cands.length === 1) return cands[0].name;
  // Birden çok aday: ürün adı + ana görselle AI seçer (yanlış tür = yanlış zorunlu alanlar = ret)
  const r = await aiJson(
    `You choose the single best Amazon product type for a product listing on ${market.domain}. Answer ONLY JSON {"productType":"<one of the candidate names>"}.`,
    JSON.stringify({ title, brand: product?.brand, description: String(listing.description || product?.generated_description || "").slice(0, 600),
      candidates: cands.map((c) => ({ name: c.name, displayName: c.displayName })) }),
    { imageUrl: input.images?.[0] || null, maxTokens: 100 },
  );
  const pick = r && cands.find((c) => c.name === r.productType);
  return (pick || cands[0]).name;
}

// ---------- Kategori onayı (ungating) ----------
// Amazon'da yeni satıcıya kapalı (onay / belge isteyen) ürün türleri — Amazon "Categories and products requiring approval" listesi.
// Kesin cevap ASIN'li üründe Listings Restrictions API'dan gelir; yeni üründe bu liste önceden uyarır.
export const GATED_TYPES = new Set([
  "JEWELRY", "FINE_JEWELRY", "FINENECKLACE", "FINERING", "FINEEARRING", "WATCH", "COLLECTIBLE_COIN", "SPORTS_MEMORABILIA", "TRADING_CARD", "ENTERTAINMENT_COLLECTIBLES",
  "GROCERY", "FOOD", "SNACK_FOOD_BAR", "BEVERAGE", "COFFEE", "TEA", "CANDY", "WINE", "BEER", "SPIRITS", "ALCOHOLIC_BEVERAGE", "DIETARY_SUPPLEMENT", "NUTRITIONAL_SUPPLEMENT",
  "MEDICATION", "DRUG", "OVER_THE_COUNTER_MEDICATION", "MEDICAL_SUPPLIES", "HEALTH_PERSONAL_CARE", "SEXUAL_WELLNESS", "PESTICIDE", "INSECT_REPELLENT",
  "AUTO_PART", "AUTO_ACCESSORY", "TIRE", "MUSIC_ALBUM", "VIDEO_DVD", "VIDEO_BLU_RAY", "STREAMING_MEDIA_PLAYER", "LUXURY_BEAUTY", "SKIN_CARE_AGENT", "SUNSCREEN",
  "HAIR_COLOR", "HAIR_REMOVAL_AGENT", "PET_FOOD", "TOBACCO", "ELECTRONIC_CIGARETTE", "SOLAR_PANEL", "HOVERBOARD", "FIREARM_ACCESSORY",
]);
export function gatingHint(productType: string | null, market: AmazonMarket, now = new Date()): string | null {
  const t = String(productType || "").toUpperCase();
  if (GATED_TYPES.has(t)) return `"${t}" ürün türü Amazon'da kategori onayı isteyebilir (belge / fatura). Onay yoksa ilan reddedilir.`;
  // ABD tatil dönemi oyuncak kısıtı (yeni satıcılar 1 Kasım - 31 Aralık arası satamaz)
  if (/^TOY|_TOY$|^GAME$|^PUZZLE$/.test(t) && market.country === "US" && now.getUTCMonth() >= 9) return "Amazon ABD tatil döneminde (Kasım-Aralık) yeni satıcıların oyuncak satışını kısıtlar.";
  return null;
}
export async function asinRestrictions(ctx: Ctx, sellerId: string, market: AmazonMarket, asin: string): Promise<{ approval: boolean; msg: string; link: string | null } | null> {
  const d = await sp(ctx, "GET", "/listings/2021-08-01/restrictions", {
    query: { asin, sellerId, marketplaceIds: market.id, conditionType: "new_new", reasonLocale: market.locale },
  }).catch(() => null);
  const reasons = (d?.restrictions || []).flatMap((r: any) => r.reasons || []);
  if (!reasons.length) return null;
  const r = reasons.find((x: any) => x.reasonCode === "APPROVAL_REQUIRED") || reasons[0];
  return { approval: r.reasonCode === "APPROVAL_REQUIRED" || !r.reasonCode, msg: String(r.message || "Kısıtlı ürün"), link: r.links?.[0]?.resource || null };
}

// ---------- Fiyat: pazar yuvarlaması (asla düşürmez) + zarar kontrolü ----------
export function marketPrice(price: number, market: AmazonMarket): number {
  if (!(price > 0)) return 0;
  if (["JPY", "INR"].includes(market.currency)) return Math.ceil(price); // kuruşsuz para birimleri
  const p = Math.round(price * 100) / 100;
  const cents = Math.round((p - Math.floor(p)) * 100);
  return cents === 99 ? p : money(Math.ceil(p + 0.0001) - 0.01);
}

export async function schemaFor(input: BuildInput, productType: string): Promise<{ required: string[]; properties: Record<string, any>; themes: string[] }> {
  const { db, ctx, market } = input;
  const { data: cached } = await db.from("amazon_product_types").select("required, properties, themes, fetched_at")
    .eq("marketplace_id", market.id).eq("product_type", productType).maybeSingle();
  if (!ctx.simulate && cached && Date.now() - new Date(cached.fetched_at).getTime() < 14 * 86400_000) return cached;
  const def = await sp(ctx, "GET", `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`, {
    query: { marketplaceIds: market.id, requirements: "LISTING", locale: market.locale },
  });
  let schema: any = def?.simulatedSchema || {}; // benzetim (amazon-sim.ts) şemayı doğrudan verir
  const link = def?.simulatedSchema ? null : def?.schema?.link?.resource;
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
  if (!ctx.simulate) await db.from("amazon_product_types").upsert(row); // benzetim şeması gerçek önbelleğe yazılmaz
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

// ---------- Barkodsuz ürün: Amazon kataloğunda aynı ürünü bul (marka + model; gerekirse AI onayı) ----------
// Bulunursa yalnız teklif açılır (en hızlı yol) ve katalogdaki barkod (EAN/UPC) ürüne yazılır.
const norm = (s: unknown) => String(s ?? "").toLocaleLowerCase("tr").normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
const tokens = (s: unknown) => new Set(String(s ?? "").toLocaleLowerCase("tr").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
export function catalogScore(product: any, title: string, item: any): number {
  const sum = item?.summaries?.[0] || {};
  const brandOk = !!product?.brand && norm(sum.brand || sum.brandName) === norm(product.brand);
  if (!brandOk) return 0;
  const model = norm(product?.model_code);
  if (model.length >= 4 && (norm(sum.itemName).includes(model) || norm(sum.modelNumber) === model || norm(sum.partNumber) === model)) return 1;
  const a = tokens(title), b = tokens(sum.itemName);
  const inter = [...a].filter((w) => b.has(w)).length;
  return inter / Math.max(1, Math.min(a.size, b.size));
}
async function aiSameProduct(title: string, product: any, item: any): Promise<boolean> {
  if (!ANTHROPIC_API_KEY) return false;
  const sum = item?.summaries?.[0] || {};
  const q = `Our product: ${JSON.stringify({ title, brand: product?.brand, model: product?.model_code, specs: product?.specs })}\nAmazon item: ${JSON.stringify({ name: sum.itemName, brand: sum.brand, model: sum.modelNumber, color: sum.color, size: sum.size })}\nIs this exactly the same product (same model, same size/variant)? Answer only YES or NO.`;
  for (const model of AI_MODELS) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: q }] }), signal: AbortSignal.timeout(20000),
      });
      const d = await r.json();
      if (!r.ok) continue;
      return /^\s*yes/i.test((d?.content || []).map((c: any) => c.text || "").join(""));
    } catch (_) { /* sonraki model */ }
  }
  return false;
}
export async function matchCatalog(input: BuildInput): Promise<{ asin: string; productType: string; gtin: string | null } | null> {
  const { ctx, market, product, listing } = input;
  if (!product?.brand) return null;
  const title = String(listing.title || product?.generated_title || product?.name || "");
  const kw = [product.brand, product.model_code || title.split(/\s+/).slice(0, 5).join(" ")].filter(Boolean).map(String);
  const d = await sp(ctx, "GET", "/catalog/2022-04-01/items", {
    query: { keywords: kw, marketplaceIds: market.id, includedData: ["summaries", "identifiers", "productTypes"], pageSize: "5", locale: market.locale },
  }).catch(() => null);
  const items: any[] = d?.items || [];
  let best: any = null, bestScore = 0;
  for (const it of items) { const sc = catalogScore(product, title, it); if (sc > bestScore) { best = it; bestScore = sc; } }
  if (!best || bestScore < 0.5) return null;
  if (bestScore < 1 && !(await aiSameProduct(title, product, best))) return null; // emin değilse AI onayı; yoksa eşleme yapılmaz
  const ids = (best.identifiers || []).find((x: any) => x.marketplaceId === market.id)?.identifiers || best.identifiers?.[0]?.identifiers || [];
  const g = ids.find((x: any) => ["EAN", "UPC", "GTIN"].includes(String(x.identifierType).toUpperCase()))?.identifier || null;
  const pt = (best.productTypes || []).find((p: any) => p.marketplaceId === market.id)?.productType || best.productTypes?.[0]?.productType || "PRODUCT";
  return { asin: best.asin, productType: pt, gtin: g && validGtin(g) ? String(g) : null };
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
  const c = input.content;
  const a: Record<string, unknown> = {
    item_name: textVal(m, String(c?.title || listing.title || product?.generated_title || product?.name || "").slice(0, 200)),
    brand: textVal(m, String(product?.brand || "Generic").slice(0, 50)),
    product_description: textVal(m, String(c?.description || listing.description || product?.generated_description || "").replace(/<[^>]+>/g, " ").slice(0, 2000)),
  };
  const bullets = (c?.bullets?.length ? c.bullets : Array.isArray(listing.bullet_points) ? listing.bullet_points : []).map(String).filter(Boolean).slice(0, 5);
  if (bullets.length) a.bullet_point = bullets.map((b) => ({ value: b.slice(0, 500), language_tag: m.locale, marketplace_id: m.id }));
  const kw = c ? c.keywords : (Array.isArray(listing.keywords) ? listing.keywords : []).map(String).join(" ").slice(0, 250);
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

// ---------- Amazon kesintisi (Product Fees API): komisyon + sabit ücretler, satıcı kargolu (FBM) ----------
// ASIN'li üründe teklif açmadan önce, yeni üründe ilan kabul edilince SKU ile sorulur. Sonuç: toplam kesinti ve fiyata oranı (%).
export async function feesEstimate(ctx: Ctx, market: AmazonMarket, id: { asin?: string; sku?: string }, price: number): Promise<{ total: number; pct: number; details: { type: string; amount: number }[] } | null> {
  if (!(price > 0) || (!id.asin && !id.sku)) return null;
  const path = id.asin ? `/products/fees/v0/items/${encodeURIComponent(id.asin)}/feesEstimate` : `/products/fees/v0/listings/${encodeURIComponent(id.sku!)}/feesEstimate`;
  const d = await sp(ctx, "POST", path, { body: { FeesEstimateRequest: {
    MarketplaceId: market.id, IsAmazonFulfilled: false, Identifier: "slt-" + (id.asin || id.sku),
    PriceToEstimateFees: { ListingPrice: { CurrencyCode: market.currency, Amount: money(price) }, Shipping: { CurrencyCode: market.currency, Amount: 0 } },
  } } }).catch(() => null);
  const r = d?.payload?.FeesEstimateResult;
  const total = Number(r?.FeesEstimate?.TotalFeesEstimate?.Amount);
  if (r?.Status !== "Success" || !Number.isFinite(total)) return null;
  const details = (r.FeesEstimate.FeeDetailList || []).map((f: any) => ({ type: String(f.FeeType), amount: Number(f.FinalFee?.Amount ?? f.FeeAmount?.Amount) || 0 }));
  return { total: money(total), pct: Math.round(total / price * 10000) / 100, details };
}

// ---------- Ana işlev: bir ilanı Amazon'a gönder (ya da prova et) ----------
export type SubmitResult = { ok: boolean; preview: boolean; skus: { sku: string; status?: string; submissionId?: string; issues: Issue[] }[]; amazon: Record<string, unknown>; errors: Issue[]; warnings: Issue[] };

// Amazon'un ret nedeni -> otomatik düzeltilebilir mi?
const APPROVAL_RE = /approval|approve|gated|restricted|onay|genehmigung|autorisation|aprobación|approvazione/i;
const GTIN_RE = /gtin|upc|ean|barcode|barkod|product.?id|exemption|muafiyet/i;
const FIX_SKIP = new Set(["externally_assigned_product_identifier", "external_product_id", "supplier_declared_has_product_identifier_exemption", "merchant_suggested_asin",
  "purchasable_offer", "fulfillment_availability", "condition_type", "parentage_level", "child_parent_sku_relationship", "variation_theme"]);
export function classifyIssue(i: Issue): "approval" | "gtin" | "image" | "attribute" | "other" {
  if (APPROVAL_RE.test(i.msg)) return "approval";
  if ((i.field && /identifier|external_product_id/.test(i.field)) || GTIN_RE.test(i.msg)) return "gtin";
  if (i.field && /image_locator/.test(i.field)) return "image";
  if (i.field && !FIX_SKIP.has(i.field)) return "attribute";
  return "other";
}
// Reddedilen nitelikleri Amazon'un hata metniyle birlikte AI'ya yeniden doldurt
async function aiFixAttributes(input: BuildInput, productType: string, issues: Issue[], attrs: Record<string, unknown>, props: Record<string, any>): Promise<Record<string, unknown>> {
  const names = [...new Set(issues.map((i) => i.field!).filter(Boolean))];
  if (!names.length) return {};
  const { market, product, listing } = input;
  const r = await aiJson(
    `You fix rejected Amazon SP-API Listings Items attributes for product type ${productType} on ${market.domain}. Output ONLY a JSON object: keys = attribute names to replace, values = arrays exactly in Amazon attribute format (marketplace_id "${market.id}", language_tag "${market.locale}" where applicable). Choose enum values only from the schema. Fix exactly what Amazon's error says. Never invent certifications.`,
    JSON.stringify({ errors: issues.map((i) => ({ attribute: i.field, message: i.msg })), current: Object.fromEntries(names.map((n) => [n, attrs[n] ?? null])),
      schemas: Object.fromEntries(names.map((n) => [n, JSON.stringify(props[n] || {}).slice(0, 2500)])),
      product: { title: input.content?.title || listing.title, brand: product?.brand, model: product?.model_code, specs: product?.specs, weight_kg: product?.weight_kg,
        dimensions_cm: [product?.length_cm, product?.width_cm, product?.height_cm] } }),
    { maxTokens: 3000 },
  );
  if (!r || typeof r !== "object") return {};
  return Object.fromEntries(Object.entries(r).filter(([k, v]) => names.includes(k) && Array.isArray(v)));
}

export async function submitListing(input: BuildInput): Promise<SubmitResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const lap = (k: string, from: number) => { timings[k] = (timings[k] || 0) + (Date.now() - from); };
  const { ctx, market, sellerId, listing, product, preview } = input;
  const prev = listing.validation?.amazon || {};
  const active = (input.variants || []).filter((v) => v.is_active !== false && !v.deleted_at);
  const multi = active.length > 1;
  const price = marketPrice(Number(listing.price) || 0, market);
  const qty = Math.max(0, Number(input.stockQty ?? product?.stock_qty ?? 0));
  let gtin = String(product?.gtin || active.find((v) => v.is_default)?.gtin || "").replace(/\D/g, "") || null;
  const errors: Issue[] = [], warnings: Issue[] = [];
  if (price <= 0) errors.push({ code: "price_missing", field: "price", msg: "Satış fiyatı yok." });
  if (!input.images.some((u) => /^https:\/\//i.test(u))) errors.push({ code: "images_missing", field: "images", msg: "En az 1 görsel gerekli." });
  // Zarar kontrolü (kapatılamaz): fiyat - Amazon komisyonu - maliyet < 0 ise gönderilmez
  const commission = Number(input.commissionPct ?? listing.commission_pct ?? 15);
  if (price > 0 && input.unitCost != null && input.unitCost > 0 && price - price * commission / 100 - input.unitCost < 0) {
    errors.push({ code: "loss", field: "price", msg: `Zarar: ${price} ${market.currency} fiyattan Amazon komisyonu (%${commission}) ve maliyet (${money(input.unitCost)} ${market.currency}) düşünce kâr eksi.` });
  }
  if (errors.length) return { ok: false, preview, skus: [], amazon: prev, errors, warnings };
  // Barkod ön kontrolü: GS1'in mağaza içi (dahili) önekleri Amazon'da geçmez -> barkodsuz yol
  if (gtin && validGtin(gtin) && internalGtin(gtin)) {
    warnings.push({ code: "gtin_internal", field: "barcode", msg: "Barkod mağaza içi (GS1 dahili önek: 02 / 04 / 2xx); Amazon kabul etmez, barkodsuz gönderildi." });
    gtin = null;
  }

  const contentHash = await sha(JSON.stringify([listing.title, listing.description, listing.bullet_points, listing.keywords, input.images, product?.brand, gtin,
    active.map((v) => [v.id, v.attributes, v.gtin])]));
  const query = (mode?: string) => ({ marketplaceIds: market.id, includedData: ["issues", "identifiers"], issueLocale: market.locale, ...(mode ? { mode } : {}) });
  const mode = preview ? "VALIDATION_PREVIEW" : undefined;
  const skus: SubmitResult["skus"] = [];
  const collect = (sku: string, d: any) => {
    const issues: Issue[] = (d?.issues || []).map((i: any) => ({ code: String(i.code), field: (i.attributeNames || [])[0], msg: String(i.message), severity: i.severity }));
    const at = skus.findIndex((x) => x.sku === sku);
    const row = { sku, status: d?.status, submissionId: d?.submissionId, issues };
    if (at >= 0) skus[at] = row; else skus.push(row);
    return issues;
  };
  const finish = () => {
    for (const s of skus) for (const i of s.issues) (i.severity === "ERROR" ? errors : warnings).push({ ...i, msg: `${s.sku}: ${i.msg}` });
  };

  // Hızlı yol: içerik değişmedi, daha önce kabul edildi, Amazon'da açık hata yok -> yalnız fiyat / stok
  const openErrors = Array.isArray(prev.issues) && prev.issues.some((i: any) => i.severity === "ERROR");
  if (!preview && prev.hash === contentHash && prev.accepted && !openErrors && Array.isArray(prev.skus) && prev.skus.length) {
    const tp = Date.now();
    for (const s of prev.skus as { sku: string; variantId?: string; parent?: boolean }[]) {
      if (s.parent) continue;
      const v = active.find((x) => x.id === s.variantId);
      const vPrice = v && product?.supplier_price && v.cost ? marketPrice(price * (Number(v.cost) / Number(product.supplier_price)), market) : price;
      const vQty = v && v.stock_qty != null ? Number(v.stock_qty) : qty;
      const patches = Object.entries(offerAttrs(market, vPrice, vQty, listing.compare_at_price)).map(([path, value]) => ({ op: "replace", path: `/attributes/${path}`, value }));
      const d = await sp(ctx, "PATCH", `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(s.sku)}`, {
        query: query(), body: { productType: prev.productType, patches },
      });
      collect(s.sku, d);
    }
    lap("priceStock", tp);
    finish();
    timings.total = Date.now() - t0;
    return { ok: !errors.length, preview, skus, amazon: { ...prev, syncedAt: new Date().toISOString(), timings }, errors, warnings };
  }

  // 1) Katalogda var mı (barkodla)?
  const tCat = Date.now();
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
  } else if (gtin && !validGtin(gtin)) { warnings.push({ code: "gtin_invalid", field: "barcode", msg: "Barkod geçersiz (kontrol hanesi tutmuyor); barkodsuz gönderildi." }); gtin = null; }
  let foundGtin: string | null = null;
  if (!asin && !multi && !(gtin && validGtin(gtin))) {
    const m = await matchCatalog(input);
    if (m) { asin = m.asin; productType = m.productType; foundGtin = m.gtin; }
  }
  lap("catalog", tCat);

  if (asin) {
    // Kategori / marka onayı: ASIN'e teklif açmadan önce sor (onay gerekiyorsa göndermeden durur, onay bağlantısı verilir)
    const tR = Date.now();
    const rs = await asinRestrictions(ctx, sellerId, market, asin);
    lap("restrictions", tR);
    if (rs?.approval) {
      errors.push({ code: "approval_required", field: "category", msg: `Amazon bu ürün için kategori / marka onayı istiyor: ${rs.msg}${rs.link ? " Onay başvurusu: " + rs.link : ""}` });
      timings.total = Date.now() - t0;
      return { ok: false, preview, skus, amazon: { ...prev, productType, asin, gated: { link: rs.link, msg: rs.msg }, timings }, errors, warnings };
    }
    // Gerçek Amazon kesintisiyle zarar kontrolü (kapatılamaz)
    const tF = Date.now();
    const fees = await feesEstimate(ctx, market, { asin }, price);
    lap("fees", tF);
    if (fees && input.unitCost != null && input.unitCost > 0 && price - fees.total - input.unitCost < 0) {
      errors.push({ code: "loss", field: "price", msg: `Zarar: ${price} ${market.currency} fiyattan Amazon kesintisi (${fees.total} ${market.currency}, %${fees.pct}) ve maliyet (${money(input.unitCost)} ${market.currency}) düşünce kâr eksi.` });
      timings.total = Date.now() - t0;
      return { ok: false, preview, skus, amazon: { ...prev, productType, asin, fees, timings }, errors, warnings };
    }
    const sku = makeSku(product.id);
    const body = { productType, requirements: "LISTING_OFFER_ONLY", attributes: { merchant_suggested_asin: [{ value: asin, marketplace_id: market.id }], ...offerAttrs(market, price, qty, listing.compare_at_price) } };
    const tP = Date.now();
    collect(sku, await sp(ctx, "PUT", `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`, { query: query(mode), body }));
    lap("submit", tP);
    finish();
    timings.total = Date.now() - t0;
    const amazon = { productType, asin, offerOnly: true, hash: contentHash, accepted: !preview && !errors.length, skus: [{ sku }], url: `https://${market.domain}/dp/${asin}`,
      ...(foundGtin ? { foundGtin } : {}), ...(fees ? { fees } : {}), timings };
    return { ok: !errors.length, preview, skus, amazon, errors, warnings };
  }

  // 2) Tam ilan. HIZ: iki kol AYNI ANDA çalışır:
  //    a) görseller (ana görsel düzeltme) + pazar dilinde metin   b) ürün türü -> şema -> zorunlu nitelikler (AI)
  // (madde / arama terimi / menşe zorunluysa AI da doldurur; üründen gelen değer her zaman önce gelir)
  const KNOWN = ["item_name", "brand", "product_description", "main_product_image_locator",
    "condition_type", "purchasable_offer", "fulfillment_availability", "list_price", "merchant_suggested_asin",
    "parentage_level", "child_parent_sku_relationship", "variation_theme", "color", "size", "externally_assigned_product_identifier", "external_product_id",
    "supplier_declared_has_product_identifier_exemption", "gtin_exemption_reason"];
  const typeBranch = (async () => {
    const tT = Date.now();
    const pt = await productTypeFor(input);
    const sc = await schemaFor(input, pt);
    lap("productType", tT);
    const tA = Date.now();
    const missing = sc.required.filter((n) => !KNOWN.includes(n) && !/^other_product_image_locator_/.test(n));
    // Aynı içerikle daha önce AI'nın doldurduğu nitelikler yeniden kullanılır
    const at = prev.hash === contentHash && prev.productType === pt && prev.ai ? prev.ai : await aiAttributes(input, pt, missing, sc.properties);
    lap("attributes", tA);
    return { pt, sc, at };
  })();
  typeBranch.catch(() => {}); // görsel / metin kolu erken dönerse yakalanmamış hata olmasın
  const tPrep = Date.now();
  const [img, txt] = await Promise.all([
    input.upload ? prepareImages(input.images, { upload: input.upload, pathPrefix: input.imagePrefix || `amazon/${listing.user_id}/${product?.id}`, cache: prev.imageFix }) : null,
    input.content ? null : (prev.content?.hash === contentHash && prev.content?.locale === market.locale && prev.content?.title
      ? { content: prev.content, issues: [], ai: false }
      : localizedContent(product, listing, market, input.maxTitle || 200)),
  ]);
  lap("prepare", tPrep);
  if (img) {
    input.images = img.images;
    for (const i of img.issues) (i.severity === "ERROR" ? errors : warnings).push({ code: i.code, field: i.field, msg: i.msg, severity: i.severity });
    if (errors.length) return { ok: false, preview, skus: [], amazon: prev, errors, warnings };
  }
  if (txt) {
    input.content = { title: txt.content.title, bullets: txt.content.bullets, description: txt.content.description, keywords: txt.content.keywords };
    for (const i of txt.issues) warnings.push({ code: i.code, field: i.field, msg: i.msg, severity: i.fixed ? "INFO" : "WARNING" });
  }
  const contentCache = input.content ? { ...input.content, hash: contentHash, locale: market.locale } : null;
  const extra = { imageFix: { ...(prev.imageFix || {}), ...(img?.imageFix || {}) }, content: contentCache };

  const tb = await typeBranch;
  productType = tb.pt;
  const sch = tb.sc;
  const gate = gatingHint(productType, market);
  if (gate) warnings.push({ code: "approval_maybe", field: "category", msg: gate });
  const base = { ...contentAttrs(market, input), ...identifierAttrs(market, multi ? null : gtin, sch.properties) };
  const tA = Date.now();
  let ai = tb.at;
  // Amazon sonradan itiraz ettiyse (amazon-orders ilan durumunu okur): itiraz edilen nitelikler gönderimden önce düzeltilir
  if (openErrors) {
    const later = (prev.issues as Issue[]).filter((i) => i.severity === "ERROR" && classifyIssue(i) === "attribute");
    if (later.length) ai = { ...ai, ...(await aiFixAttributes(input, productType, later, { ...ai, ...base }, sch.properties)) };
  }
  lap("attributes", tA);
  const common = () => ({ ...ai, ...base });
  if (!gtin || multi) warnings.push({ code: "gtin_exemption", field: "barcode", msg: "Barkod yok: marka için Amazon GTIN muafiyeti gerekir; muafiyet yoksa Amazon ilanı reddeder." });

  // Gönder; Amazon reddederse hatayı oku, düzeltilebilir nitelikleri AI ile düzelt, en fazla 2 kez yeniden gönder
  const fixes: { sku: string; round: number; fields: string[] }[] = [];
  const putSku = async (sku: string, build: () => Record<string, unknown>) => {
    let attributes = build();
    for (let round = 0; ; round++) {
      const issues = collect(sku, await sp(ctx, "PUT", `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`, {
        query: query(mode), body: { productType, requirements: "LISTING", attributes },
      }));
      const errs = issues.filter((i) => i.severity === "ERROR");
      if (!errs.length || round >= 2) return;
      const kinds = errs.map(classifyIssue);
      if (kinds.includes("approval")) return; // onay gerekiyor: düzeltilemez
      let patch: Record<string, unknown> = {};
      const attrErrs = errs.filter((_, k) => kinds[k] === "attribute");
      if (attrErrs.length) patch = await aiFixAttributes(input, productType!, attrErrs, attributes, sch.properties);
      // Görsel reddedildiyse sıradaki görsel ana görsel olur
      if (kinds.includes("image") && input.images.length > 1) patch.main_product_image_locator = [{ media_location: input.images[1], marketplace_id: market.id }];
      if (!Object.keys(patch).length) return;
      ai = { ...ai, ...Object.fromEntries(Object.entries(patch).filter(([k]) => !k.endsWith("image_locator"))) };
      attributes = { ...attributes, ...patch };
      fixes.push({ sku, round: round + 1, fields: Object.keys(patch) });
    }
  };

  const tS = Date.now();
  const skuList: { sku: string; variantId?: string; parent?: boolean }[] = [];
  if (multi) {
    const theme = themeFor(active, sch.themes);
    if (!theme) warnings.push({ code: "variation_theme", field: "variants", msg: "Bu ürün türünde seçenekler için uygun Amazon teması bulunamadı; seçenekler ayrı ürün olarak gönderildi." });
    const parentSku = makeSku(product.id);
    if (theme) {
      // Ana ilan (satılmaz, seçenekleri toplar)
      await putSku(parentSku, () => ({ ...common(), parentage_level: [{ value: "parent", marketplace_id: market.id }], variation_theme: [{ name: theme }] }));
      skuList.push({ sku: parentSku, parent: true });
    }
    // Seçenekler PARALEL gönderilir (HIZ KURALI); Amazon kotasına sp() içindeki tekrar deneme uyar
    const children = await Promise.all(active.map(async (v, i) => {
      const sku = makeSku(product.id, String(i + 1));
      const vPrice = product?.supplier_price && v.cost ? marketPrice(price * (Number(v.cost) / Number(product.supplier_price)), market) : price;
      const vQty = v.stock_qty != null ? Number(v.stock_qty) : qty;
      await putSku(sku, () => {
        const attrs: Record<string, unknown> = { ...common(), ...variantOptionAttrs(market, v), ...offerAttrs(market, vPrice, vQty, null),
          ...identifierAttrs(market, v.gtin ? String(v.gtin).replace(/\D/g, "") : null, sch.properties) };
        if (v.image_url && /^https:\/\//.test(v.image_url)) attrs.main_product_image_locator = [{ media_location: v.image_url, marketplace_id: market.id }];
        if (theme) {
          attrs.parentage_level = [{ value: "child", marketplace_id: market.id }];
          attrs.child_parent_sku_relationship = [{ child_relationship_type: "variation", parent_sku: parentSku, marketplace_id: market.id }];
          attrs.variation_theme = [{ name: theme }];
        }
        return attrs;
      });
      return { sku, variantId: v.id };
    }));
    skuList.push(...children);
  } else {
    const sku = makeSku(product.id);
    await putSku(sku, () => ({ ...common(), ...offerAttrs(market, price, qty, listing.compare_at_price) }));
    skuList.push({ sku, variantId: active[0]?.id });
  }
  lap("submit", tS);
  finish();
  // Kabul edilen yeni ilanın gerçek kesintisi (SKU ile); ilanın komisyon oranı buna göre güncellenir
  let fees: Awaited<ReturnType<typeof feesEstimate>> = null;
  if (!preview && !errors.length) {
    const tF = Date.now();
    const first = skuList.find((x) => !x.parent);
    fees = first ? await feesEstimate(ctx, market, { sku: first.sku }, price) : null;
    lap("fees", tF);
    if (fees && input.unitCost != null && input.unitCost > 0 && price - fees.total - input.unitCost < 0) {
      warnings.push({ code: "loss_after_fees", field: "price", msg: `Amazon'un gerçek kesintisi %${fees.pct}: bu fiyatla kâr eksi. Fiyatı yükselt (ilan açık, satışta zarar kontrolü siparişi onaya düşürür).` });
    }
  }
  if (fixes.length) warnings.push({ code: "auto_fixed", field: "attributes", severity: "INFO",
    msg: "Amazon'un itiraz ettiği alanlar otomatik düzeltilip yeniden gönderildi: " + [...new Set(fixes.flatMap((f) => f.fields))].join(", ") });
  timings.total = Date.now() - t0;
  const amazon = { ...extra, productType, offerOnly: false, hash: contentHash, ai, accepted: !preview && !errors.length, skus: skuList, fixes, ...(gate ? { gatedHint: gate } : {}), ...(fees ? { fees } : {}), timings };
  return { ok: !errors.length, preview, skus, amazon, errors, warnings };
}

// GS1 dahili / mağaza içi önekler (Amazon reddeder): 020-029, 040-049, 200-299 (EAN-13); UPC 2 ve 4 ile başlayan
export function internalGtin(code: string): boolean {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length === 13) return /^(0[24]|2)/.test(c);
  if (c.length === 12) return /^[24]/.test(c);
  return false;
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
