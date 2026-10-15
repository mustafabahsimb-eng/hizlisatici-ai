// Seltigo Ads — kural motoru + Meta Marketing API istekleri (taklit).
// Çalıştırma: deno test --allow-env --allow-net tests/ads/ads_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { allowedDailyBudget, economics, optimize, pickProducts, purchasesOf, rulesOf } from "../../supabase/functions/_shared/ads-engine.ts";
import * as M from "../../supabase/functions/_shared/meta-ads.ts";

const R = rulesOf({ daily_cap: 500, monthly_cap: 10000, target_roas: 3, min_margin_pct: 25 });
const P = (o: any) => ({ id: 1, name: "Ürün", price: 400, cost: 150, commissionPct: 0, inStock: true, hasImage: true, visible: true, ...o });

Deno.test("Kâr hesabı: başabaş ROAS = satış / kâr", () => {
  const e = economics(P({ price: 400, cost: 150, commissionPct: 10 }))!;
  assertEquals(e.margin, 210);
  assertEquals(Math.round(e.breakevenRoas * 100) / 100, 1.9);
});

Deno.test("Ürün seçimi: yalnız kârlı, stokta, görselli, yayında; başabaş hedefin altında; kârlıdan sırala", () => {
  const { picked, skipped } = pickProducts([
    P({ id: 1, price: 400, cost: 150 }), P({ id: 2, price: 400, cost: 100 }),
    P({ id: 3, price: 100, cost: 90 }), P({ id: 4, cost: null }), P({ id: 5, inStock: false }), P({ id: 6, hasImage: false }), P({ id: 7, visible: false }),
    P({ id: 8, price: 100, cost: 110 }), P({ id: 9, price: 100, cost: 70 }),
  ], R);
  assertEquals(picked.map((x) => x.id), [2, 1]);
  const why: Record<number, string> = Object.fromEntries(skipped.map((x) => [x.id, x.reason || ""]));
  assert(why[3].includes("Kâr oranı"), why[3]);
  assert(why[4].includes("Maliyet"));
  assertEquals(why[5], "Stokta yok");
  assertEquals(why[6], "Görsel yok");
  assert(why[7].includes("yayında değil"));
  assertEquals(why[8], "Zararına satılıyor");
  assert(why[9].includes("Başabaş ROAS"), "kâr %30 ama başabaş 3.33 > hedef 3");
});

Deno.test("Bütçe sınırı: sınır girilmemişse 0; günlük - diğer aktifler; aylık kalan / gün; aylık dolduysa 0", () => {
  assertEquals(allowedDailyBudget(rulesOf({}), { otherActiveDaily: 0, spentThisMonth: 0, daysLeftInMonth: 10 }).budget, 0);
  assertEquals(allowedDailyBudget(R, { otherActiveDaily: 200, spentThisMonth: 0, daysLeftInMonth: 10 }).budget, 300);
  assertEquals(allowedDailyBudget(R, { otherActiveDaily: 0, spentThisMonth: 9000, daysLeftInMonth: 10 }).budget, 100);
  assertEquals(allowedDailyBudget(R, { otherActiveDaily: 0, spentThisMonth: 0, daysLeftInMonth: 10, requested: 150 }).budget, 150);
  const full = allowedDailyBudget(R, { otherActiveDaily: 0, spentThisMonth: 10000, daysLeftInMonth: 10 });
  assert(full.budget === 0 && full.reason!.includes("Aylık"));
});

const day = (d: string, spend: number, revenue: number) => ({ day: d, spend, revenue, purchases: revenue > 0 ? 1 : 0 });
const base = { dailyBudget: 100, breakevenRoas: 1.6, belowSince: null as string | null, today: "2026-10-18", spentThisMonth: 1000, otherActiveDaily: 0, daysLeftInMonth: 14 };

Deno.test("Optimizasyon: zarar (başabaş altı) hemen durdur — kapatılamaz", () => {
  const d = optimize(rulesOf({ ...R, auto_scale: true }), { ...base, metrics: [day("2026-10-16", 100, 50), day("2026-10-17", 100, 60)] });
  assertEquals(d.action, "pause");
  assert(d.reason.includes("Zarar"));
});

Deno.test("Optimizasyon: hedefin altında N gün sonra durdur, öncesinde bekle", () => {
  const m = [day("2026-10-16", 100, 200), day("2026-10-17", 100, 220)];   // ROAS 2.1: başabaşın üstü, hedefin altı
  const d1 = optimize(R, { ...base, metrics: m });
  assert(d1.action === "keep" && d1.belowSince === "2026-10-18");
  const d3 = optimize(R, { ...base, belowSince: "2026-10-16", metrics: m });
  assert(d3.action === "pause" && d3.reason.includes("3 gündür"), d3.reason);
});

Deno.test("Optimizasyon: hedefin %20 üstü + otomatik artırma -> bütçe +%20 ama sınırı aşmaz; kapalıysa artırmaz", () => {
  const m = [day("2026-10-16", 100, 500), day("2026-10-17", 100, 450)];   // ROAS 4.75
  const on = optimize(rulesOf({ ...R, auto_scale: true }), { ...base, metrics: m });
  assert(on.action === "scale" && on.newBudget === 120, JSON.stringify(on));
  const capped = optimize(rulesOf({ ...R, auto_scale: true, daily_cap: 110 }), { ...base, metrics: m });
  assert(capped.action === "scale" && capped.newBudget === 110, JSON.stringify(capped));
  assertEquals(optimize(R, { ...base, metrics: m }).action, "keep");
});

Deno.test("Optimizasyon: aylık sınır doldu -> hepsini durdur; az harcamada karar yok", () => {
  assertEquals(optimize(R, { ...base, spentThisMonth: 10000, metrics: [] }).action, "pause_cap");
  assertEquals(optimize(R, { ...base, metrics: [day("2026-10-17", 30, 0)] }).action, "keep");
});

Deno.test("Satın alma sayısı / tutarı (piksel satın alma türleri)", () => {
  assertEquals(purchasesOf({ actions: [{ action_type: "link_click", value: "40" }, { action_type: "offsite_conversion.fb_pixel_purchase", value: "3" }],
    action_values: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "1250.5" }] }), { purchases: 3, revenue: 1250.5 });
  assertEquals(purchasesOf({}), { purchases: 0, revenue: 0 });
});

type Call = { method: string; path: string; params: URLSearchParams };
function meta(handler?: (c: Call) => any) {
  const calls: Call[] = []; let n = 100;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = (init?.method || "GET").toUpperCase();
    const params = method === "GET" ? u.searchParams : new URLSearchParams(String(init?.body || ""));
    const c = { method, path: u.pathname.replace("/v24.0", ""), params };
    calls.push(c);
    const out = handler?.(c) ?? { id: String(n++) };
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

Deno.test("Kampanya zinciri: OUTCOME_SALES katalog kampanyası -> reklam seti (kuruş, ülke, piksel PURCHASE) -> dinamik metin -> reklam; hepsi DURAKLATILMIŞ", async () => {
  const { f, calls } = meta();
  const set = await M.createProductSet("tok", "CAT1", "Seltigo test", [5, 9], f);
  const ids = await M.launchCatalogCampaign({ token: "tok", account: "act_77", currency: "TRY", catalogId: "CAT1", productSetId: set, name: "Seltigo test", dailyBudget: 150.5,
    countries: ["TR"], pixelId: "PX1", pageId: "PG1", instagramId: "IG1", link: "https://x/magaza.html?slug=a", message: "Merhaba" }, f);
  assertEquals(calls[0].path, "/CAT1/product_sets");
  assertEquals(JSON.parse(calls[0].params.get("filter")!), { retailer_id: { is_any: ["seltigo_5", "seltigo_9"] } });
  const camp = calls[1], adset = calls[2], cr = calls[3], ad = calls[4];
  assertEquals([camp.path, camp.params.get("objective"), camp.params.get("status")], ["/act_77/campaigns", "OUTCOME_SALES", "PAUSED"]);
  assertEquals(JSON.parse(camp.params.get("promoted_object")!), { product_catalog_id: "CAT1" });
  assertEquals(camp.params.get("special_ad_categories"), "[]");
  assertEquals([adset.path, adset.params.get("daily_budget"), adset.params.get("status"), adset.params.get("optimization_goal")], ["/act_77/adsets", "15050", "PAUSED", "OFFSITE_CONVERSIONS"]);
  assertEquals(JSON.parse(adset.params.get("promoted_object")!), { product_set_id: set, pixel_id: "PX1", custom_event_type: "PURCHASE" });
  assertEquals(JSON.parse(adset.params.get("targeting")!).geo_locations.countries, ["TR"]);
  const spec = JSON.parse(cr.params.get("object_story_spec")!);
  assertEquals([spec.page_id, spec.instagram_user_id, spec.template_data.name, spec.template_data.call_to_action.type], ["PG1", "IG1", "{{product.name}}", "SHOP_NOW"]);
  assertEquals(cr.params.get("product_set_id"), set);
  assertEquals([ad.path, ad.params.get("status"), JSON.parse(ad.params.get("creative")!).creative_id], ["/act_77/ads", "PAUSED", ids.creative]);
  assertEquals(calls.every((c) => c.params.get("access_token") === "tok"), true);
});

Deno.test("Piksel yoksa bağlantı tıklaması hedefi; ondalıksız para birimi (JPY)", async () => {
  const { f, calls } = meta();
  await M.launchCatalogCampaign({ token: "t", account: "act_1", currency: "JPY", catalogId: "C", productSetId: "S", name: "n", dailyBudget: 1500, countries: ["JP"], pageId: "P", link: "l", message: "m" }, f);
  assertEquals([calls[1].params.get("optimization_goal"), calls[1].params.get("daily_budget")], ["LINK_CLICKS", "1500"]);
});

Deno.test("Yayına al / durdur (reklam, set, kampanya) ve bütçe", async () => {
  const { f, calls } = meta(() => ({ success: true }));
  await M.setStatus("t", { campaign: "C", adset: "S", ad: "A" }, "ACTIVE", f);
  assertEquals(calls.map((c) => [c.path, c.params.get("status")]), [["/A", "ACTIVE"], ["/S", "ACTIVE"], ["/C", "ACTIVE"]]);
  await M.setDailyBudget("t", "S", 99.99, "TRY", f);
  assertEquals(calls[3].params.get("daily_budget"), "9999");
});

Deno.test("Ölçüm: adset düzeyi günlük + ürün kırılımı; hız sınırında tekrar dener", async () => {
  let hit = 0;
  const { f, calls } = meta((c) => {
    if (c.path.endsWith("/insights") && hit++ === 0) return { error: { code: 17, message: "User request limit reached" } };
    return { data: [{ adset_id: "S", spend: "50", date_start: "2026-10-17" }] };
  });
  const r = await M.insights("t", "act_1", "2026-10-10", "2026-10-18", f);
  assertEquals(r.rows.length, 1);
  assertEquals(r.byProduct.length, 1);
  assertEquals(calls.filter((c) => c.path === "/act_1/insights").length, 3, "1 tekrar + ürün kırılımı");
  assertEquals(calls[2].params.get("breakdowns"), "product_id");
  assertEquals(JSON.parse(calls[0].params.get("time_range")!), { since: "2026-10-10", until: "2026-10-18" });
});

Deno.test("Meta hatası: kullanıcıya dönük mesaj", async () => {
  const { f } = meta(() => ({ error: { code: 200, message: "(#200) Requires ads_management permission" } }));
  let err: unknown;
  try { await M.adAccounts("t", f); } catch (e) { err = e; }
  assert(err instanceof M.MetaAdsError && (err as M.MetaAdsError).code === 200);
});

Deno.test("Dönüşüm API: Purchase, event_id (tarayıcı pikseliyle tekilleşir), telefon / şehir SHA-256, ürün kodu", async () => {
  const { f, calls } = meta(() => ({ events_received: 1 }));
  await M.capiPurchase("t", "PX1", { eventId: "ord-1", value: 499.9, currency: "TRY", productId: 42, quantity: 1, phone: "0555 111 22 33", city: "İstanbul", country: "TR", url: "https://x" }, f);
  const d = JSON.parse(calls[0].params.get("data")!)[0];
  assertEquals([calls[0].path, d.event_name, d.event_id, d.action_source], ["/PX1/events", "Purchase", "ord-1", "website"]);
  assertEquals(d.custom_data.content_ids, ["seltigo_42"]);
  assertEquals(d.user_data.ph[0], await M.sha256("905551112233"));
  assert(!JSON.stringify(d).includes("5551112233"), "telefon açık gönderilmez");
});
