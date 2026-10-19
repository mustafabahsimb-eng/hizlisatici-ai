// Amazon hızlı ürün yükleme — kalite ve otomasyon testi (sahte Amazon + sahte AI; canlıya hiçbir şey gitmez)
// Kapsam: metin kuralları (başlık / 5 madde / açıklama / arama terimi bayt sınırı / yasak ifadeler), pazar dilinde AI metni,
// ana görsel kontrolü ve otomatik düzeltme, kategori onayı (ungating), ret -> AI düzeltme -> yeniden gönderme,
// tek seferde çok pazar (dil + para birimi + fiyat), zarar kontrolü, mağaza içi barkod, yükleme süresi ölçümü.
// Çalıştırma: deno test -A --config <deno-check.json> tests/amazon/amazon_quality_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

Deno.env.set("AMAZON_APP_ID", "amzn1.sp.solution.test");
Deno.env.set("AMAZON_LWA_CLIENT_ID", "amzn1.application-oa2-client.test");
Deno.env.set("AMAZON_LWA_CLIENT_SECRET", "test-secret");
Deno.env.set("ANTHROPIC_API_KEY", "test-ai-key");
Deno.env.delete("AMAZON_AUTO_BG_REMOVE");

type Call = { method: string; url: URL; body: any };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
const files = new Map<string, Uint8Array>(); // sahte görsel sunucusu + depo
let latency = { sp: 0, ai: 0 };
let putHandler: (c: Call, n: number) => any = () => ({ status: "ACCEPTED", submissionId: "s1", issues: [] });
let aiHandler: (system: string, user: any, hasImage: boolean) => any = () => ({});
let restrictions: any = { restrictions: [] };
let productTypes = [{ name: "LUGGAGE", displayName: "Luggage" }];
const SCHEMA = {
  required: ["item_name", "brand", "product_description", "condition_type", "material", "item_type_keyword"],
  properties: { material: { type: "array", items: { properties: { value: { type: "string" } } } }, item_type_keyword: { type: "array" },
    variation_theme: { type: "array", items: { properties: { name: { enum: ["SIZE", "COLOR"] } } } } },
};
const sleep = (ms: number) => ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
const res = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
let putCount = 0;
let feeRate = 0.15;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host === "deno.land") return realFetch(input, init);
  const method = (init?.method || "GET").toUpperCase();
  const raw = init?.body;
  const body = typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw) : null;
  const c = { method, url, body };
  calls.push(c);
  if (url.host === "img.test") {
    const b = files.get(url.pathname);
    return b ? new Response(new Uint8Array(b), { headers: { "content-type": "image/jpeg" } }) : new Response("yok", { status: 404 });
  }
  if (url.host === "api.anthropic.com") {
    await sleep(latency.ai);
    const c0 = body.messages[0].content;
    const content = typeof c0 === "string" ? [{ type: "text", text: c0 }] : c0;
    const text = content.find((x: any) => x.type === "text").text;
    let user: any = text; try { user = JSON.parse(text); } catch (_) { /* düz metin */ }
    const out = aiHandler(body.system || "", user, content.some((x: any) => x.type === "image"));
    return res({ content: [{ type: "text", text: JSON.stringify(out) }] });
  }
  if (url.host === "api.amazon.com") return res({ access_token: "Atza|t", expires_in: 3600 });
  if (url.host === "schema.test") return res(SCHEMA);
  if (url.host.endsWith(".amazon.com")) {
    await sleep(latency.sp);
    const p = url.pathname;
    if (p === "/definitions/2020-09-01/productTypes") return res({ productTypes });
    if (p.startsWith("/definitions/2020-09-01/productTypes/")) return res({ schema: { link: { resource: "https://schema.test/s.json" } } });
    if (p === "/catalog/2022-04-01/items") {
      if (url.searchParams.get("identifiers") === "8806090193972") return res({ items: [{ asin: "B0TEST0001", productTypes: [{ marketplaceId: url.searchParams.get("marketplaceIds"), productType: "TELEVISION" }] }] });
      return res({ items: [] });
    }
    if (p === "/listings/2021-08-01/restrictions") return res(restrictions);
    if (p.startsWith("/products/fees/v0/")) {
      const price = body.FeesEstimateRequest.PriceToEstimateFees.ListingPrice.Amount;
      return res({ payload: { FeesEstimateResult: { Status: "Success", FeesEstimate: { TotalFeesEstimate: { CurrencyCode: body.FeesEstimateRequest.PriceToEstimateFees.ListingPrice.CurrencyCode, Amount: Math.round(price * feeRate * 100) / 100 },
        FeeDetailList: [{ FeeType: "ReferralFee", FinalFee: { Amount: Math.round(price * feeRate * 100) / 100 } }] } } } });
    }
    if (p.startsWith("/listings/2021-08-01/items/") && method === "PUT") return res(putHandler(c, ++putCount));
    if (p.startsWith("/listings/2021-08-01/items/") && method === "PATCH") return res({ status: "ACCEPTED", issues: [] });
    return res({ errors: [{ code: "NotFound", message: p }] }, 404);
  }
  return new Response("?", { status: 404 });
}) as typeof fetch;

const A = await import("../../supabase/functions/_shared/amazon.ts");
const L = await import("../../supabase/functions/_shared/amazon-listing.ts");
const C = await import("../../supabase/functions/_shared/amazon-content.ts");
const I = await import("../../supabase/functions/_shared/amazon-images.ts");

function fakeDb() {
  const store: Record<string, any[]> = { amazon_product_types: [], listings: [] };
  const q = (table: string) => {
    const f: [string, unknown][] = [];
    const api: any = {
      select: () => api, eq: (k: string, v: unknown) => { f.push([k, v]); return api; }, not: () => api, neq: () => api, limit: () => api, is: () => api,
      maybeSingle: async () => ({ data: store[table].find((r) => f.every(([k, v]) => r[k] === v)) || null }),
      upsert: async (row: any) => { store[table].push(row); return { error: null }; },
    };
    return api;
  };
  return { from: q, store };
}
const upload: any = async (path: string, jpeg: Uint8Array) => { files.set("/" + path, jpeg); return "https://img.test/" + path; };
const ctx = { region: "eu" as const, refreshToken: "Atzr|r", sandbox: true };
const DE = A.marketByCode("amazon_de")!, US = A.marketByCode("amazon_us")!, UK = A.marketByCode("amazon_uk")!, FR = A.marketByCode("amazon_fr")!, JP = A.marketByCode("amazon_jp")!;

// Sentetik ürün fotoğrafları
async function photo(name: string, w: number, h: number, bg: number, box: [number, number, number, number], color = 0x3060c0ff) {
  const img = new Image(w, h).fill(bg);
  const [x, y, bw, bh] = box;
  img.drawBox(x, y, bw, bh, color);
  files.set("/" + name, await img.encodeJPEG(95));
  return "https://img.test/" + name;
}
const fakeContent = (lang: string) => ({
  title: `Seltigo ${lang} Kabinenkoffer leicht 4 Rollen`, bullets: [1, 2, 3, 4, 5].map((n) => `Merkmal ${n} (${lang}): robustes Material und leichte Bauweise für Reisen`),
  description: `Beschreibung ${lang}`, keywords: `trolley reisegepäck handgepäck ${lang}`,
});
const baseInput = (over: any = {}) => ({
  db: fakeDb(), ctx, market: DE, sellerId: "A1SELLER", preview: false, stockQty: 5,
  listing: { id: "l1", user_id: "u1", marketplace_code: "amazon_de", title: "Kabin boy valiz 4 tekerlekli", description: "Hafif valiz", price: 49.5, validation: null },
  product: { id: 501, brand: "Seltigo", stock_qty: 5 }, variants: [], images: ["https://img.test/ok.jpg"],
  ...over,
});
const defaultAi = (system: string, user: any) => {
  if (system.includes("Amazon product detail page content")) {
    const lang = /in (\w+) \(locale/.exec(system)?.[1] || "?";
    return fakeContent(lang);
  }
  if (system.includes("choose the single best Amazon product type")) return { productType: user.candidates[user.candidates.length - 1].name };
  if (system.includes("fill Amazon SP-API Listings Items attributes")) return { material: [{ value: "Polycarbonat", marketplace_id: DE.id }], item_type_keyword: [{ value: "luggage", marketplace_id: DE.id }] };
  if (system.includes("fix rejected")) return { material: [{ value: "Polycarbonate", marketplace_id: DE.id }] };
  return {};
};
function reset() {
  calls.length = 0; putCount = 0; latency = { sp: 0, ai: 0 }; restrictions = { restrictions: [] }; feeRate = 0.15;
  productTypes = [{ name: "LUGGAGE", displayName: "Luggage" }];
  putHandler = () => ({ status: "ACCEPTED", submissionId: "s1", issues: [] });
  aiHandler = defaultAi;
}
await photo("ok.jpg", 1200, 1200, 0xffffffff, [80, 80, 1040, 1040]);

// ---------------- Metin kuralları ----------------
Deno.test("Başlık: yasak işaretler, tanıtım ifadesi, 2'den fazla tekrar, tamamı büyük harf, uzunluk otomatik düzeltilir", () => {
  const issues: any[] = [];
  const t = C.fixTitle("SÜPER VALİZ!!! ÜCRETSİZ KARGO valiz VALİZ valiz kabin {yeni} $$ En Çok Satan", "tr", 200, issues);
  assert(!/[!${}]/.test(t), t);
  assert(!/ücretsiz kargo|en çok satan/i.test(t), t);
  assertEquals(t.toLocaleLowerCase("tr").split(" ").filter((w) => w === "valiz").length, 2, t);
  assert(t !== t.toLocaleUpperCase("tr"), "büyük harf düzeltildi");
  const codes = issues.map((i) => i.code);
  for (const k of ["title_chars", "promo", "title_repeat", "title_caps"]) assert(codes.includes(k), k);
  const long = C.fixTitle("Seyahat valizi ".repeat(30), "tr", 150, []);
  assert(long.length <= 150);
});

Deno.test("Maddeler: en fazla 5, 500 karakter, iletişim bilgisi ve kanıt isteyen iddia çıkarılır; açıklamada HTML / bağlantı yok", () => {
  const issues: any[] = [];
  const b = C.fixBullets(["• Antibakteriyel kumaş, mikrop öldürür", "Bilgi: info@satici.com, www.satici.com", "x".repeat(700), "A", "Dört", "Beş", "Altı", "Yedi"], "tr", issues);
  assertEquals(b.length, 5);
  assert(b.every((x) => x.length <= 500));
  assert(!b.some((x) => /antibakteriyel|mikrop öldürür|@|www\./i.test(x)), JSON.stringify(b));
  assert(issues.some((i) => i.code === "claim") && issues.some((i) => i.code === "contact") && issues.some((i) => i.code === "bullet_count"));
  const d = C.fixDescription("<p>Harika ürün</p><br>Detay için https://x.com ara: +90 532 123 45 67", "tr", []);
  assert(!/<|https|532/.test(d), d);
});

Deno.test("Arama terimleri: 249 BAYT sınırı (Türkçe / Almanca harf 2 bayt), başlık + marka + tekrar + tanıtım çıkar", () => {
  const issues: any[] = [];
  const kw = C.fixKeywords("valiz Seltigo çanta çanta bavul indirim B0ABCDEFGH " + Array.from({ length: 80 }, (_, i) => "şğüıöç" + i).join(", "), "tr", "Seltigo kabin valiz", "Seltigo", issues);
  const bytes = new TextEncoder().encode(kw).length;
  assert(bytes <= 249, String(bytes));
  const w = kw.split(" ");
  assert(!w.includes("valiz") && !w.includes("seltigo") && !w.includes("indirim") && !w.includes("b0abcdefgh"), kw);
  assertEquals(w.filter((x) => x === "çanta").length, 1);
  assert(issues.some((i) => i.code === "keywords_length"));
});

Deno.test("Pazar dilinde metin: AI'ya pazarın dili ve kuralları gider; AI yoksa ilan metni kurallardan geçer", async () => {
  reset();
  const r = await C.localizedContent({ brand: "Seltigo" }, { title: "Kabin valiz", description: "Hafif" }, DE, 150);
  assert(r.ai);
  assert(r.content.title.includes("German"));
  assertEquals(r.content.bullets.length, 5);
  const ai = calls.find((c) => c.url.host === "api.anthropic.com")!;
  assert(ai.body.system.includes("www.amazon.de") && ai.body.system.includes("max 150 characters"));
  aiHandler = () => ({ nope: true }); // AI biçimsiz cevap -> ilan metni kullanılır
  const r2 = await C.localizedContent({ brand: "X", specs: [{ k: "Malzeme", v: "Seramik" }] }, { title: "SERAMİK KUPA SETİ!!! ucuz", description: "Seramik kupa" }, A.marketByCode("amazon_tr")!);
  assert(!r2.ai);
  assertEquals(r2.content.title, "Seramik KUPA SETİ", "5+ harfli büyük kelimeler düzelir, 4 harfli kısaltma gibi korunur");
  assertEquals(r2.content.bullets, ["Malzeme: Seramik"]);
});

// ---------------- Görsel ----------------
Deno.test("Ana görsel: açık gri zemin + küçük ürün + 600 px -> saf beyaz, ürün %90, 1000×1000; kurala uyan görsele dokunulmaz", async () => {
  const src = await photo("gri.jpg", 600, 400, 0xeeeeeeff, [200, 120, 200, 160]);
  const r = await I.prepareImages([src, "https://img.test/ok.jpg"], { upload, pathPrefix: "amazon/u1/501" });
  assertEquals(r.issues[0].code, "main_image_fixed", JSON.stringify(r.issues));
  assert(r.images[0].startsWith("https://img.test/amazon/u1/501-"));
  const out = await Image.decode(files.get(new URL(r.images[0]).pathname)!) as Image;
  assertEquals([out.width, out.height], [1000, 1000]);
  const a = I.analyze(out);
  assert(a.borderWhite >= 0.98, String(a.borderWhite));
  assert(a.fill >= 0.85 && a.fill <= 0.95, String(a.fill));
  assert(a.ok);
  assertEquals(r.imageFix[src], r.images[0], "önbellek");
  const again = await I.prepareImages([src], { upload, pathPrefix: "x", cache: r.imageFix });
  assertEquals(again.images[0], r.images[0], "aynı görsel bir daha işlenmez");
  const ok = await I.prepareImages(["https://img.test/ok.jpg"], { upload, pathPrefix: "x" });
  assertEquals(ok.images, ["https://img.test/ok.jpg"]);
  assertEquals(ok.issues.length, 0);
});

Deno.test("Ana görsel: renkli zemin -> beyaz zeminli diğer görsel ana görsel olur; hiçbiri yoksa uyarı", async () => {
  const red = await photo("kirmizi.jpg", 1200, 1200, 0xc03030ff, [300, 300, 600, 600], 0x202020ff);
  const r = await I.prepareImages([red, "https://img.test/ok.jpg"], { upload, pathPrefix: "p" });
  assertEquals(r.issues[0].code, "main_image_swapped");
  assertEquals(r.images[0], "https://img.test/ok.jpg");
  assertEquals(r.images[1], red);
  const r2 = await I.prepareImages([red], { upload, pathPrefix: "p" });
  assertEquals(r2.issues[0].code, "main_image_background");
  assertEquals(r2.images, [red]);
});

// ---------------- Barkod / katalog / onay ----------------
Deno.test("Barkodlu ürün katalogda var -> önce kategori onayı sorulur; onay gerekiyorsa GÖNDERİLMEZ, onay bağlantısı verilir", async () => {
  reset();
  restrictions = { restrictions: [{ marketplaceId: US.id, conditionType: "new_new", reasons: [{ reasonCode: "APPROVAL_REQUIRED", message: "You need approval to list in this brand.",
    links: [{ resource: "https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B0TEST0001" }] }] }] };
  const r = await L.submitListing(baseInput({ market: US, product: { id: 7, brand: "Samsung", gtin: "8806090193972", stock_qty: 2 } }) as any);
  assert(!r.ok);
  assertEquals(r.errors[0].code, "approval_required");
  assert(r.errors[0].msg.includes("approvalrequest"));
  assert(!calls.some((c) => c.method === "PUT"), "teklif açılmadı");
  restrictions = { restrictions: [] };
  const r2 = await L.submitListing(baseInput({ market: US, product: { id: 7, brand: "Samsung", gtin: "8806090193972", stock_qty: 2 } }) as any);
  assert(r2.ok);
  assertEquals((r2.amazon as any).asin, "B0TEST0001");
  assertEquals(calls.filter((c) => c.method === "PUT").at(-1)!.body.requirements, "LISTING_OFFER_ONLY");
});

Deno.test("Barkod: mağaza içi önek (2xx) Amazon'da geçmez -> barkodsuz yol + GTIN muafiyeti uyarısı; onay isteyebilecek tür önceden uyarılır", async () => {
  reset();
  assert(L.internalGtin("2000000000015") && !L.internalGtin("8806090193972"));
  productTypes = [{ name: "WATCH", displayName: "Watch" }];
  const r = await L.submitListing(baseInput({ product: { id: 8, brand: "Seltigo", gtin: "2000000000015", stock_qty: 1 } }) as any);
  const codes = r.warnings.map((w) => w.code);
  assert(codes.includes("gtin_internal") && codes.includes("gtin_exemption") && codes.includes("approval_maybe"), codes.join(","));
  const put = calls.find((c) => c.method === "PUT")!;
  assertEquals(put.body.attributes.supplier_declared_has_product_identifier_exemption[0].value, true);
  assert(L.gatingHint("TOY_FIGURE", US, new Date("2026-11-10")), "ABD tatil dönemi oyuncak");
  assertEquals(L.gatingHint("TOY_FIGURE", DE, new Date("2026-11-10")), null);
});

Deno.test("Ürün türü: birden çok aday varsa AI ürün adı + ANA GÖRSELLE seçer", async () => {
  reset();
  productTypes = [{ name: "BACKPACK", displayName: "Backpack" }, { name: "LUGGAGE", displayName: "Luggage" }];
  let sawImage = false;
  aiHandler = (s, u, img) => { if (s.includes("choose the single best")) { sawImage = img; return { productType: "LUGGAGE" }; } return defaultAi(s, u); };
  const r = await L.submitListing(baseInput() as any);
  assertEquals((r.amazon as any).productType, "LUGGAGE");
  assert(sawImage, "görsel AI'ya gitti");
});

// ---------------- Ret -> düzelt -> yeniden gönder ----------------
Deno.test("Amazon reddederse: hata okunur, nitelik AI ile düzeltilir, otomatik yeniden gönderilir", async () => {
  reset();
  putHandler = (_c, n) => n === 1
    ? { status: "INVALID", issues: [{ code: "90220", message: "'material' value 'Plastik' is not valid for this product type.", severity: "ERROR", attributeNames: ["material"] }] }
    : { status: "ACCEPTED", issues: [] };
  const r = await L.submitListing(baseInput() as any);
  assert(r.ok, JSON.stringify(r.errors));
  const puts = calls.filter((c) => c.method === "PUT");
  assertEquals(puts.length, 2);
  assertEquals(puts[1].body.attributes.material[0].value, "Polycarbonate");
  assertEquals((r.amazon as any).fixes[0].fields, ["material"]);
  assert(r.warnings.some((w) => w.code === "auto_fixed"));
  // Onay hatası düzeltilmeye çalışılmaz
  reset();
  putHandler = () => ({ status: "INVALID", issues: [{ code: "5665", message: "You need approval to list in this category.", severity: "ERROR", attributeNames: ["item_type_keyword"] }] });
  const r2 = await L.submitListing(baseInput() as any);
  assert(!r2.ok);
  assertEquals(calls.filter((c) => c.method === "PUT").length, 1);
  assertEquals(L.classifyIssue({ code: "x", msg: "Invalid UPC", field: "externally_assigned_product_identifier" }), "gtin");
});

// ---------------- Çok pazar ----------------
Deno.test("Tek seferde çok pazar: DE / UK / FR / JP aynı anda, her biri kendi dili, para birimi ve fiyat yuvarlamasıyla", async () => {
  reset();
  const markets = [DE, UK, FR, JP];
  const prices: Record<string, number> = { amazon_de: 49.5, amazon_uk: 42.1, amazon_fr: 49.5, amazon_jp: 8123.4 };
  const rs = await Promise.all(markets.map((m) => L.submitListing(baseInput({ market: m,
    listing: { id: "l-" + m.code, user_id: "u1", marketplace_code: m.code, title: "Kabin boy valiz", description: "Hafif", price: prices[m.code], validation: null } }) as any)));
  assert(rs.every((r) => r.ok), JSON.stringify(rs.map((r) => r.errors)));
  const puts = calls.filter((c) => c.method === "PUT");
  const by = (id: string) => puts.find((c) => c.url.searchParams.get("marketplaceIds") === id)!.body.attributes;
  assertEquals(by(DE.id).item_name[0].language_tag, "de_DE");
  assert(by(DE.id).item_name[0].value.includes("German"));
  assert(by(FR.id).item_name[0].value.includes("French"));
  assert(by(JP.id).item_name[0].value.includes("Japanese"));
  assertEquals(by(UK.id).purchasable_offer[0].currency, "GBP");
  assertEquals(by(JP.id).purchasable_offer[0].currency, "JPY");
  assertEquals(by(DE.id).purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 49.99);
  assertEquals(by(UK.id).purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 42.99);
  assertEquals(by(JP.id).purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 8124);
  assertEquals(by(DE.id).bullet_point.length, 5);
  assert(by(DE.id).generic_keyword[0].value.length > 0);
  assertEquals(L.marketPrice(19.99, DE), 19.99);
  assertEquals(L.marketPrice(20, DE), 20.99);
});

Deno.test("Zarar kontrolü: fiyat - Amazon komisyonu - maliyet < 0 ise hiçbir istek gitmeden durur", async () => {
  reset();
  const r = await L.submitListing(baseInput({ unitCost: 45, commissionPct: 15 }) as any);
  assert(!r.ok);
  assertEquals(r.errors[0].code, "loss");
  assertEquals(calls.length, 0);
});

Deno.test("Amazon kesintisi (Product Fees): ASIN'li üründe gerçek kesinti zarar ettiriyorsa teklif açılmaz; yeni ilanda oran okunur", async () => {
  reset();
  feeRate = 0.32; // ör. kategori komisyonu + sabit ücret
  const r = await L.submitListing(baseInput({ market: US, unitCost: 32, commissionPct: 15, // %15 ile kârlı (44,99 - 6,75 - 32 > 0), gerçek %32 ile zararlı
    listing: { id: "lf", user_id: "u1", marketplace_code: "amazon_us", title: "TV", description: "x", price: 44.99, validation: null },
    product: { id: 7, brand: "Samsung", gtin: "8806090193972", stock_qty: 2 } }) as any);
  assert(!r.ok);
  assertEquals(r.errors[0].code, "loss");
  assert(r.errors[0].msg.includes("%32"), r.errors[0].msg);
  assert(!calls.some((c) => c.method === "PUT"), "teklif açılmadı");
  const f = calls.find((c) => c.url.pathname.startsWith("/products/fees/v0/items/B0TEST0001"))!;
  assertEquals(f.body.FeesEstimateRequest.IsAmazonFulfilled, false);
  assertEquals(f.body.FeesEstimateRequest.PriceToEstimateFees.ListingPrice, { CurrencyCode: "USD", Amount: 44.99 });
  reset();
  feeRate = 0.12;
  const r2 = await L.submitListing(baseInput() as any);
  assert(r2.ok);
  assertEquals((r2.amazon as any).fees.pct, 12);
  assert(calls.some((c) => c.url.pathname === "/products/fees/v0/listings/SLT-501/feesEstimate"), "yeni ilan SKU ile soruldu");
});

// ---------------- Süre ölçümü ----------------
Deno.test("Süre: gerçekçi gecikmeyle (Amazon isteği 300 ms, AI 2,5 sn) ürün başına süre ölçülür ve hedefin altında", async () => {
  reset();
  latency = { sp: 300, ai: 2500 };
  const t1 = Date.now();
  const full = await L.submitListing(baseInput() as any);
  const fullMs = Date.now() - t1;
  reset(); latency = { sp: 300, ai: 2500 };
  const t2 = Date.now();
  const offer = await L.submitListing(baseInput({ market: US, product: { id: 7, brand: "Samsung", gtin: "8806090193972", stock_qty: 2 } }) as any);
  const offerMs = Date.now() - t2;
  reset(); latency = { sp: 300, ai: 2500 };
  const ms6 = [DE, UK, FR, JP, A.marketByCode("amazon_it")!, A.marketByCode("amazon_es")!];
  const t3 = Date.now();
  await Promise.all(ms6.map((m) => L.submitListing(baseInput({ market: m, listing: { id: "x" + m.code, user_id: "u1", marketplace_code: m.code, title: "Valiz", description: "x", price: 50, validation: null } }) as any)));
  const sixMs = Date.now() - t3;
  reset(); latency = { sp: 300, ai: 2500 };
  const prev = baseInput();
  const first = await L.submitListing(prev as any);
  prev.listing.validation = { amazon: first.amazon } as any;
  prev.listing.price = 59;
  const t4 = Date.now();
  await L.submitListing(prev as any);
  const psMs = Date.now() - t4;
  console.log(`\nSÜRE (gecikme benzetimi): tam ilan ${fullMs} ms (adımlar ${JSON.stringify((full.amazon as any).timings)}), ` +
    `ASIN'e teklif ${offerMs} ms, 6 pazar paralel ${sixMs} ms, fiyat/stok güncelleme ${psMs} ms`);
  assert(full.ok && offer.ok);
  assert(fullMs < 15000, "tam ilan < 15 sn");
  assert(offerMs < 3000, "ASIN'e teklif < 3 sn");
  assert(sixMs < 20000, "6 pazar paralel < 20 sn");
  assert(psMs < 1500, "fiyat/stok < 1,5 sn");
});
