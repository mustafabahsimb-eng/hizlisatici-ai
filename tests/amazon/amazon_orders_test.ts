// Amazon sipariş akışı testi (Orders API v2026-01-01) — Amazon'un KENDİ statik sandbox örnekleriyle (selling-partner-api-models, sabit sürüm)
// Kapsam: tek istekte satıcının tüm pazarları, FBA atlanır, satıcı kargolu siparişin takip numarası, tekrar çekmede çift kayıt yok,
// durum değişimi, Türkiye siparişi alanları, kargo bildirimi (confirmShipment). Veritabanı taklittir; canlıya hiçbir şey gitmez.
// Çalıştırma: deno test -A --config <deno-check.json> tests/amazon/amazon_orders_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";

const MODELS_SHA = "3677bb9d96f4450e6843f1f8207005e925d5c867";
Deno.env.set("AMAZON_APP_ID", "amzn1.sp.solution.test");
Deno.env.set("AMAZON_LWA_CLIENT_ID", "amzn1.application-oa2-client.test");
Deno.env.set("AMAZON_LWA_CLIENT_SECRET", "test-secret");

const realFetch = globalThis.fetch;
const model = await (await realFetch(`https://raw.githubusercontent.com/amzn/selling-partner-api-models/${MODELS_SHA}/models/orders-api-model/orders_2026-01-01.json`)).json();
const ex = (op: string) => (Object.values<any>(model.paths).flatMap((p) => Object.values<any>(p)).find((o) => o?.operationId === op).responses["200"]["x-amzn-api-sandbox"].static as any[]);
const SEARCH = ex("searchOrders");
const GET = ex("getOrder");
// Amazon'un üç searchOrders örneğindeki siparişler (JP: FBA, UK: satıcı kargolu + DPD takip, BR: gönderilmemiş)
const ORDERS = SEARCH.flatMap((e) => e.response.orders);
const TR_ORDER = GET.find((e) => e.response.order?.salesChannel?.marketplaceId === "A33AVAJ2PDY3EV")!.response.order;

const calls: { method: string; url: URL; body: any }[] = [];
let ordersOverride: any[] | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method || "GET").toUpperCase();
  const raw = init?.body instanceof URLSearchParams ? init.body.toString() : init?.body;
  const body = raw && typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw) : null;
  calls.push({ method, url, body });
  const res = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
  if (url.host === "api.amazon.com") return res({ access_token: "Atza|test", expires_in: 3600 });
  if (url.pathname === "/orders/2026-01-01/orders") {
    // Amazon gibi: her iki zaman parametresi birden verilemez, pazarlar zorunlu
    if (url.searchParams.get("createdAfter") && url.searchParams.get("lastUpdatedAfter")) return res({ errors: [{ code: "InvalidInput" }] }, 400);
    const ids = (url.searchParams.get("marketplaceIds") || "").split(",");
    const list = (ordersOverride || ORDERS).filter((o) => ids.includes(o.salesChannel.marketplaceId));
    return res({ orders: list });
  }
  if (/\/orders\/v0\/orders\/[^/]+\/shipmentConfirmation$/.test(url.pathname)) return new Response(null, { status: 204 });
  return res({ errors: [{ code: "NotFound", message: url.pathname }] }, 404);
}) as typeof fetch;

const A = await import("../../supabase/functions/_shared/amazon.ts");
const O = await import("../../supabase/functions/_shared/amazon-orders.ts");

// Supabase istemcisi taklidi: select / eq / in / is / not / limit / maybeSingle / insert / update
function fakeDb(seed: Record<string, any[]> = {}) {
  const store: Record<string, any[]> = { marketplace_orders: [], listings: [], orders: [], ...seed };
  let seq = 1;
  const from = (table: string) => {
    store[table] ||= [];
    const f: ((r: any) => boolean)[] = [];
    let patch: any = null, lim = Infinity;
    const rows = () => store[table].filter((r) => f.every((x) => x(r))).slice(0, lim);
    const api: any = {
      select: () => api,
      eq: (k: string, v: unknown) => { f.push((r) => r[k] === v); return api; },
      in: (k: string, v: unknown[]) => { f.push((r) => v.includes(r[k])); return api; },
      is: (k: string, v: unknown) => { f.push((r) => (r[k] ?? null) === v); return api; },
      not: (k: string, _op: string, v: unknown) => { f.push((r) => (r[k] ?? null) !== v); return api; },
      limit: (n: number) => { lim = n; return api; },
      maybeSingle: async () => ({ data: rows()[0] || null }),
      insert: async (row: any) => { store[table].push({ id: "mo" + seq++, ...row }); return { error: null }; },
      update: (p: any) => { patch = p; return api; },
      then: (ok: any, bad: any) => {
        if (patch) { for (const r of rows()) Object.assign(r, patch); return Promise.resolve({ error: null }).then(ok, bad); }
        return Promise.resolve({ data: rows(), error: null }).then(ok, bad);
      },
    };
    return api;
  };
  return { from, store };
}

const ctx = { region: "eu" as const, refreshToken: "Atzr|r", sandbox: true };
const conn = (id: string, code: string) => ({ id, user_id: "u1", marketplace_code: code, settings: {} });

Deno.test("Sipariş: satıcının tüm pazarları TEK istekte (kota), FBA atlanır, satıcı kargolu sipariş takip numarasıyla gelir", async () => {
  calls.length = 0;
  const db = fakeDb({ listings: [{ id: "lst-uk", user_id: "u1", marketplace_code: "amazon_uk", product_id: 77, deleted_at: null, validation: { amazon: { skus: [{ sku: "SLT-77", variantId: null }] } } }] });
  // UK örneğindeki SKU'yu Seltigo SKU'su yap (gerçekte ilanı Seltigo açar)
  ordersOverride = structuredClone(ORDERS);
  ordersOverride.find((o) => o.salesChannel.marketplaceId === "A1F83G8C2ARO7P").orderItems[0].product.sellerSku = "SLT-77";
  const conns = [conn("c-jp", "amazon_jp"), conn("c-uk", "amazon_uk"), conn("c-br", "amazon_br")];
  const r = await O.syncSellerOrders(db, ctx, conns, Date.now() + 30_000);
  const searches = calls.filter((c) => c.url.pathname === "/orders/2026-01-01/orders");
  assertEquals(searches.length, 1, "tek istek");
  const q = searches[0].url.searchParams;
  assertEquals(q.get("marketplaceIds")!.split(",").sort(), ["A1F83G8C2ARO7P", "A1VC38T7YXB528", "A2Q3Y263D00KWC"]);
  assertEquals(q.get("fulfilledBy"), "MERCHANT");
  assert(q.get("lastUpdatedAfter") && !q.get("createdAfter"));
  assertEquals(q.get("includedData"), "BUYER,RECIPIENT,PROCEEDS,FULFILLMENT,PACKAGES");
  assert(r.complete);
  const rows = db.store.marketplace_orders;
  assert(!rows.some((x) => x.connection_id === "c-jp"), "FBA (Amazon gönderir) siparişi alınmaz");
  const uk = rows.find((x) => x.connection_id === "c-uk")!;
  assertEquals(uk.status, "shipped");
  assertEquals(uk.carrier, "DPD");
  assert(uk.tracking_number && uk.tracking_pushed_at, "satıcının girdiği takip numarası tekrar Amazon'a gönderilmez");
  assertEquals(uk.product_id, 77);
  assertEquals(uk.listing_id, "lst-uk");
  assertEquals(uk.currency, "GBP");
  assertEquals(uk.buyer_country, "GB");
  const br = rows.find((x) => x.connection_id === "c-br")!;
  assertEquals(br.status, "new");
  assertEquals(br.marketplace_code, "amazon_br");
  assert(br.item_price > 0);
  assert(br.raw.shipBy, "son gönderim zamanı saklanır");
  assertEquals(r.inserted, rows.length);
});

Deno.test("Sipariş: tekrar çekmede çift kayıt yok; iptal durumu güncellenir; gönderilmiş sipariş geri 'yeni' olmaz", async () => {
  const db = fakeDb();
  ordersOverride = structuredClone(ORDERS);
  const conns = [conn("c-uk", "amazon_uk"), conn("c-br", "amazon_br")];
  await O.syncSellerOrders(db, ctx, conns, Date.now() + 30_000);
  const n = db.store.marketplace_orders.length;
  await O.syncSellerOrders(db, ctx, conns, Date.now() + 30_000);
  assertEquals(db.store.marketplace_orders.length, n, "çift kayıt yok");
  const br = ordersOverride.find((o) => o.salesChannel.marketplaceId === "A2Q3Y263D00KWC");
  br.fulfillment.fulfillmentStatus = "CANCELLED";
  const uk = ordersOverride.find((o) => o.salesChannel.marketplaceId === "A1F83G8C2ARO7P");
  uk.fulfillment.fulfillmentStatus = "UNSHIPPED";
  const r = await O.syncSellerOrders(db, ctx, conns, Date.now() + 30_000);
  assertEquals(r.updated, 1);
  assertEquals(db.store.marketplace_orders.find((x) => x.connection_id === "c-br").status, "cancelled");
  assert(db.store.marketplace_orders.find((x) => x.connection_id === "c-br").cancelled_at);
  assertEquals(db.store.marketplace_orders.find((x) => x.connection_id === "c-uk").status, "shipped");
});

Deno.test("Sipariş: bekleyen (PENDING) sipariş işlenmez — ödeme onayı yok, adres yok", async () => {
  const db = fakeDb();
  ordersOverride = structuredClone(ORDERS).filter((o: any) => o.salesChannel.marketplaceId === "A2Q3Y263D00KWC");
  ordersOverride![0].fulfillment.fulfillmentStatus = "PENDING";
  const r = await O.syncSellerOrders(db, ctx, [conn("c-br", "amazon_br")], Date.now() + 30_000);
  assertEquals(r.inserted, 0);
});

Deno.test("Sipariş: Türkiye (Amazon örneği getOrder) -> Seltigo kaydı alanları", () => {
  const TR = A.marketByCode("amazon_tr")!;
  const it = TR_ORDER.orderItems[0];
  const row = O.buildOrderRow(conn("c-tr", "amazon_tr"), TR, TR_ORDER, it, 1, { productId: null, variantId: null, listingId: null });
  assertEquals(row.external_order_id, "028-1234567-8901234");
  assertEquals(row.marketplace_code, "amazon_tr");
  assertEquals(row.currency, "TRY");
  assertEquals(row.buyer_country, "TR");
  assertEquals(row.status, "shipped");
  assertEquals(row.ordered_at, TR_ORDER.createdTime);
  assert(row.buyer_address.city, "şehir dolu");
  assertEquals(row.raw.orderItemId, it.orderItemId);
  assertEquals(row.raw.order.recipient, undefined, "kişisel veri raw'a kopyalanmaz");
  assert(new Date(row.pii_anonymize_after).getTime() > Date.now() + 29 * 86400_000);
});

Deno.test("Kargo bildirimi: tedarikçi takip numarası -> confirmShipment (v0), sipariş 'gönderildi'", async () => {
  calls.length = 0;
  const db = fakeDb({
    marketplace_orders: [{ id: "11111111-2222", connection_id: "c-br", status: "new", tracking_pushed_at: null, quantity: 1, external_order_id: "171-2345678-9012345",
      raw: { amazonOrderId: "171-2345678-9012345", orderItemId: "17123456789012" } }],
    orders: [{ user_id: "u1", platform: "amazon_br", marketplace_order_no: "171-2345678-9012345", tracking_number: "BR123", tracking_carrier: "Correios" }],
  });
  const n = await O.confirmShipments(db, ctx, conn("c-br", "amazon_br"));
  assertEquals(n, 1);
  const c = calls.find((x) => x.url.pathname.endsWith("/shipmentConfirmation"))!;
  assertEquals(c.url.pathname, "/orders/v0/orders/171-2345678-9012345/shipmentConfirmation");
  assertEquals(c.body.marketplaceId, "A2Q3Y263D00KWC");
  assertEquals(c.body.packageDetail.trackingNumber, "BR123");
  assertEquals(c.body.packageDetail.carrierName, "Correios");
  assertEquals(c.body.packageDetail.orderItems[0].orderItemId, "17123456789012");
  const mo = db.store.marketplace_orders[0];
  assertEquals(mo.status, "shipped");
  assert(mo.tracking_pushed_at);
});
