// İçerik otomasyonu — planlayıcı + öğrenme (saf fonksiyonlar).
// Çalıştırma: deno test --allow-env tests/content/content_engine_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { bestHours, learn, localToUtc, pickTemplate, planWeek, rng, scoreProduct, weekStartOf, fallbackCaption } from "../../supabase/functions/_shared/content-engine.ts";

const S = { posts_per_day: 1, stories_per_week: 3, channels: ["instagram", "facebook"], post_hours: ["19:30"], approval_mode: "approve" as const, timezone: "Europe/Istanbul" };
const NOW = Date.parse("2026-10-19T06:00:00Z");
const P = (id: number, o: any = {}) => ({ id, name: "Ürün " + id, price: 100, currency: "TRY", image: "https://x/" + id + ".jpg", createdAt: "2026-08-01T00:00:00Z", sold30: 0, lastPostedAt: null, inStock: true, visible: true, ...o });

Deno.test("Yerel saat -> UTC (İstanbul +3)", () => {
  assertEquals(localToUtc("2026-10-19", "19:30", "Europe/Istanbul"), "2026-10-19T16:30:00.000Z");
  assertEquals(localToUtc("2026-10-19", "09:00", "Europe/Berlin"), "2026-10-19T07:00:00.000Z");
  assertEquals(weekStartOf(new Date("2026-10-22T10:00:00Z"), "Europe/Istanbul"), "2026-10-19");
});

Deno.test("Ürün önceliği: yeni > çok satan > hiç paylaşılmamış; yakında paylaşılan geride", () => {
  const n = scoreProduct(P(1, { createdAt: "2026-10-17T00:00:00Z" }), NOW), b = scoreProduct(P(2, { sold30: 5 }), NOW);
  const never = scoreProduct(P(3), NOW), recent = scoreProduct(P(4, { lastPostedAt: "2026-10-15T00:00:00Z" }), NOW);
  assert(n.s > b.s && b.s > never.s && never.s > recent.s, JSON.stringify([n, b, never, recent]));
  assertEquals([n.reason, b.reason, never.reason], ["Yeni ürün", "Çok satan", "Hiç paylaşılmadı"]);
});

Deno.test("Haftalık plan: günde 1 gönderi × 2 kanal (aynı saat), 3 hikâye (yalnız Instagram), geçmiş saat yok, ürün tekrar etmiyor", () => {
  const items = planWeek({ settings: S, products: Array.from({ length: 30 }, (_, i) => P(i + 1)), stats: [], weekStart: "2026-10-19", now: NOW, seed: 7 });
  const posts = items.filter((i) => i.kind === "post"), stories = items.filter((i) => i.kind === "story");
  assertEquals(posts.length, 14);
  assertEquals(stories.length, 3);
  assert(stories.every((s) => s.channel === "instagram" && s.template === "story"));
  assert(items.every((i) => Date.parse(i.scheduledAt) > NOW));
  assert(posts.every((p) => p.scheduledAt.endsWith("T16:30:00.000Z")), "19:30 İstanbul");
  const ig = posts.filter((p) => p.channel === "instagram");
  const singles = ig.filter((p) => p.template !== "collage").map((p) => p.productIds[0]);
  assertEquals(new Set(singles).size, singles.length, "tek ürünlü gönderilerde tekrar yok");
  // aynı slotta iki kanal aynı içerik
  for (const p of ig) assert(posts.some((f) => f.channel === "facebook" && f.scheduledAt === p.scheduledAt && f.template === p.template));
});

Deno.test("Özel gün yaklaşırken o günün ilk gönderisi özel gün şablonu", () => {
  const items = planWeek({ settings: S, products: [1, 2, 3, 4, 5].map((i) => P(i)), stats: [], weekStart: "2026-11-24", now: Date.parse("2026-11-24T00:00:00Z"), seed: 3 });
  const s = items.filter((i) => i.template === "season");
  assert(s.length >= 2 && s[0].season === "Efsane Cuma" && s[0].reason.includes("Efsane Cuma"), JSON.stringify(s[0]));
});

Deno.test("Ürün yoksa / stokta değilse / görselsizse plan boş", () => {
  assertEquals(planWeek({ settings: S, products: [P(1, { inStock: false }), P(2, { image: null })], stats: [], weekStart: "2026-10-19", now: NOW }).length, 0);
});

Deno.test("Var olan slotlar atlanır (yeniden planlamada çift gönderi yok)", () => {
  const first = planWeek({ settings: S, products: [1, 2, 3].map((i) => P(i)), stats: [], weekStart: "2026-10-19", now: NOW, seed: 1 });
  const again = planWeek({ settings: S, products: [1, 2, 3].map((i) => P(i)), stats: [], weekStart: "2026-10-19", now: NOW, seed: 2, taken: first.map((x) => ({ scheduledAt: x.scheduledAt, channel: x.channel, kind: x.kind })) });
  assertEquals(again.length, 0);
});

Deno.test("Öğrenme: şablon × saat etkileşimi; en iyi şablon ve saat öne alınır (keşif payı dışında)", () => {
  const items = [
    ...Array.from({ length: 4 }, () => ({ template: "price", scheduledAt: "2026-10-10T16:30:00Z", tz: "Europe/Istanbul", metrics: { reach: 1000, likes: 80, comments: 10 } })),
    ...Array.from({ length: 4 }, () => ({ template: "photo", scheduledAt: "2026-10-11T09:00:00Z", tz: "Europe/Istanbul", metrics: { reach: 1000, likes: 10 } })),
  ];
  const st = learn(items);
  assertEquals(st.find((s) => s.template === "price")!.hour, "19:30");
  let price = 0; const r = rng(42);
  for (let i = 0; i < 200; i++) if (pickTemplate(st, r) === "price") price++;
  assert(price > 140, "çoğunlukla en iyi şablon: " + price);
  assertEquals(bestHours({ ...S, post_hours: ["12:00", "19:30"] }, st)[0], "19:30");
});

Deno.test("Yedek metin: fiyat, hashtag, kolaj listesi", () => {
  assert(fallbackCaption("price", ["Kılıf"], "₺279,90", "Bahsi Store", undefined).includes("sadece ₺279,90"));
  assert(fallbackCaption("collage", ["A", "B", "C", "D"], null, "Bahsi Store").includes("• D"));
  assert(fallbackCaption("photo", ["Kılıf"], null, "Bahsi Store").includes("#bahsistore"));
});
