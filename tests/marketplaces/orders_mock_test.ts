// Pazaryeri sipariş okuyucuları — taklit (mock) testler
// Örnek cevaplar resmi belgelerdeki yapıyla: Trendyol getShipmentPackages v2, n11 Sipariş Listeleme, Shopify Order, WooCommerce Order,
// Etsy ShopReceipt, eBay getOrders, Walmart getAllOrders, Wix searchOrders.
// Hepsiburada / Çiçeksepeti / Pazarama: resmi örnek bu ağdan erişilemedi; bilinen alan adlarıyla (esnek okuma) — satıcı hesabıyla doğrulanacak.
// Çalıştırma: deno test --allow-env --allow-net tests/marketplaces/orders_mock_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { adapterFor, statusOf } from "../../supabase/functions/_shared/marketplace-orders.ts";

type Call = { method: string; url: URL; headers: Headers; body: any };
let calls: Call[] = [];
let routes: ((c: Call) => Response | null)[] = [];
const j = (d: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", ...h } });
const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const raw = init?.body as any;
  let body: any = raw;
  try { body = typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw) : raw; } catch { /* */ }
  const c: Call = { method: (init?.method || "GET").toUpperCase(), url, headers: new Headers(init?.headers), body };
  calls.push(c);
  for (const r of routes) { const res = r(c); if (res) return res; }
  return j({ error: "no route " + url.href }, 404);
}) as typeof fetch;
const ctx = (code: string, creds: any, extra: any = {}) => ({ code, env: "live" as const, creds, since: new Date("2026-10-01T00:00:00Z"), until: new Date("2026-10-08T00:00:00Z"), fetch: mockFetch, ...extra });
function reset(...r: ((c: Call) => Response | null)[]) { calls = []; routes = r; }

Deno.test("Durum eşleme", () => {
  assertEquals(statusOf("Created"), "new");
  assertEquals(statusOf("Picking"), "new");
  assertEquals(statusOf("Shipped"), "shipped");
  assertEquals(statusOf("AtCollectionPoint"), "shipped");
  assertEquals(statusOf("Delivered"), "delivered");
  assertEquals(statusOf("Cancelled"), "cancelled");
  assertEquals(statusOf("UnSupplied"), "cancelled");
  assertEquals(statusOf("Returned"), "returned");
});

Deno.test("Trendyol: v2 adresi, Basic + User-Agent, 2 haftalık pencere, satırlar, kargo bilgisi", async () => {
  const pkg = (id: number, st: string) => ({
    id, shipmentPackageId: id, orderNumber: "10654411111", orderDate: 1762253333685, status: st, shipmentPackageStatus: st,
    cargoTrackingNumber: 7280027504111111, cargoProviderName: "Trendyol Express", currencyCode: "TRY", customerEmail: "pf+x@trendyolmail.com",
    shipmentAddress: { id: 1, firstName: "Trendyol", lastName: "Customer", address1: "Maslak Mah. Büyükdere Cad.", city: "İstanbul", cityCode: 34, district: "Sarıyer", postalCode: "34200", countryCode: "TR", phone: null, fullAddress: "...", fullName: "Trendyol Customer" },
    lines: [{ id: 4765111111, lineId: 4765111111, quantity: 2, merchantSku: "SLT-42", stockCode: "SLT-42", barcode: "8683772071724", productName: "Kupa", lineUnitPrice: 249.45, price: 249.45, currencyCode: "TRY", orderLineItemStatusName: st }],
  });
  reset((c) => c.url.pathname.includes("/integration/order/sellers/2738/v2/orders") ? j({ totalElements: 1, totalPages: 1, page: 0, size: 200, content: [pkg(3330111111, "Created")] }) : null);
  const lines = await adapterFor("trendyol_tr")!.fetchOrders(ctx("trendyol_tr", { sellerId: "2738", apiKey: "k", apiSecret: "s" }));
  assertEquals(calls[0].url.origin, "https://apigw.trendyol.com");
  assertEquals(calls[0].headers.get("authorization"), "Basic " + btoa("k:s"));
  assertEquals(calls[0].headers.get("user-agent"), "2738 - SelfIntegration");
  assertEquals(calls[0].url.searchParams.get("orderByField"), "PackageLastModifiedDate");
  const span = Number(calls[0].url.searchParams.get("endDate")) - Number(calls[0].url.searchParams.get("startDate"));
  assert(span <= 14 * 86400_000, "en fazla 2 hafta");
  assertEquals(lines.length, 1);
  const l = lines[0];
  assertEquals(l.externalId, "3330111111/4765111111");
  assertEquals(l.status, "new");
  assertEquals(l.quantity, 2);
  assertEquals(l.unitPrice, 249.45);
  assertEquals(l.sku, "SLT-42");
  assertEquals(l.barcode, "8683772071724");
  assertEquals(l.buyerName, "Trendyol Customer");
  assertEquals(l.address.city, "İstanbul");
  assertEquals(l.tracking, "7280027504111111");
  assertEquals(l.marketplaceShips, true);
  // Test ortamı (stage)
  reset((c) => c.url.pathname.includes("/v2/orders") ? j({ totalPages: 1, content: [] }) : null);
  await adapterFor("trendyol_tr")!.fetchOrders(ctx("trendyol_tr", { sellerId: "2738", apiKey: "k", apiSecret: "s" }, { env: "sandbox" }));
  assertEquals(calls[0].url.origin, "https://stageapigw.trendyol.com");
});

Deno.test("Trendyol: sayfalama (totalPages) ve uzun dönem pencerelere bölünür", async () => {
  let n = 0;
  reset((c) => { if (!c.url.pathname.includes("/v2/orders")) return null; n++; const page = Number(c.url.searchParams.get("page")); return j({ totalPages: 2, content: page === 0 ? [] : [] }); });
  await adapterFor("trendyol_tr")!.fetchOrders(ctx("trendyol_tr", { sellerId: "1", apiKey: "k", apiSecret: "s" }, { since: new Date("2026-09-01T00:00:00Z"), until: new Date("2026-10-01T00:00:00Z") }));
  assertEquals(n, 3 * 2, "30 gün = 3 pencere × 2 sayfa");
});

Deno.test("n11: shipmentPackages, appKey/appSecret başlıkları, lastModified, satırlar", async () => {
  reset((c) => c.url.pathname === "/rest/delivery/v1/shipmentPackages" ? j({
    pageCount: 1, totalPages: 1, page: 0, size: 100,
    content: [{ id: 2219443122, orderNumber: "209433446899", customerfullName: "Ali Veli", customerEmail: "a@b.com", cargoTrackingNumber: "112233", cargoProviderName: "Yurtiçi Kargo",
      shippingAddress: { fullName: "Ali Veli", address: "Cumhuriyet Mah. 1", city: "Ankara", district: "Çankaya", gsm: "5551112233" }, shipmentPackageStatus: "Picking",
      lastModifiedDate: 1760000000000, packageHistories: [{ createdDate: 1759990000000, status: "Created" }],
      lines: [{ orderLineId: 5011, quantity: 1, productName: "Termos", stockCode: "TRM-500", price: 349.9, orderItemLineItemStatusName: "Picking" }] }],
  }) : null);
  const lines = await adapterFor("n11_tr")!.fetchOrders(ctx("n11_tr", { apiKey: "ak", apiSecret: "as" }));
  assertEquals(calls[0].headers.get("appkey"), "ak");
  assertEquals(calls[0].headers.get("appsecret"), "as");
  assertEquals(calls[0].url.searchParams.get("orderByField"), "true");
  assertEquals(lines[0].externalId, "2219443122/5011");
  assertEquals(lines[0].sku, "TRM-500");
  assertEquals(lines[0].address.district, "Çankaya");
  assertEquals(lines[0].phone, "5551112233");
  assertEquals(lines[0].status, "new");
});

Deno.test("Hepsiburada (OMS): tarih biçimi, SIT adresi, esnek alanlar", async () => {
  reset((c) => c.url.pathname.startsWith("/orders/merchantid/") ? j({ totalCount: 1, limit: 50, offset: 0, items: [{
    orderNumber: "4012345678", orderDate: "2026-10-05T10:00:00", customerName: "Ayşe Y",
    shippingAddress: { name: "Ayşe Y", address: "Atatürk Cad. 5", town: "Karşıyaka", city: "İzmir", phoneNumber: "5320000000", email: "x@y.com", countryCode: "TR" },
    items: [{ lineItemId: "li-1", merchantSku: "SKU-9", quantity: 1, productName: "Lamba", unitPrice: { amount: 199.9, currency: "TRY" }, status: "Open" }],
  }] }) : null);
  const lines = await adapterFor("hepsiburada_tr")!.fetchOrders(ctx("hepsiburada_tr", { sellerId: "m-1", apiKey: "u", apiSecret: "p" }, { env: "sandbox" }));
  assertEquals(calls[0].url.origin, "https://oms-external-sit.hepsiburada.com");
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(calls[0].url.searchParams.get("begindate")!), "yyyy-MM-dd HH:mm");
  assertEquals(lines[0].externalId, "4012345678/li-1");
  assertEquals(lines[0].unitPrice, 199.9);
  assertEquals(lines[0].address.district, "Karşıyaka");
  assertEquals(lines[0].marketplaceShips, true);
});

Deno.test("Çiçeksepeti ve Pazarama: istek biçimi ve esnek okuma", async () => {
  reset((c) => c.url.pathname === "/api/v1/Order/GetOrders" ? j({ orderListCount: 1, pageCount: 1, supplierOrderListWithBranch: [{ orderId: 9001, orderItemId: 77, orderCreateDate: "2026-10-03T09:00:00", receiverName: "Can K", receiverAddress: "Gül Sok. 3", receiverCity: "Bursa", receiverDistrict: "Nilüfer", code: "GUL-1", quantity: 2, totalPrice: 300, orderItemStatus: "Yeni" }] }) : null);
  const cs = await adapterFor("ciceksepeti_tr")!.fetchOrders(ctx("ciceksepeti_tr", { apiKey: "x" }));
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.get("x-api-key"), "x");
  assertEquals(cs[0].unitPrice, 150);
  assertEquals(cs[0].externalId, "9001/77");
  reset(
    (c) => c.url.hostname === "isortagimgiris.pazarama.com" ? j({ data: { accessToken: "T" } }) : null,
    (c) => c.url.pathname === "/order/getOrdersForApi" ? j({ success: true, data: [{ orderNumber: "PZ-1", orderDate: "2026-10-02T12:00:00", shipmentAddress: { nameSurname: "Deniz A", addressDetail: "Lale Sok.", cityName: "Antalya", districtName: "Muratpaşa", phoneNumber: "5000" },
      items: [{ orderItemId: "i1", quantity: 1, salePrice: { value: 99 }, product: { name: "Tabak", stockCode: "TBK" }, orderItemStatusName: "Siparişiniz Alındı" }] }] }) : null,
  );
  const pz = await adapterFor("pazarama_tr")!.fetchOrders(ctx("pazarama_tr", { apiKey: "id", apiSecret: "sec" }));
  assertEquals(calls[1].headers.get("authorization"), "Bearer T");
  assertEquals(pz[0].sku, "TBK");
  assertEquals(pz[0].address.city, "Antalya");
});

Deno.test("Shopify: ödenmiş siparişler, Link başlığıyla sayfalama, takip: fulfillment_orders -> fulfillments", async () => {
  const order = (id: number, fs: string) => ({ id, name: "#" + id, created_at: "2026-10-04T10:00:00-04:00", financial_status: fs, fulfillment_status: null, cancelled_at: null, currency: "USD", email: "bob@example.com",
    shipping_address: { name: "Bob Norman", address1: "Chestnut Street 92", city: "Louisville", province: "Kentucky", zip: "40202", country_code: "US", phone: "+1(502)-459-2181" },
    line_items: [{ id: 466157049, title: "IPod Nano - 8gb", variant_title: "green", sku: "IPOD2008GREEN", quantity: 1, price: "199.00" }] });
  reset((c) => {
    if (!c.url.pathname.endsWith("/orders.json")) return null;
    return c.url.searchParams.get("page_info")
      ? j({ orders: [order(2, "pending")] })
      : j({ orders: [order(1, "paid")] }, 200, { link: '<https://shop.myshopify.com/admin/api/2024-10/orders.json?page_info=abc&limit=250>; rel="next"' });
  });
  const lines = await adapterFor("shopify")!.fetchOrders(ctx("shopify", { access_token: "shpat", shop_domain: "shop.myshopify.com" }));
  assertEquals(calls.length, 2, "ikinci sayfa da okundu");
  assertEquals(calls[0].headers.get("x-shopify-access-token"), "shpat");
  assertEquals(lines.length, 1, "ödenmemiş sipariş alınmaz");
  assertEquals(lines[0].unitPrice, 199);
  assertEquals(lines[0].productName, "IPod Nano - 8gb - green");
  assertEquals(lines[0].address.state, "Kentucky");
  reset(
    (c) => c.url.pathname.endsWith("/fulfillment_orders.json") ? j({ fulfillment_orders: [{ id: 1046000818, status: "open" }] }) : null,
    (c) => c.url.pathname.endsWith("/fulfillments.json") ? j({ fulfillment: { id: 1 } }, 201) : null,
  );
  await adapterFor("shopify")!.pushTracking!(ctx("shopify", { access_token: "t", shop_domain: "shop.myshopify.com" }), { raw: { orderId: 1 }, quantity: 1 }, "1Z999", "UPS");
  const f = calls.find((c) => c.url.pathname.endsWith("/fulfillments.json"))!;
  assertEquals(f.body.fulfillment.line_items_by_fulfillment_order[0].fulfillment_order_id, 1046000818);
  assertEquals(f.body.fulfillment.tracking_info.number, "1Z999");
});

Deno.test("WooCommerce: modified_after, ödenmemiş atlanır, takip notu + completed", async () => {
  reset((c) => c.url.pathname === "/wp-json/wc/v3/orders" ? j([
    { id: 727, number: "727", status: "processing", currency: "TRY", date_created_gmt: "2026-10-03T12:00:00", billing: { email: "j@x.com", phone: "555" },
      shipping: { first_name: "John", last_name: "Doe", address_1: "969 Market", city: "San Francisco", state: "CA", postcode: "94103", country: "US" },
      line_items: [{ id: 315, name: "Woo Single #1", sku: "W1", quantity: 2, price: 3 }] },
    { id: 728, status: "pending", line_items: [{ id: 1, quantity: 1 }] },
  ]) : null);
  const lines = await adapterFor("woocommerce")!.fetchOrders(ctx("woocommerce", { sellerId: "https://shop.test/", apiKey: "ck", apiSecret: "cs" }));
  assertEquals(calls[0].url.origin, "https://shop.test");
  assert(calls[0].url.searchParams.get("modified_after"));
  assertEquals(lines.length, 1);
  assertEquals(lines[0].externalId, "727/315");
  assertEquals(lines[0].buyerName, "John Doe");
  reset((c) => c.url.pathname.startsWith("/wp-json/wc/v3/orders/727") ? j({ ok: true }) : null);
  await adapterFor("woocommerce")!.pushTracking!(ctx("woocommerce", { sellerId: "https://shop.test", apiKey: "ck", apiSecret: "cs" }), { raw: { orderId: 727 } }, "TRK1", "Yurtiçi Kargo");
  assertEquals(calls.map((c) => c.method + " " + c.url.pathname), ["POST /wp-json/wc/v3/orders/727/notes", "PUT /wp-json/wc/v3/orders/727"]);
  assertEquals(calls[1].body.status, "completed");
});

Deno.test("Etsy: ShopReceipt + transactions (fiyat amount/divisor), takip bildirimi", async () => {
  reset((c) => c.url.pathname === "/v3/application/shops/555/receipts" ? j({ count: 1, results: [{ receipt_id: 1001, status: "Paid", is_shipped: false, name: "Jane Roe", first_line: "1 Main St", city: "Austin", state: "TX", zip: "73301", country_iso: "US", buyer_email: "jane@x.com", create_timestamp: 1759900000,
    transactions: [{ transaction_id: 2002, title: "Mug", quantity: 1, sku: "SLT-7", price: { amount: 1999, divisor: 100, currency_code: "USD" } }] }] }) : null);
  const lines = await adapterFor("etsy")!.fetchOrders(ctx("etsy", { access_token: "tok" }, { sellerId: "555" }));
  assertEquals(calls[0].headers.get("authorization"), "Bearer tok");
  assertEquals(lines[0].unitPrice, 19.99);
  assertEquals(lines[0].sku, "SLT-7");
  reset((c) => c.url.pathname.endsWith("/receipts/1001/tracking") ? j({ ok: true }) : null);
  await adapterFor("etsy")!.pushTracking!(ctx("etsy", { access_token: "tok" }, { sellerId: "555" }), { raw: { receiptId: 1001 } }, "LX1", "PTT");
  assertEquals(calls[0].body.tracking_code, "LX1");
});

Deno.test("eBay: getOrders filtre, sandbox adresi, takip: shipping_fulfillment", async () => {
  reset((c) => c.url.pathname === "/sell/fulfillment/v1/order" ? j({ total: 1, orders: [{ orderId: "04-12345-67890", creationDate: "2026-10-02T08:00:00.000Z", orderFulfillmentStatus: "NOT_STARTED", orderPaymentStatus: "PAID",
    buyer: { username: "buyer1" }, fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "Max M", contactAddress: { addressLine1: "Hauptstr. 1", city: "Berlin", postalCode: "10115", countryCode: "DE" }, primaryPhone: { phoneNumber: "+49" } } } }],
    lineItems: [{ lineItemId: "10001", sku: "SLT-9-1", title: "Shirt", quantity: 2, lineItemCost: { value: "40.00", currency: "EUR" } }] }] }) : null);
  const lines = await adapterFor("ebay_de")!.fetchOrders(ctx("ebay_de", { access_token: "v^1" }, { env: "sandbox" }));
  assertEquals(calls[0].url.origin, "https://api.sandbox.ebay.com");
  assert(calls[0].url.searchParams.get("filter")!.startsWith("lastmodifieddate:["));
  assertEquals(lines[0].unitPrice, 20);
  assertEquals(lines[0].address.country, "DE");
  reset((c) => c.url.pathname.endsWith("/shipping_fulfillment") ? j({}, 201) : null);
  await adapterFor("ebay_de")!.pushTracking!(ctx("ebay_de", { access_token: "v^1" }), { raw: { orderId: "04-12345-67890", lineId: "10001" }, quantity: 2 }, "DHL1", "DHL");
  assertEquals(calls[0].body.lineItems[0].lineItemId, "10001");
  assertEquals(calls[0].body.trackingNumber, "DHL1");
});

Deno.test("Walmart: token + WM başlıkları, orderLines, imleçle sayfalama, takip", async () => {
  reset(
    (c) => c.url.pathname === "/v3/token" ? j({ access_token: "WMT", expires_in: 900 }) : null,
    (c) => c.url.pathname === "/v3/orders" ? j({ list: { meta: { nextCursor: c.url.searchParams.get("cursor") ? null : "?cursor=2&limit=200" }, elements: { order: c.url.searchParams.get("cursor") ? [] : [{
      purchaseOrderId: "1796277083022", customerOrderId: "5281956426648", orderDate: 1760000000000, customerEmailId: "x@relay.walmart.com",
      shippingInfo: { phone: "2342423234", postalAddress: { name: "Asha Chetty", address1: "860 W California Ave", city: "Sunnyvale", state: "CA", postalCode: "94086", country: "USA" } },
      orderLines: { orderLine: [{ lineNumber: "1", item: { productName: "Mug", sku: "SLT-3" }, charges: { charge: [{ chargeType: "PRODUCT", chargeAmount: { currency: "USD", amount: 22 } }] },
        orderLineQuantity: { unitOfMeasurement: "EACH", amount: "2" }, orderLineStatuses: { orderLineStatus: [{ status: "Acknowledged" }] } }] } }] } } }) : null,
  );
  const lines = await adapterFor("walmart_us")!.fetchOrders(ctx("walmart_us", { apiKey: "cid", apiSecret: "cs" }, { env: "sandbox" }));
  const ord = calls.filter((c) => c.url.pathname === "/v3/orders");
  assertEquals(ord.length, 2, "nextCursor izlendi");
  assertEquals(ord[0].url.origin, "https://sandbox.walmartapis.com");
  assertEquals(ord[0].headers.get("wm_sec.access_token"), "WMT");
  assertEquals(lines[0].unitPrice, 11);
  assertEquals(lines[0].status, "new");
});

Deno.test("Wix: searchOrders (imleç), takip: create-fulfillment", async () => {
  reset((c) => c.url.pathname === "/ecom/v1/orders/search" ? j({ orders: [{ id: "o-1", number: "10001", createdDate: "2026-10-01T10:00:00Z", status: "APPROVED", paymentStatus: "PAID", fulfillmentStatus: "NOT_FULFILLED", currency: "EUR", buyerInfo: { email: "w@x.com" },
    shippingInfo: { logistics: { shippingDestination: { address: { addressLine: "Rue 1", city: "Paris", postalCode: "75001", country: "FR" }, contactDetails: { firstName: "Léa", lastName: "D" } } } },
    lineItems: [{ id: "li-9", productName: { original: "Bag" }, quantity: 1, price: { amount: "35.00" }, physicalProperties: { sku: "BAG" } }] }], metadata: { cursors: {} } }) : null);
  const lines = await adapterFor("wix")!.fetchOrders(ctx("wix", { access_token: "OAUTH" }));
  assertEquals(calls[0].headers.get("authorization"), "OAUTH");
  assertEquals(lines[0].buyerName, "Léa D");
  assertEquals(lines[0].unitPrice, 35);
  reset((c) => c.url.pathname.endsWith("/create-fulfillment") ? j({}) : null);
  await adapterFor("wix")!.pushTracking!(ctx("wix", { access_token: "OAUTH" }), { raw: { orderId: "o-1", lineId: "li-9" }, quantity: 1 }, "TR1", "UPS");
  assertEquals(calls[0].body.fulfillment.trackingInfo.trackingNumber, "TR1");
});

Deno.test("Hata: 401 -> durum kodu taşınır (işçi bağlantıyı 'süresi doldu' yapar); 429 tekrar denenir", async () => {
  let n = 0;
  reset((c) => c.url.pathname === "/rest/delivery/v1/shipmentPackages" ? (++n < 2 ? j({}, 429) : j({ totalPages: 1, content: [] })) : null);
  await adapterFor("n11_tr")!.fetchOrders(ctx("n11_tr", { apiKey: "a", apiSecret: "b" }, { since: new Date("2026-10-07T00:00:00Z") }));
  assertEquals(n, 2);
  reset(() => j({ message: "unauthorized" }, 401));
  let status = 0;
  try { await adapterFor("trendyol_tr")!.fetchOrders(ctx("trendyol_tr", { sellerId: "1", apiKey: "a", apiSecret: "b" })); } catch (e) { status = (e as any).status; }
  assertEquals(status, 401);
});
