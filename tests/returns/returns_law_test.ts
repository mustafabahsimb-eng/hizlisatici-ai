// İade yasal çerçevesi — saf karar fonksiyonları (TR / AB / ABD), Etsy iade adaptörü.
// Çalıştırma: deno test --allow-env --allow-net tests/returns/returns_law_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
Deno.env.set("ETSY_KEYSTRING", "k"); Deno.env.set("ETSY_SHARED_SECRET", "s");
const L = await import("../../supabase/functions/_shared/returns-law.ts");
const { etsyReturns } = await import("../../supabase/functions/_shared/marketplace-returns.ts");

const TR = { region: "TR", statutory: true, window_days: 14, refund_days: 14, refund_clock: "handed_to_carrier", customer_may_pay: false, disclosure_required: false, defect_days: 730, refund_original_shipping: true, law_name_tr: "Mesafeli Sözleşmeler Yönetmeliği", law_name_en: "x" } as const;
const EU = { ...TR, region: "EU", refund_clock: "request", customer_may_pay: true, disclosure_required: true, law_name_tr: "AB", law_name_en: "EU Consumer Rights Directive" } as const;
const US = { ...TR, region: "US", statutory: false, window_days: 30, refund_clock: "approval", customer_may_pay: true, defect_days: 365, refund_original_shipping: false, law_name_tr: "Mağaza", law_name_en: "Store return policy" } as const;
const x = (o: any = {}) => ({ reason: "changed_mind", amount: 100, photos: 0, ai: null, daysSince: 3, exempt: false, fraud: [], ...o });

Deno.test("TR: satıcı yasal minimumun altına inemez; kargo ücretini müşteri öder kilitli kapalı", () => {
  const e = L.effective(TR as any, { window_days: 7, customer_pays: true });
  assertEquals(e.windowDays, 14, "7 gün yazsa da 14");
  assertEquals(e.customerPays, false);
  assertEquals(e.customerPaysLocked, true);
  assertEquals(L.effective(TR as any, { window_days: 30 }).windowDays, 30, "lehine uzatma olur");
  assertEquals(L.shippingPayer(e, "changed_mind"), "seller");
});

Deno.test("TR cayma (Vazgeçtim / Beden): süre içinde otomatik onay, reddedilemez, tutar sınırı ve otomatik onay kapalı olsa da", () => {
  for (const reason of ["changed_mind", "size"]) {
    const d = L.decide(L.effective(TR as any, { auto_approve: false, max_auto_amount: 50 }), x({ reason, amount: 5000 }));
    assert(d.auto && d.approve && !d.rejectable && d.withdrawal, JSON.stringify(d));
  }
  const f = L.decide(L.effective(TR as any, {}), x({ fraud: ["son 90 günde 4 iade"] }));
  assert(f.approve && !f.rejectable && f.note.includes("Kontrol"), "şüphe yalnız bilgi");
});

Deno.test("TR cayma süre dışı -> satıcıya (reddedilebilir)", () => {
  const d = L.decide(L.effective(TR as any, {}), x({ daysSince: 20 }));
  assert(!d.auto && d.rejectable && d.note.includes("geçmiş"));
});

Deno.test("Cayma istisnası ürün: yalnız ayıplı mal nedenleri; caymayla gelirse otomatik onay yok", () => {
  assertEquals(L.allowedReasons(true), ["defective", "damaged", "wrong_item", "not_as_described"]);
  assertEquals(L.allowedReasons(false).length, 8);
  const d = L.decide(L.effective(TR as any, {}), x({ exempt: true }));
  assert(!d.auto && d.rejectable && d.note.includes("istisna"));
});

Deno.test("Ayıplı mal: fotoğraf şart; AI kusur görür + sınır altı -> otomatik; sınır üstü / şüpheli / net değil -> satıcıya; ayıp süresi 2 yıl", () => {
  const e = L.effective(TR as any, { max_auto_amount: 1000 });
  assert(L.decide(e, x({ reason: "defective" })).note.includes("fotoğraf yok"));
  assert(L.decide(e, x({ reason: "defective", photos: 1, ai: { defect_visible: true, confidence: 0.9 } })).auto);
  assert(!L.decide(e, x({ reason: "defective", photos: 1, amount: 2000, ai: { defect_visible: true, confidence: 0.9 } })).auto);
  assert(!L.decide(e, x({ reason: "damaged", photos: 1, fraud: ["yüksek tutar"], ai: { defect_visible: true, confidence: 0.9 } })).auto);
  assert(!L.decide(e, x({ reason: "damaged", photos: 1, ai: { defect_visible: false, confidence: 0.9 } })).auto);
  assert(L.decide(e, x({ reason: "wrong_item", photos: 1, daysSince: 200, ai: { defect_visible: true, confidence: 0.8 } })).auto, "14 günden sonra da ayıp iadesi");
  assert(L.decide(e, x({ reason: "defective", photos: 1, daysSince: 800 })).note.includes("Ayıp bildirimi süresi"));
  assertEquals(L.shippingPayer(L.effective(EU as any, { customer_pays: true }), "defective"), "seller", "ayıpta masraf hep satıcıda");
});

Deno.test("AB: müşteri öder yalnız satıcı açarsa; para iadesi talepten 14 gün; politika metninde yazılı", () => {
  const e = L.effective(EU as any, { customer_pays: true });
  assertEquals(L.shippingPayer(e, "changed_mind"), "customer");
  assertEquals(L.shippingPayer(L.effective(EU as any, {}), "changed_mind"), "seller");
  assertEquals(L.refundDue(e, { requestedAt: "2026-10-01T00:00:00.000Z" }), "2026-10-15T00:00:00.000Z");
  const t = L.policyText(e, { seller: "Shop", lang: "en" });
  assert(t.includes("you pay the cost of returning") && t.includes("14 days"), t);
});

Deno.test("TR para iadesi son günü: iade kargosuna verildikten 14 gün; dropshipping onaydan; kargoya verilmeden yok", () => {
  const e = L.effective(TR as any, {});
  assertEquals(L.refundDue(e, { requestedAt: "2026-10-01T00:00:00.000Z", handedAt: "2026-10-03T00:00:00.000Z" }), "2026-10-17T00:00:00.000Z");
  assertEquals(L.refundDue(e, { requestedAt: "2026-10-01T00:00:00.000Z", approvedAt: "2026-10-02T00:00:00.000Z", dropship: true }), "2026-10-16T00:00:00.000Z");
  assertEquals(L.refundDue(e, { requestedAt: "2026-10-01T00:00:00.000Z", approvedAt: "2026-10-02T00:00:00.000Z" }), null);
});

Deno.test("ABD: yasal cayma yok -> mağaza politikası (30 gün, sınır ve şüphe uygulanır, reddedilebilir)", () => {
  const e = L.effective(US as any, {});
  assertEquals(e.windowDays, 30);
  const d = L.decide(e, x({ daysSince: 20 }));
  assert(d.auto && d.rejectable);
  assert(!L.decide(e, x({ amount: 5000 })).auto);
  assert(!L.decide(e, x({ fraud: ["son 90 günde 3 iade"] })).auto);
  assert(L.policyText(e, { seller: "Shop", lang: "en" }).includes("within 30 days of delivery"));
});

Deno.test("Ön bilgilendirme (TR): iade taşıyıcısı, ücretsiz iade, adresten alım, ilk kargo ücreti dahil, istisnalar", () => {
  const t = L.policyText(L.effective(TR as any, {}), { seller: "Bahsi Store", returnCarrier: "Yurtiçi Kargo", returnAddress: "Depo Sok. 2, Kadıköy, İstanbul", lang: "tr" });
  for (const p of ["14 gün", "İade taşıyıcısı: Yurtiçi Kargo.", "İade kargo ücreti alınmaz", "adresinizden ücretsiz", "ilk gönderim kargo ücreti dahil", "kişiye özel", "İade adresi: Depo"]) assert(t.includes(p), p);
});

Deno.test("Şüphe işaretleri", () => {
  assertEquals(L.fraudFlags({ amount: 100, maxAuto: 1000, recentReturns: 3, daysSince: 2, reason: "size" }), ["son 90 günde 3 iade"]);
  assertEquals(L.fraudFlags({ amount: 5000, maxAuto: 1000, recentReturns: 0, daysSince: 2, reason: "size" }), ["yüksek tutar"]);
});

Deno.test("Etsy iade adaptörü: para iadesi ve iptaller siparişten okunur; onay Etsy'de", async () => {
  const calls: string[] = [];
  const f = (async (u: string) => {
    calls.push(String(u));
    return new Response(JSON.stringify({ results: [
      { receipt_id: 11, status: "Fully Refunded", country_iso: "DE", name: "Anna", refunds: [{ amount: { amount: 24900, divisor: 100 }, created_timestamp: 1760000000, reason: "Buyer withdrew (EU)", note_from_issuer: "changed mind" }], transactions: [{ quantity: 1, title: "Print" }] },
      { receipt_id: 12, status: "Canceled", grandtotal: { amount: 5000, divisor: 100 }, transactions: [] },
      { receipt_id: 13, status: "Completed", refunds: [] },
    ] }), { status: 200 });
  }) as unknown as typeof fetch;
  const list = await etsyReturns.list({ env: "live", creds: { access_token: "t", shop_id: "34831538", apiKey: "k:s" }, since: new Date(Date.now() - 86400000), fetch: f });
  assert(calls[0].startsWith("https://api.etsy.com/v3/application/shops/34831538/receipts?"));
  assertEquals(list.length, 2);
  assertEquals([list[0].externalId, list[0].status, list[0].amount, list[0].reasonCode, (list[0].raw as any).buyerCountry], ["etsy-11", "refunded", 249, "changed_mind", "DE"]);
  assertEquals([list[1].status, list[1].amount], ["cancelled", 50]);
  let err = ""; try { await etsyReturns.approve({} as any, { claimRef: "1" }); } catch (e) { err = (e as Error).message; }
  assert(err.includes("Etsy üzerinden"));
});
