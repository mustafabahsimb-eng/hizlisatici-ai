// Trendruum — taklit (mock) testler. Trendruum'un API belgesi yalnız satıcı panelinde; cevaplar entegratör rehberlerindeki
// akışla (Client ID + Secret -> JWT, en alt kategori, marka listesi, kategori nitelikleri, toplu ürün işlemi, sipariş paketleri) kurgulandı.
// Satıcı hesabı açılınca gerçek cevaplarla karşılaştırılıp _shared/trendruum.ts PATHS / alan adları doğrulanacak (docs/trendruum.md).
// Çalıştırma: deno test --config %LOCALAPPDATA%/seltigo-e2e/deno-check.json --allow-env --allow-net tests/marketplaces/trendruum_mock_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import {
  barcodeFor, buildItems, categoryAttributes, fillAttributes, findBrand, localChecks, pickCategory, submitProducts, trApi,
  trendruumLeafCategories, trendruumToken, updatePriceStock, verifyTrendruum,
} from "../../supabase/functions/_shared/trendruum.ts";
import { adapterFor } from "../../supabase/functions/_shared/marketplace-orders.ts";

type Call = { method: string; url: URL; headers: Headers; body: any };
let calls: Call[] = [];
let routes: ((c: Call) => Response | null)[] = [];
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const raw = init?.body as any;
  let body: any = raw;
  try { body = typeof raw === "string" && /^[\[{]/.test(raw) ? JSON.parse(raw) : raw; } catch { /* */ }
  const c: Call = { method: (init?.method || "GET").toUpperCase(), url, headers: new Headers(init?.headers), body };
  calls.push(c);
  for (const r of routes) { const res = r(c); if (res) return res; }
  return j({ error: "no route " + url.pathname }, 404);
}) as typeof fetch;
function reset(...r: ((c: Call) => Response | null)[]) { calls = []; routes = r; }
let n = 0;
const ctx = () => ({ creds: { clientId: "cid-" + (++n), clientSecret: "sec" }, env: "live" as const, fetch: mockFetch }); // her testte yeni anahtar (önbellek karışmasın)
const jwt = (expSec: number) => "h." + btoa(JSON.stringify({ exp: expSec })).replace(/=+$/, "") + ".s";
const tokenRoute = (c: Call) => c.url.pathname === "/auth/token" ? j({ access_token: jwt(Math.floor(Date.now() / 1000) + 3600), expires_in: 3600 }) : null;
const on = () => Deno.env.set("TRENDRUUM_ENABLED", "true");
const off = () => Deno.env.delete("TRENDRUUM_ENABLED");

Deno.test("Doğrulama: entegrasyon kapalıyken istek atılmaz, 'onay bekliyor' döner", async () => {
  off(); reset(tokenRoute);
  const r = await verifyTrendruum(ctx());
  assertEquals(r.connected, false);
  assertEquals(r.pending, true);
  assertEquals(calls.length, 0);
});

Deno.test("Doğrulama: açıkken Client ID + Secret ile JWT alınır; yanlış bilgide Türkçe hata", async () => {
  on(); reset(tokenRoute);
  const c = ctx();
  assertEquals((await verifyTrendruum(c)).connected, true);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].url.origin, "https://api.trendruum.com");
  assertEquals(calls[0].body, { client_id: c.creds.clientId, client_secret: "sec", grant_type: "client_credentials" });
  reset((x) => x.url.pathname === "/auth/token" ? j({ message: "invalid_client" }, 401) : null);
  const bad = await verifyTrendruum(ctx());
  assertEquals(bad.connected, false);
  assert(String(bad.error).includes("Client ID veya Client Secret hatalı"));
  off();
});

Deno.test("Erişim anahtarı önbellekte tutulur; 401 gelince bir kez yenilenip istek tekrarlanır", async () => {
  on();
  let first = true;
  reset(tokenRoute, (c) => {
    if (c.url.pathname !== "/brands") return null;
    if (first) { first = false; return j({ message: "expired" }, 401); }
    return j({ data: [{ id: 5, name: "Seltigo" }] });
  });
  const c = ctx();
  await trendruumToken(c);
  await trendruumToken(c);
  assertEquals(calls.filter((x) => x.url.pathname === "/auth/token").length, 1);
  const d = await trApi(c, "GET", "/brands", { query: { name: "Seltigo" } });
  assertEquals(d.data[0].id, 5);
  assertEquals(calls.filter((x) => x.url.pathname === "/auth/token").length, 2); // 401 -> yeni anahtar
  assert(calls.at(-1)!.headers.get("authorization")!.startsWith("Bearer h."));
  assertEquals(calls.at(-1)!.url.searchParams.get("name"), "Seltigo");
  off();
});

Deno.test("Kategori: yalnız en alt kategoriler; öğrenilen kategori doğrudan, yoksa kelime eşleşmesi", async () => {
  on();
  const tree = { data: [
    { id: 1, name: "Ev & Yaşam", subCategories: [{ id: 11, name: "Mutfak", subCategories: [{ id: 111, name: "Kupa", subCategories: [] }, { id: 112, name: "Tabak", subCategories: [] }] }] },
    { id: 2, name: "Giyim", subCategories: [{ id: 21, name: "Sweatshirt", subCategories: [] }] },
  ] };
  reset(tokenRoute, (c) => c.url.pathname === "/categories" ? j(tree) : null);
  const c = ctx();
  const leaves = await trendruumLeafCategories(c);
  assertEquals(leaves.map((l) => l.id), [111, 112, 21]);
  assertEquals(leaves[0].path, "Ev & Yaşam > Mutfak > Kupa");
  assertEquals((await pickCategory(c, { title: "Seramik kahve kupa 350 ml", description: "" }, null))!.id, 111);
  assertEquals((await pickCategory(c, { title: "Herhangi", description: "" }, 21))!.id, 21); // satıcının önceki ilanından öğrenilen
  off();
});

Deno.test("Marka: Trendruum listesinde birebir (büyük/küçük harf duyarsız) eşleşme; yoksa null", async () => {
  on();
  reset(tokenRoute, (c) => c.url.pathname === "/brands" ? j({ data: [{ id: 7, name: "Paşabahçe Mağazaları" }, { id: 8, name: "Paşabahçe" }] }) : null);
  const c = ctx();
  assertEquals(await findBrand(c, "PAŞABAHÇE"), { id: 8, name: "Paşabahçe" });
  assertEquals(await findBrand(c, "Yok Marka"), null);
  assertEquals(await findBrand(c, ""), null);
  off();
});

Deno.test("Nitelikler: üründeki bilgi değer listesine eşlenir, özel değer izinliyse metin, eksik zorunlu raporlanır (AI anahtarı yok)", async () => {
  on();
  reset(tokenRoute, (c) => c.url.pathname === "/categories/21/attributes" ? j({ categoryAttributes: [
    { attribute: { id: 47, name: "Renk" }, required: true, varianter: true, allowCustom: false, attributeValues: [{ id: 1, name: "Siyah" }, { id: 2, name: "Beyaz" }] },
    { attribute: { id: 338, name: "Beden" }, required: true, varianter: true, allowCustom: false, attributeValues: [{ id: 10, name: "M" }, { id: 11, name: "L" }] },
    { attribute: { id: 179, name: "Materyal" }, required: false, allowCustom: true, attributeValues: [] },
    { attribute: { id: 500, name: "Yaş Grubu" }, required: true, allowCustom: false, attributeValues: [{ id: 90, name: "Yetişkin" }] },
  ] }) : null);
  const attrs = await categoryAttributes(ctx(), 21);
  assertEquals(attrs.filter((a) => a.varianter).map((a) => a.id), [47, 338]);
  const r = await fillAttributes(attrs, { title: "Sweatshirt", description: "", specs: { Materyal: "Pamuk" } }, { color: "Siyah", size: "L" });
  assertEquals(r.list, [{ attributeId: 47, attributeValueId: 1 }, { attributeId: 338, attributeValueId: 11 }, { attributeId: 179, customAttributeValue: "Pamuk" }]);
  assertEquals(r.missing, ["Yaş Grubu"]);
  off();
});

const listing = { id: "L1", product_id: 42, title: "Seramik Kupa ".repeat(10).trim(), description: "Güzel kupa", price: 249.9, compare_at_price: 299.9, currency: "TRY", vat_rate_pct: 20 };
const product = { id: 42, brand: "Seltigo", gtin: "8680000000017", stock_qty: 12, weight_kg: 1.4 };

Deno.test("Yerel kontroller: başlık kesme, para birimi, KDV, görsel, barkod uyarıları", () => {
  const ok = localChecks({ listing, product, variants: [], images: ["https://x/1.jpg"] });
  assertEquals(ok.errors, []);
  assert(ok.warnings.some((w) => w.code === "title_trimmed"));
  const bad = localChecks({ listing: { ...listing, currency: "EUR", vat_rate_pct: 18, price: 0, description: "" }, product: { id: 42 }, variants: [], images: ["http://x/1.jpg"] });
  assertEquals(bad.errors.map((e) => e.code).sort(), ["currency_not_try", "description_missing", "images_missing", "price_missing", "vat_invalid"]);
  assert(bad.warnings.some((w) => w.code === "barcode_generated"));
  assert(bad.warnings.some((w) => w.code === "brand_missing"));
});

Deno.test("İlan kalemleri: tek ürün ve seçenekli ürün (her seçenek ayrı barkod, ortak ana kod, seçenek görseli önde)", () => {
  const one = buildItems({ listing, product, variants: [{ id: "v0", is_default: true, stock_qty: 12 }], images: ["https://x/1.jpg", "http://x/2.jpg"] }, { categoryId: 111, brandId: 8, attributes: [{ attributeId: 179, customAttributeValue: "Seramik" }] });
  assertEquals(one.length, 1);
  assertEquals(one[0].barcode, "8680000000017");
  assertEquals(one[0].productMainId, "SLT-42");
  assertEquals((one[0].title as string).length, 100);
  assertEquals(one[0].quantity, 12);
  assertEquals(one[0].salePrice, 249.9);
  assertEquals(one[0].listPrice, 299.9);
  assertEquals(one[0].dimensionalWeight, 2);
  assertEquals(one[0].images, [{ url: "https://x/1.jpg" }]);
  const vs = [
    { id: "v0", is_default: true, stock_qty: 5 },
    { id: "aaaa1111-bbbb", is_default: false, gtin: "8680000000024", stock_qty: 3, image_url: "https://x/siyah.jpg", attributes: { color: "Siyah" } },
    { id: "cccc2222-dddd", is_default: false, stock_qty: 0, attributes: { color: "Beyaz" } },
  ];
  const many = buildItems({ listing, product, variants: vs, images: ["https://x/1.jpg"] }, { categoryId: 21, brandId: 8, attributes: [], perVariant: { "aaaa1111-bbbb": [{ attributeId: 47, attributeValueId: 1 }], "cccc2222-dddd": [{ attributeId: 47, attributeValueId: 2 }] } });
  assertEquals(many.map((i) => i.barcode), ["8680000000024", "SLT42-cccc2222"]);
  assertEquals(many.map((i) => i.quantity), [3, 0]);
  assertEquals(many[0].images, [{ url: "https://x/siyah.jpg" }, { url: "https://x/1.jpg" }]);
  assertEquals(many[1].attributes, [{ attributeId: 47, attributeValueId: 2 }]);
  assertEquals(new Set(many.map((i) => i.productMainId)).size, 1);
  assertEquals(barcodeFor(listing, { id: 9 }, null), { code: "SLT9", generated: true });
});

Deno.test("Gönderim: toplu ürün işlemi + sonuç sorgusu; fiyat / stok ayrı uçtan", async () => {
  on();
  let polls = 0;
  reset(
    tokenRoute,
    (c) => c.url.pathname === "/products" && c.method === "POST" ? j({ batchRequestId: "B-77" }) : null,
    (c) => c.url.pathname === "/products/batch-requests/B-77" ? (++polls === 1 ? j({ items: [{ barcode: "8680000000017", status: "IN_PROGRESS" }] }) : j({ items: [{ barcode: "8680000000017", status: "SUCCESS" }, { requestItem: { barcode: "X2" }, status: "FAILED", failureReasons: ["Kategori özelliği eksik"] }] })) : null,
    (c) => c.url.pathname === "/products/price-and-inventory" ? j({ batchRequestId: "PS-1" }) : null,
  );
  const c = ctx();
  const items = buildItems({ listing, product, variants: [], images: ["https://x/1.jpg"] }, { categoryId: 111, brandId: 8, attributes: [] });
  const r = await submitProducts(c, items);
  const sent = calls.find((x) => x.url.pathname === "/products")!;
  assertEquals(sent.body.items[0].categoryId, 111);
  assertEquals(sent.body.items[0].brandId, 8);
  assertEquals(r.batchId, "B-77");
  assertEquals(r.results, [{ barcode: "8680000000017", status: "success", reason: undefined }, { barcode: "X2", status: "failed", reason: "Kategori özelliği eksik" }]);
  assertEquals(await updatePriceStock(c, [{ barcode: "8680000000017", quantity: 0, salePrice: 249.9, listPrice: 299.9 }]), "PS-1");
  assertEquals(calls.at(-1)!.body, { items: [{ barcode: "8680000000017", quantity: 0, salePrice: 249.9, listPrice: 299.9 }] });
  assertEquals(await updatePriceStock(c, []), null);
  off();
});

Deno.test("Siparişler: kapalıyken boş; açıkken paket satırları, Trendruum Kargo ayrımı, takip bildirimi", async () => {
  const ad = adapterFor("trendruum_tr")!;
  const octx = (fetchImpl: typeof fetch) => ({ code: "trendruum_tr", env: "live" as const, creds: { sellerId: "Mağazam", apiKey: "cid-o" + (++n), apiSecret: "sec" }, since: new Date("2026-10-01T00:00:00Z"), until: new Date("2026-10-08T00:00:00Z"), fetch: fetchImpl });
  off(); reset(tokenRoute);
  assertEquals(await ad.fetchOrders(octx(mockFetch)), []);
  assertEquals(calls.length, 0);
  on();
  reset(tokenRoute, (c) => c.url.pathname === "/orders" ? j({ totalPages: 1, content: [
    { packageId: "P-1", orderNumber: "TR-1001", orderDate: "2026-10-03T10:00:00Z", status: "Created", customerEmail: "a@b.c",
      shipmentAddress: { fullName: "Ayşe Y", fullAddress: "Gül Sok. 1", city: "İzmir", district: "Bornova", phone: "5551112233" },
      lines: [{ lineId: "l1", quantity: 2, unitPrice: 120, barcode: "8680000000017", stockCode: "SLT-42", productName: "Kupa" }] },
    { packageId: "P-2", orderNumber: "TR-1002", orderDate: "2026-10-04T10:00:00Z", status: "Shipped", cargoProviderName: "Trendruum Kargo", cargoTrackingNumber: "TK123",
      shipmentAddress: { fullName: "Mehmet K", fullAddress: "Lale Sok. 2", city: "Ankara", district: "Çankaya" },
      lines: [{ lineId: "l9", quantity: 1, amount: 80, barcode: "X" }] },
  ] }) : null, (c) => c.url.pathname === "/orders/P-1/shipment" ? j({ ok: true }) : null);
  const lines = await ad.fetchOrders(octx(mockFetch));
  const q = calls.find((x) => x.url.pathname === "/orders")!.url.searchParams;
  assertEquals(q.get("startDate"), "2026-10-01T00:00:00.000Z");
  assertEquals(lines.length, 2);
  assertEquals(lines[0].externalId, "P-1/l1");
  assertEquals(lines[0].status, "new");
  assertEquals(lines[0].unitPrice, 120);
  assertEquals(lines[0].sku, "SLT-42");
  assertEquals(lines[0].address.district, "Bornova");
  assertEquals(lines[0].marketplaceShips, false); // satıcı kendi kargosuyla gönderir -> Seltigo etiket + takip bildirimi
  assertEquals(lines[1].status, "shipped");
  assertEquals(lines[1].marketplaceShips, true);  // Trendruum Kargo
  assertEquals(lines[1].tracking, "TK123");
  assertEquals(lines[1].unitPrice, 80);
  const c2 = octx(mockFetch);
  await ad.pushTracking!(c2, { raw: { packageId: "P-1" }, quantity: 2 }, "YK999", "Yurtiçi Kargo");
  const push = calls.at(-1)!;
  assertEquals(push.method, "PUT");
  assertEquals(push.url.pathname, "/orders/P-1/shipment");
  assertEquals(push.body.trackingNumber, "YK999");
  assertEquals(push.body.cargoCompany, "Yurtiçi Kargo");
  const before = calls.length;
  await ad.pushTracking!(c2, { raw: { packageId: "P-2", marketplaceShips: true }, quantity: 1 }, "TK123", null);
  assertEquals(calls.length, before); // Trendruum Kargo paketine tekrar yazılmaz
  off();
});

Deno.test("Uç noktalar secret ile değiştirilebilir (belge geldiğinde kod değişmeden)", async () => {
  on();
  Deno.env.set("TRENDRUUM_API_BASE", "https://seller-api.trendruum.example/v1");
  Deno.env.set("TRENDRUUM_PATHS", JSON.stringify({ token: "/oauth/token", brands: "/catalog/brands" }));
  reset((c) => c.url.pathname === "/v1/oauth/token" ? j({ data: { accessToken: jwt(Math.floor(Date.now() / 1000) + 600) } }) : null,
    (c) => c.url.pathname === "/v1/catalog/brands" ? j([{ id: 3, name: "Acme" }]) : null);
  assertEquals(await findBrand(ctx(), "acme"), { id: 3, name: "Acme" });
  assertEquals(calls[0].url.host, "seller-api.trendruum.example");
  Deno.env.delete("TRENDRUUM_API_BASE");
  Deno.env.delete("TRENDRUUM_PATHS");
  off();
});
