// Amazon SP-API altyapı testi — Amazon'un KENDİ statik sandbox örnekleriyle (selling-partner-api-models, sabit sürüm)
// Gerçek sandbox'a bağlanmak için Seltigo'nun Amazon geliştirici uygulaması gerekir (henüz yok). Bu test, Amazon'un
// sandbox'ının döndürdüğü örnek cevapları (OpenAPI modelindeki x-amzn-api-sandbox) birebir taklit eder:
// istek yolu + yöntem + parametreler Amazon örneğiyle eşleşirse o cevap döner, eşleşmezse sandbox gibi 400.
// Çalıştırma: deno test --allow-net --allow-env --allow-read --allow-write tests/amazon/amazon_sandbox_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";

const MODELS_SHA = "3677bb9d96f4450e6843f1f8207005e925d5c867";
const MODELS = {
  listings: "listings-items-api-model/listingsItems_2021-08-01.json",
  catalog: "catalog-items-api-model/catalogItems_2022-04-01.json",
  defs: "product-type-definitions-api-model/definitionsProductTypes_2020-09-01.json",
  orders: "orders-api-model/ordersV0.json",
  sellers: "sellers-api-model/sellers.json",
  mfn: "merchant-fulfillment-api-model/merchantFulfillmentV0.json",
};

Deno.env.set("AMAZON_APP_ID", "amzn1.sp.solution.test");
Deno.env.set("AMAZON_LWA_CLIENT_ID", "amzn1.application-oa2-client.test");
Deno.env.set("AMAZON_LWA_CLIENT_SECRET", "test-secret");
Deno.env.delete("ANTHROPIC_API_KEY");

type Op = { method: string; re: RegExp; names: string[]; examples: any[] };
const ops: Op[] = [];
const realFetch = globalThis.fetch;
for (const f of Object.values(MODELS)) {
  const m = await (await realFetch(`https://raw.githubusercontent.com/amzn/selling-partner-api-models/${MODELS_SHA}/models/${f}`)).json();
  for (const [path, byMethod] of Object.entries<any>(m.paths)) {
    for (const [method, op] of Object.entries<any>(byMethod)) {
      if (!op?.operationId) continue;
      const names: string[] = [];
      const re = new RegExp("^" + path.replace(/\{(\w+)\}/g, (_: string, n: string) => { names.push(n); return "([^/]+)"; }) + "$");
      const examples: any[] = [];
      for (const [code, r] of Object.entries<any>(op.responses || {})) {
        for (const e of r?.["x-amzn-api-sandbox"]?.static || []) examples.push({ code: Number(code), ...e });
      }
      ops.push({ method: method.toUpperCase(), re, names, examples });
    }
  }
}

const calls: { method: string; url: URL; body: any }[] = [];
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}
function matchExample(op: Op, url: URL, pathVals: Record<string, string>, body: any) {
  const ok = (e: any) => Object.entries<any>(e.request?.parameters || {}).every(([k, v]) => {
    if (k === "body") return v?.value === undefined || deepEqual(v.value, body);
    const want = v.value;
    const got = pathVals[k] ?? url.searchParams.get(k);
    if (got == null) return false;
    return Array.isArray(want) ? want.join(",") === got : String(want) === got;
  });
  // önce parametreli (daha özel) örnekler, sonra parametresizler
  const sorted = [...op.examples].filter((e) => e.code < 300).sort((a, b) => Object.keys(b.request?.parameters || {}).length - Object.keys(a.request?.parameters || {}).length);
  return sorted.find(ok);
}

const SCHEMA = {
  required: ["item_name", "brand", "product_description", "condition_type", "item_type_keyword", "material"],
  properties: {
    item_name: { type: "array" }, brand: { type: "array" }, material: { type: "array", items: { properties: { value: { type: "string" } } } },
    externally_assigned_product_identifier: { type: "array" }, supplier_declared_has_product_identifier_exemption: { type: "array" },
    variation_theme: { type: "array", items: { properties: { name: { enum: ["COLOR", "SIZE", "SIZE/COLOR"] } } } },
  },
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method || "GET").toUpperCase();
  const raw = init?.body instanceof URLSearchParams ? init.body.toString() : init?.body;
  const body = raw && typeof raw === "string" ? (raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : null;
  calls.push({ method, url, body });
  const res = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
  if (url.host === "api.amazon.com") {
    if (body?.client_secret !== "test-secret") return res({ error: "invalid_client" }, 401);
    return res({ access_token: "Atza|test-" + body.grant_type, refresh_token: body.grant_type === "authorization_code" ? "Atzr|refresh" : undefined, token_type: "bearer", expires_in: 3600 });
  }
  if (url.host === "schema-url") return res(SCHEMA);
  if (/^sandbox\.sellingpartnerapi-(na|eu|fe)\.amazon\.com$/.test(url.host)) {
    const headers = new Headers(init?.headers);
    if (!String(headers.get("x-amz-access-token") || "").startsWith("Atza|")) return res({ errors: [{ code: "Unauthorized", message: "token" }] }, 403);
    for (const op of ops) {
      if (op.method !== method) continue;
      const m = op.re.exec(url.pathname);
      if (!m) continue;
      const pv = Object.fromEntries(op.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      // Statik sandbox'ta barkodla / marka+modelle katalog araması örneği yok; Amazon'un katalog arama örnek cevabı (aynı biçim) kullanılır
      if (url.pathname === "/catalog/2022-04-01/items" && (url.searchParams.get("identifiers") || url.searchParams.get("keywords") === "Samsung,QN82Q60RAFXZA")) {
        return res(op.examples.find((x) => x.code === 200)!.response);
      }
      const e = matchExample(op, url, pv, body);
      if (e) return e.code === 204 ? new Response(null, { status: 204 }) : res(e.response, e.code);
      return res({ errors: [{ code: "InvalidInput", message: "Sandbox örneğiyle eşleşmedi" }] }, 400);
    }
    return res({ errors: [{ code: "NotFound", message: url.pathname }] }, 404);
  }
  return res({}, 404);
}) as typeof fetch;

const A = await import("../../supabase/functions/_shared/amazon.ts");
const L = await import("../../supabase/functions/_shared/amazon-listing.ts");
const O = await import("../../supabase/functions/_shared/amazon-orders.ts");
const S = await import("../../supabase/functions/_shared/amazon-shipping.ts");

// Basit veritabanı taklidi (ürün türü önbelleği ve "önceki benzer ürün" sorgusu)
function fakeDb() {
  const store: Record<string, any[]> = { amazon_product_types: [], listings: [] };
  const q = (table: string) => {
    const filters: [string, unknown][] = [];
    const api: any = {
      select: () => api, eq: (k: string, v: unknown) => { filters.push([k, v]); return api; }, not: () => api, neq: () => api, limit: () => api, is: () => api,
      maybeSingle: async () => ({ data: store[table].find((r) => filters.every(([k, v]) => r[k] === v)) || null }),
      upsert: async (row: any) => { store[table].push(row); return { error: null }; },
    };
    return api;
  };
  return { from: q, store };
}
const US = A.marketByCode("amazon_us")!;
const ctx = { region: "na" as const, refreshToken: "Atzr|refresh", sandbox: true };

Deno.test("Pazar listesi: Türkiye ve küresel pazarlar resmi kimliklerle", () => {
  assertEquals(A.marketByCode("amazon_tr")?.id, "A33AVAJ2PDY3EV");
  assertEquals(A.marketByCode("amazon_tr")?.region, "eu");
  assertEquals(A.marketByCode("amazon_de")?.id, "A1PA6795UKMFR9");
  assertEquals(A.marketByCode("amazon_jp")?.region, "fe");
  assertEquals(A.endpoint("eu", true), "https://sandbox.sellingpartnerapi-eu.amazon.com");
  assertEquals(A.endpoint("eu", false), "https://sellingpartnerapi-eu.amazon.com");
});

Deno.test("Bağlantı: Seller Central onay adresi (taslak uygulama = version=beta) ve kod değişimi", async () => {
  const u = new URL(A.consentUrl("https://sellercentral.amazon.com.tr", "abc123"));
  assertEquals(u.origin + u.pathname, "https://sellercentral.amazon.com.tr/apps/authorize/consent");
  assertEquals(u.searchParams.get("application_id"), "amzn1.sp.solution.test");
  assertEquals(u.searchParams.get("state"), "abc123");
  assertEquals(u.searchParams.get("version"), "beta");
  const t = await A.exchangeCode("spapi-code");
  assertEquals(t.refresh_token, "Atzr|refresh");
  const last = calls.at(-1)!;
  assertEquals(last.body.grant_type, "authorization_code");
  assertEquals(last.body.redirect_uri, A.REDIRECT_URI);
});

Deno.test("Sandbox: satıcının pazarları (getMarketplaceParticipations)", async () => {
  const d = await A.sp(ctx, "GET", "/sellers/v1/marketplaceParticipations");
  assertEquals(d.payload[0].marketplace.id, "ATVPDKIKX0DER");
  assertEquals(A.marketById(d.payload[0].marketplace.id)?.code, "amazon_us");
});

Deno.test("Sandbox: ilan provası VALIDATION_PREVIEW (geçerli ve eksik nitelikli)", async () => {
  const ok = await A.sp(ctx, "PUT", "/listings/2021-08-01/items/AXXXXXXXXXXXXX/VALIDATION_VALID", {
    query: { marketplaceIds: ["ATVPDKIKX0DER"], includedData: ["identifiers", "issues"], mode: "VALIDATION_PREVIEW" }, body: { productType: "PRODUCT", requirements: "LISTING", attributes: {} } });
  assertEquals(ok.status, "VALID");
  const bad = await A.sp(ctx, "PUT", "/listings/2021-08-01/items/AXXXXXXXXXXXXX/VALIDATION_INVALID", {
    query: { marketplaceIds: ["ATVPDKIKX0DER"], includedData: ["identifiers", "issues"], mode: "VALIDATION_PREVIEW" }, body: { productType: "PRODUCT", requirements: "LISTING", attributes: {} } });
  assertEquals(bad.status, "INVALID");
  assert(bad.issues.some((i: any) => i.severity === "ERROR" && i.attributeNames.includes("condition_type")));
});

Deno.test("İlan: barkodlu ürün katalogda varsa yalnız teklif (ASIN ile), prova modunda", async () => {
  calls.length = 0;
  const db = fakeDb();
  const r = await L.submitListing({
    db, ctx, market: US, sellerId: "AXXXXXXXXXXXXX", preview: true, stockQty: 7,
    listing: { id: "l1", user_id: "u", marketplace_code: "amazon_us", title: "Samsung QLED TV", description: "TV", price: 499.9, validation: null },
    product: { id: 4242, brand: "Samsung", gtin: "8806090193972", stock_qty: 7 }, variants: [], images: ["https://example.com/a.jpg"],
  });
  const put = calls.find((c) => c.method === "PUT")!;
  assertEquals(put.url.pathname, "/listings/2021-08-01/items/AXXXXXXXXXXXXX/SLT-4242");
  assertEquals(put.url.searchParams.get("mode"), "VALIDATION_PREVIEW");
  assertEquals(put.body.requirements, "LISTING_OFFER_ONLY");
  assertEquals(put.body.attributes.merchant_suggested_asin[0].value, "B07N4M94X4");
  assertEquals(put.body.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 499.9);
  assertEquals(put.body.attributes.fulfillment_availability[0].quantity, 7);
  assertEquals((r.amazon as any).asin, "B07N4M94X4");
  assertEquals((r.amazon as any).url, "https://www.amazon.com/dp/B07N4M94X4");
});

Deno.test("İlan: barkodsuz, seçenekli ürün -> ürün türü + şema + ana/alt SKU, GTIN muafiyeti, paralel", async () => {
  calls.length = 0;
  const db = fakeDb();
  const r = await L.submitListing({
    db, ctx, market: US, sellerId: "AXXXXXXXXXXXXX", preview: true, stockQty: 10,
    listing: { id: "l2", user_id: "u", marketplace_code: "amazon_us", title: "Seyahat bavulu kabin boy", description: "Hafif bavul", price: 80, bullet_points: ["Hafif", "4 tekerlek"], validation: null },
    product: { id: 77, brand: "Seltigo", supplier_price: 40, stock_qty: 10 },
    variants: [
      { id: "v1", is_active: true, attributes: { Size: "S" }, cost: 40, stock_qty: 4, image_url: "https://example.com/s.jpg" },
      { id: "v2", is_active: true, attributes: { Size: "M" }, cost: 50, stock_qty: 6 },
    ],
    images: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
  });
  assert(calls.some((c) => c.url.pathname === "/definitions/2020-09-01/productTypes"), "ürün türü arandı");
  assert(calls.some((c) => c.url.pathname === "/definitions/2020-09-01/productTypes/LUGGAGE"), "şema alındı");
  assertEquals(db.store.amazon_product_types.length, 1, "şema önbelleğe yazıldı");
  const puts = calls.filter((c) => c.method === "PUT");
  assertEquals(puts.length, 3, "ana + 2 seçenek");
  const parent = puts.find((p) => p.url.pathname.endsWith("/SLT-77"))!;
  assertEquals(parent.body.attributes.parentage_level[0].value, "parent");
  assertEquals(parent.body.attributes.variation_theme[0].name, "SIZE");
  const child = puts.find((p) => p.url.pathname.endsWith("/SLT-77-2"))!;
  assertEquals(child.body.attributes.child_parent_sku_relationship[0].parent_sku, "SLT-77");
  assertEquals(child.body.attributes.size[0].value, "M");
  assertEquals(child.body.attributes.fulfillment_availability[0].quantity, 6);
  assertEquals(child.body.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 100, "seçenek fiyatı alış oranıyla");
  assertEquals(child.body.attributes.supplier_declared_has_product_identifier_exemption[0].value, true);
  assertEquals(child.body.attributes.bullet_point.length, 2);
  assert(r.warnings.some((w) => w.code === "gtin_exemption"));
  assertEquals((r.amazon as any).skus.length, 3);
});

Deno.test("İlan: içerik aynı ve kabul edilmişse yalnız fiyat/stok PATCH (AI ve şema yok)", async () => {
  calls.length = 0;
  const db = fakeDb();
  const input: any = {
    db, ctx, market: US, sellerId: "AXXXXXXXXXXXXX", preview: false, stockQty: 3,
    listing: { id: "l3", user_id: "u", marketplace_code: "amazon_us", title: "Kupa", description: "Seramik", price: 10, validation: null },
    product: { id: 5, brand: "X", stock_qty: 3 }, variants: [], images: ["https://example.com/k.jpg"],
  };
  const first = await L.submitListing(input);
  // Sandbox PUT örneği "ACCEPTED" döner; ikinci çağrı (fiyat değişti) hızlı yoldan gitmeli
  input.listing.validation = { amazon: first.amazon };
  input.listing.price = 12;
  calls.length = 0;
  await L.submitListing(input).catch(() => null); // sandbox PATCH örneği gövde eşleşmesi istemez
  assert(calls.every((c) => c.method !== "PUT"), "PUT yok");
  assert(!calls.some((c) => c.url.pathname.startsWith("/definitions")), "şema sorulmadı");
  const patch = calls.find((c) => c.method === "PATCH")!;
  assertEquals(patch.body.patches.find((p: any) => p.path === "/attributes/purchasable_offer").value[0].our_price[0].schedule[0].value_with_tax, 12);
});

Deno.test("Sandbox: siparişler + kalemler -> Seltigo sipariş kaydı; kargo bildirimi gövdesi", async () => {
  const d = await A.sp(ctx, "GET", "/orders/v0/orders", { query: { CreatedAfter: "TEST_CASE_200", MarketplaceIds: ["ATVPDKIKX0DER"] } });
  const o = d.payload.Orders[0];
  assertEquals(O.STATUS[o.OrderStatus], "new");
  const items = (await A.sp(ctx, "GET", "/orders/v0/orders/TEST_CASE_200/orderItems")).payload.OrderItems;
  const addr = (await A.sp(ctx, "GET", "/orders/v0/orders/TEST_CASE_200/address")).payload.ShippingAddress;
  const row = O.buildOrderRow({ id: "c1", user_id: "u", marketplace_code: "amazon_us" }, US, { ...o, ShippingAddress: addr }, items[0], items.length,
    { productId: 5, variantId: null, listingId: "l3" });
  assertEquals(row.external_order_id, o.AmazonOrderId);
  assertEquals(row.status, "new");
  assertEquals(row.item_price, 10);
  assertEquals(row.currency, "USD");
  assertEquals(row.buyer_address.city, "SEATTLE");
  assertEquals(row.buyer_country, "US");
  assertEquals(row.raw.orderItemId, items[0].OrderItemId);
  const body = O.confirmBody(US, { id: "abc-def", quantity: 1, raw: row.raw }, "1Z999", "Yurtiçi Kargo");
  assertEquals(body.packageDetail.orderItems[0].orderItemId, items[0].OrderItemId);
  assertEquals(body.packageDetail.carrierName, "Yurtiçi Kargo");
  assertEquals(body.marketplaceId, "ATVPDKIKX0DER");
});

Deno.test("Barkod doğrulama ve SKU", () => {
  assert(A.validGtin("8806090193972"));
  assert(!A.validGtin("8806090193973"));
  assertEquals(A.gtinType("012345678905"), "upc");
  assertEquals(A.makeSku(12, "3"), "SLT-12-3");
});

Deno.test("İlan: barkodsuz ürün -> Amazon kataloğunda marka + modelle bulunur, yalnız teklif, barkod ürüne yazılır", async () => {
  calls.length = 0;
  const r = await L.submitListing({
    db: fakeDb(), ctx, market: US, sellerId: "AXXXXXXXXXXXXX", preview: true, stockQty: 2,
    listing: { id: "l4", user_id: "u", marketplace_code: "amazon_us", title: "Samsung 82 inç QLED 4K Smart TV", description: "TV", price: 1500, validation: null },
    product: { id: 9, brand: "Samsung", model_code: "QN82Q60RAFXZA", stock_qty: 2 }, variants: [], images: ["https://example.com/tv.jpg"],
  });
  const put = calls.find((c) => c.method === "PUT")!;
  assertEquals(put.body.requirements, "LISTING_OFFER_ONLY");
  assertEquals(put.body.productType, "TELEVISION");
  assertEquals((r.amazon as any).asin, "B07N4M94X4");
  assertEquals((r.amazon as any).foundGtin, "0887276302195");
  assert(!calls.some((c) => c.url.pathname.startsWith("/definitions")), "katalog eşleşince şema ve AI gerekmez");
});

Deno.test("Katalog eşleme güvenliği: marka farklıysa ya da model tutmuyorsa eşleme yok (AI yokken)", () => {
  const item = { summaries: [{ brand: "SAMSUNG", itemName: "Samsung QN82Q60RAFXZA Flat 82-Inch QLED 4K", modelNumber: "QN82Q60RAFXZA" }] };
  assertEquals(L.catalogScore({ brand: "Samsung", model_code: "QN82Q60RAFXZA" }, "", item), 1);
  assertEquals(L.catalogScore({ brand: "LG", model_code: "QN82Q60RAFXZA" }, "", item), 0);
  assert(L.catalogScore({ brand: "Samsung" }, "Samsung buzdolabı No Frost", item) < 0.5);
});

Deno.test("Etiket (Amazon Buy Shipping): istek Amazon örneğiyle birebir; uygun hizmet -> en ucuz -> etiket + takip no", async () => {
  calls.length = 0;
  // Amazon siparişindeki satıcı gönderim adresi (Orders API DefaultShipFromLocationAddress) -> ShipFromAddress
  const from = S.shipFromAddress({ DefaultShipFromLocationAddress: { Name: "John Doe", AddressLine1: "300 Turnbull Ave", City: "Detroit", StateOrRegion: "MI", PostalCode: "48123", CountryCode: "US", Phone: "7132341234" } },
    { email: "jdoeasdfllkj@yahoo.com" })!;
  const details = S.shipmentRequest({ amazonOrderId: "903-5563053-5647845", orderItemId: "52986411826454", quantity: 1, shipFrom: from, market: US,
    dims: { length: 10.25, width: 10.25, height: 10.25 }, weight: 10.25 });
  const label = await S.buyAmazonLabel(ctx, details);
  assertEquals(calls.map((c) => c.url.pathname).filter((x) => x.startsWith("/mfn")), ["/mfn/v0/eligibleShippingServices", "/mfn/v0/shipments"]);
  assertEquals(calls.find((c) => c.url.pathname === "/mfn/v0/shipments")!.body.ShippingServiceId, "UPS_PTP_2ND_DAY_AIR", "en ucuz hizmet");
  assertEquals(label.trackingId, "1Z17E2100217295733");
  assertEquals(label.carrier, "UPS");
  assertEquals(label.cost, 34.73);
  assertEquals(label.fileType, "image/png");
});

Deno.test("Etiket dosyası: Base64 + GZip PNG -> yazdırılabilir PDF; ölçü birimleri pazara göre", async () => {
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const gz = new Uint8Array(await new Response(new Blob([png]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const b64 = btoa(String.fromCharCode(...gz));
  const pdf = await S.labelToPdf({ fileType: "image/png", contents: b64 });
  assertEquals(new TextDecoder().decode(pdf.slice(0, 5)), "%PDF-");
  assertEquals(S.units(US).len, "inches");
  assertEquals(S.units(A.marketByCode("amazon_de")!).weight, "g");
  const p = S.parcelFor(US, { weight_kg: 1, length_cm: 25.4, width_cm: 25.4, height_cm: 25.4 }, 1);
  assertEquals(p.dims.length, 10);
  assertEquals(p.weight, 35.27);
});
