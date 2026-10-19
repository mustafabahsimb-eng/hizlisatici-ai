// =========================================================
// Amazon sandbox benzetimi (YALNIZ test kullanıcısının sandbox bağlantısı: store_connections.settings.simulate = true)
// Neden: Amazon'un statik sandbox'ı yalnız kendi örnek isteklerine cevap verir; gerçek bir ürünün ilanını kabul etmez.
// Satıcı hesabı olmadan "ürün ekle -> Amazon'a gönder" akışını uçtan uca ölçmek için Amazon'un cevapları burada,
// Amazon'un model dosyalarındaki biçimde üretilir. Giriş anahtarı (LWA) gerçek Amazon'dan alınır; ürün oluşturma, AI,
// görsel düzeltme, kuyruk ve işçi gerçektir. Gecikme: istek başına ~300 ms (Amazon SP-API ortalaması).
// Gerçekçilik: zorunlu nitelik eksikse Amazon gibi ERROR döner (otomatik düzeltme yolu da çalışır).
// =========================================================
export const SIM_LATENCY_MS = 300;

type Prop = { type?: string; items?: any; enum?: string[] };
const txt = (): Prop => ({ type: "array", items: { properties: { value: { type: "string" }, language_tag: { type: "string" }, marketplace_id: { type: "string" } } } });
const en = (...v: string[]): Prop => ({ type: "array", items: { properties: { value: { type: "string", enum: v }, marketplace_id: { type: "string" } } } });

// Gerçek Amazon şemalarındaki zorunlu niteliklerin özeti (ürün türüne göre)
const COMMON = ["item_name", "brand", "product_description", "bullet_point", "condition_type", "item_type_keyword", "manufacturer", "country_of_origin",
  "supplier_declared_dg_hz_regulation", "batteries_required"];
const TYPES: Record<string, { keys: RegExp; display: string; required: string[]; props: Record<string, Prop> }> = {
  SHOES: { keys: /shoe|sneaker|ayakkab|converse|vans|boot|sandal|spor ayakkab/i, display: "Shoes", required: ["footwear_size", "target_gender", "age_range_description", "color", "outer_material_type", "sole_material", "department_name", "style"],
    props: { footwear_size: txt(), target_gender: en("male", "female", "unisex"), age_range_description: en("Adult", "Kid", "Toddler"), color: txt(), outer_material_type: en("Canvas", "Leather", "Synthetic", "Mesh"), sole_material: en("Rubber", "EVA", "Leather"), department_name: txt(), style: txt() } },
  HANDBAG: { keys: /bag|çanta|canta|handbag|purse|tote/i, display: "Handbag", required: ["color", "material", "style", "closure_type", "item_shape"],
    props: { color: txt(), material: en("Leather", "Faux Leather", "Canvas", "Polyester"), style: txt(), closure_type: en("Zipper", "Magnetic", "Snap", "Open Top"), item_shape: en("Rectangular", "Square", "Round", "Bucket") } },
  PANTS: { keys: /jean|pant|pantolon|trouser|kot/i, display: "Pants", required: ["apparel_size", "color", "fabric_type", "target_gender", "age_range_description", "department_name", "fit_type", "closure_type"],
    props: { apparel_size: txt(), color: txt(), fabric_type: txt(), target_gender: en("male", "female", "unisex"), age_range_description: en("Adult", "Kid"), department_name: txt(), fit_type: en("Slim", "Regular", "Relaxed", "Skinny"), closure_type: en("Button", "Zipper", "Drawstring", "Pull On") } },
  SHIRT: { keys: /t-?shirt|tee|tişört|tisort|shirt|gömlek|polo|top|bluz|sweat|kazak|sweater|hoodie/i, display: "Shirt", required: ["apparel_size", "color", "fabric_type", "target_gender", "age_range_description", "department_name", "sleeve", "neck"],
    props: { apparel_size: txt(), color: txt(), fabric_type: txt(), target_gender: en("male", "female", "unisex"), age_range_description: en("Adult", "Kid"), department_name: txt(), sleeve: en("Short Sleeve", "Long Sleeve", "Sleeveless"), neck: en("Crew Neck", "V-Neck", "Polo", "Hooded") } },
  POSTER: { keys: /poster|afiş|afis|print|tablo|wall art|duvar/i, display: "Poster", required: ["color", "material", "item_display_dimensions", "theme", "frame_type", "orientation"],
    props: { color: txt(), material: en("Paper", "Canvas", "Vinyl"), item_display_dimensions: txt(), theme: txt(), frame_type: en("Unframed", "Framed"), orientation: en("Portrait", "Landscape", "Square") } },
};
const GENERIC = { display: "Product", required: ["color", "material"], props: { color: txt(), material: txt() } };

function candidates(text: string) {
  const hits = Object.entries(TYPES).filter(([, t]) => t.keys.test(text)).map(([name, t]) => ({ name, displayName: t.display }));
  return hits.length ? hits : [{ name: "PRODUCT", displayName: "Product" }];
}
function schemaOf(type: string) {
  const t = TYPES[type] || GENERIC;
  const props: Record<string, Prop> = { item_name: txt(), brand: txt(), product_description: txt(), bullet_point: txt(), condition_type: en("new_new"),
    item_type_keyword: txt(), manufacturer: txt(), country_of_origin: en("TR", "CN", "US", "DE", "IT", "VN", "IN", "BD"),
    supplier_declared_dg_hz_regulation: en("not_applicable", "other", "transportation", "safety_data_sheet"), batteries_required: { type: "array", items: { properties: { value: { type: "boolean" } } } },
    ...t.props };
  return { required: [...COMMON, ...t.required], properties: props };
}
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36).toUpperCase().padStart(8, "0").slice(-8); };
const typeFromSku = new Map<string, string>(); // sku -> ürün türü (aynı örnek içinde PATCH / getListingsItem için)

export function simulate(method: string, path: string, q: URLSearchParams, body: any): { status: number; data: any } {
  const ok = (data: any) => ({ status: 200, data });
  if (method === "GET" && path === "/definitions/2020-09-01/productTypes") {
    return ok({ productTypes: candidates(String(q.get("itemName") || q.get("keywords") || "")), productTypeVersion: "SIM" });
  }
  let m = /^\/definitions\/2020-09-01\/productTypes\/([^/]+)$/.exec(path);
  if (method === "GET" && m) {
    const t = decodeURIComponent(m[1]);
    return ok({ productType: t, schema: { link: { resource: "sim://schema/" + t, verb: "GET" } }, simulatedSchema: schemaOf(t), requirements: "LISTING" });
  }
  if (method === "GET" && path === "/catalog/2022-04-01/items") return ok({ numberOfResults: 0, items: [] });
  if (method === "GET" && path === "/listings/2021-08-01/restrictions") return ok({ restrictions: [] });
  if (method === "GET" && path === "/sellers/v1/marketplaceParticipations") return ok({ payload: [] });
  m = /^\/listings\/2021-08-01\/items\/([^/]+)\/([^/]+)$/.exec(path);
  if (m && method === "PUT") {
    const sku = decodeURIComponent(m[2]);
    const attrs = body?.attributes || {};
    const type = String(body?.productType || "PRODUCT");
    typeFromSku.set(sku, type);
    const isParent = attrs.parentage_level?.[0]?.value === "parent";
    const req = body?.requirements === "LISTING_OFFER_ONLY" ? [] : schemaOf(type).required.filter((k) => !(isParent && ["purchasable_offer", "condition_type"].includes(k))); // ana (parent) ilan satılmaz
    const issues = req.filter((k) => !(Array.isArray(attrs[k]) && attrs[k].length)).map((k) => ({
      code: "90220", message: `'${k}' is required but not supplied.`, severity: "ERROR", attributeNames: [k], categories: ["MISSING_ATTRIBUTE"],
    }));
    const preview = q.get("mode") === "VALIDATION_PREVIEW";
    return ok({ sku, status: issues.length ? "INVALID" : preview ? "VALID" : "ACCEPTED", submissionId: "sim-" + hash(sku + Date.now()), issues });
  }
  if (m && method === "PATCH") return ok({ sku: decodeURIComponent(m[2]), status: "ACCEPTED", submissionId: "sim-" + hash(path + Date.now()), issues: [] });
  if (m && method === "GET") {
    const sku = decodeURIComponent(m[2]);
    return ok({ sku, summaries: [{ marketplaceId: q.get("marketplaceIds"), asin: "B0" + hash(sku), productType: typeFromSku.get(sku) || "PRODUCT", status: ["BUYABLE", "DISCOVERABLE"] }], issues: [] });
  }
  if (method === "POST" && /^\/products\/fees\/v0\//.test(path)) {
    const p = body?.FeesEstimateRequest?.PriceToEstimateFees?.ListingPrice || {};
    const amount = Math.round(Number(p.Amount || 0) * 0.15 * 100) / 100;
    return ok({ payload: { FeesEstimateResult: { Status: "Success", FeesEstimate: { TotalFeesEstimate: { CurrencyCode: p.CurrencyCode, Amount: amount },
      FeeDetailList: [{ FeeType: "ReferralFee", FinalFee: { CurrencyCode: p.CurrencyCode, Amount: amount } }] } } } });
  }
  if (method === "GET" && path === "/orders/2026-01-01/orders") return ok({ orders: [] });
  return { status: 404, data: { errors: [{ code: "NotFound", message: "Benzetimde yok: " + method + " " + path }] } };
}
