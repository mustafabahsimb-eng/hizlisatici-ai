// Pazaryeri iade adaptörleri — taklit (mock) testler (Trendyol claims, n11 ReturnService SOAP).
// Çalıştırma: deno test --allow-env --allow-net tests/returns/returns_adapters_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { n11Returns, reasonOf, returnsAdapterFor, trendyolReturns } from "../../supabase/functions/_shared/marketplace-returns.ts";

type Call = { url: string; method: string; headers: Headers; body: string };
function mockFetch(handler: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input), method: (init?.method || "GET").toUpperCase(), headers: new Headers(init?.headers), body: String(init?.body ?? "") };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { f, calls };
}
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const creds = { sellerId: "123", apiKey: "k", apiSecret: "s" };

Deno.test("Neden eşleme (Türkçe metinden)", () => {
  assertEquals(reasonOf("Beden küçük geldi"), "size");
  assertEquals(reasonOf("Ürün kusurlu, çalışmıyor"), "defective");
  assertEquals(reasonOf("Kutu ezik / kırık geldi"), "damaged");
  assertEquals(reasonOf("Yanlış ürün gönderilmiş"), "wrong_item");
  assertEquals(reasonOf("Vazgeçtim"), "changed_mind");
  assertEquals(reasonOf("başka"), "other");
  assertEquals(returnsAdapterFor("trendyol_tr"), trendyolReturns);
  assertEquals(returnsAdapterFor("hepsiburada_tr"), null);
});

Deno.test("Trendyol: talep listesi (sayfalı) -> durum, neden, tutar, satır numaraları", async () => {
  const page = (p: number) => ({
    totalPages: 2,
    content: p === 0
      ? [{ id: "C1", orderNumber: "TY100", claimDate: 1760000000000, customerFirstName: "Ayşe", customerLastName: "Y",
          items: [{ orderLine: { id: 55, price: 199.9, barcode: "869", merchantSku: "SKU1", productName: "Elbise" },
            claimItems: [{ id: "ci1", claimItemStatus: { name: "WaitingInAction" }, customerClaimItemReason: { name: "Beden uymadı" }, customerNote: "küçük" }, { id: "ci2", claimItemStatus: { name: "WaitingInAction" } }] }] }]
      : [{ id: "C2", orderNumber: "TY200", claimDate: 1760000000000, items: [{ orderLine: { id: 56, price: 50 }, claimItems: [{ id: "ci3", claimItemStatus: { name: "Accepted" }, customerClaimItemReason: { name: "Ürün kusurlu" } }] }] }],
  });
  const { f, calls } = mockFetch((c) => j(page(Number(new URL(c.url).searchParams.get("page")))));
  const list = await trendyolReturns.list({ env: "live", creds, since: new Date(Date.now() - 86400000), fetch: f });
  assertEquals(calls.length, 2, "2 sayfa");
  assert(calls[0].url.startsWith("https://apigw.trendyol.com/integration/order/sellers/123/claims?"));
  assertEquals(calls[0].headers.get("authorization"), "Basic " + btoa("k:s"));
  assertEquals(calls[0].headers.get("user-agent"), "123 - SelfIntegration");
  assertEquals(list.length, 2);
  const a = list[0];
  assertEquals([a.externalId, a.claimRef, a.orderNo, a.status, a.reasonCode, a.quantity], ["C1/55", "C1", "TY100", "received", "size", 2]);
  assertEquals(a.lineRefs, ["ci1", "ci2"]);
  assertEquals(a.amount, 199.9 * 2);
  assertEquals(a.customerName, "Ayşe Y");
  assertEquals([list[1].status, list[1].reasonCode], ["refunded", "defective"]);
});

Deno.test("Trendyol: test ortamı adresi ve onay isteği (PUT, claimLineItemIdList)", async () => {
  const { f, calls } = mockFetch(() => new Response("", { status: 200 }));
  await trendyolReturns.approve({ env: "sandbox", creds, since: new Date(), fetch: f }, { claimRef: "C1", lineRefs: ["ci1", "ci2"] });
  assertEquals(calls[0].method, "PUT");
  assertEquals(calls[0].url, "https://stageapigw.trendyol.com/integration/order/sellers/123/claims/C1/items/approve");
  assertEquals(JSON.parse(calls[0].body), { claimLineItemIdList: ["ci1", "ci2"], params: {} });
  const bad = mockFetch(() => new Response("hata", { status: 400 }));
  let err = "";
  try { await trendyolReturns.approve({ env: "live", creds, since: new Date(), fetch: bad.f }, { claimRef: "C1", lineRefs: [] }); } catch (e) { err = (e as Error).message; }
  assert(err.includes("trendyol approve 400"), err);
});

Deno.test("n11: ClaimReturnList (3 durum) ayrıştırma + ClaimReturnApprove SOAP gövdesi", async () => {
  const xml = (st: string) => st === "REQUESTED"
    ? `<s:Envelope><s:Body><ns3:ClaimReturnListResponse><result><status>success</status></result><claimReturnList><claimReturn><claimReturnId>9001</claimReturnId><orderNumber>N11-5</orderNumber><status>REQUESTED</status><returnReasonType>Hasarlı</returnReasonType><returnReasonDescription>kutu ezik</returnReasonDescription><quantity>1</quantity><finalPrice>120.5</finalPrice><productName>Kupa</productName><buyerName>Ali V</buyerName><requestDate>14/10/2026</requestDate></claimReturn></claimReturnList><pagingData><pageCount>1</pageCount></pagingData></ns3:ClaimReturnListResponse></s:Body></s:Envelope>`
    : st === "APPROVED"
      ? `<s:Envelope><s:Body><r><result><status>success</status></result><claimReturnList><claimReturn><claimReturnId>9002</claimReturnId><orderNumber>N11-6</orderNumber><status>APPROVED</status><quantity>2</quantity><unitPrice>10</unitPrice></claimReturn></claimReturnList><pagingData><pageCount>1</pageCount></pagingData></r></s:Body></s:Envelope>`
      : `<s:Envelope><s:Body><r><result><status>success</status></result><claimReturnList></claimReturnList></r></s:Body></s:Envelope>`;
  const { f, calls } = mockFetch((c) => new Response(xml(/<status>(\w+)<\/status>/.exec(c.body)![1]), { status: 200 }));
  const list = await n11Returns.list({ env: "live", creds: { apiKey: "ak", apiSecret: "as" }, since: new Date(2026, 9, 1), fetch: f });
  assertEquals(calls.length, 3);
  assert(calls[0].body.includes("<sch:ClaimReturnListRequest><auth><appKey>ak</appKey><appSecret>as</appSecret></auth>"));
  assert(calls[0].body.includes("<startDate>01/10/2026</startDate>"));
  assertEquals(list.length, 2);
  assertEquals([list[0].externalId, list[0].orderNo, list[0].status, list[0].reasonCode, list[0].amount, list[0].customerName], ["9001", "N11-5", "requested", "damaged", 120.5, "Ali V"]);
  assertEquals([list[1].status, list[1].quantity, list[1].amount], ["refunded", 2, 10]);

  const ap = mockFetch(() => new Response("<r><result><status>success</status></result></r>"));
  await n11Returns.approve({ env: "live", creds: { apiKey: "ak", apiSecret: "as" }, since: new Date(), fetch: ap.f }, { claimRef: "9001" });
  assert(ap.calls[0].body.includes("<sch:ClaimReturnApproveRequest>") && ap.calls[0].body.includes("<claimReturnId>9001</claimReturnId>"));
  const fail = mockFetch(() => new Response("<r><result><status>failure</status><errorMessage>Talep bulunamadı</errorMessage></result></r>"));
  let err = "";
  try { await n11Returns.approve({ env: "live", creds: { apiKey: "a", apiSecret: "b" }, since: new Date(), fetch: fail.f }, { claimRef: "1" }); } catch (e) { err = (e as Error).message; }
  assert(err.includes("Talep bulunamadı"), err);
});
