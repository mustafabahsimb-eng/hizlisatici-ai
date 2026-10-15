// Sezon takvimi tarih kuralları: Mustafa'nın verdiği 2026-27 tarihleriyle birebir aynı olmalı
// Çalıştırma: deno test --no-check tests/season/season_rules_test.ts  (Deno.serve çağrılmasın diye yalnız saf fonksiyonlar kopyalanmadan içe alınır)
import { assertEquals } from "jsr:@std/assert@1.0.13";
Deno.env.set("SUPABASE_URL", "http://localhost"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "x");
const origServe = Deno.serve; (Deno as any).serve = () => ({}) as any;
const m = await import("../../supabase/functions/season-calendar/index.ts");
(Deno as any).serve = origServe;
const S = (key: string, holiday_rule: string, launch_offset: number, end_offset: number | null, end_rule: string | null = null) => ({ key, holiday_rule, launch_offset, end_offset, end_rule });
Deno.test("2026-27 yayına çıkış tarihleri", () => {
  const cases: [any, number, string, string][] = [
    [S("christmas", "fixed:12-25", -71, 1), 2026, "2026-10-15", "2026-12-26"],
    [S("thanksgiving", "nth:11:4:4", -42, 1), 2026, "2026-10-15", "2026-11-27"],
    [S("new_year", "fixed:01-01", -47, 1), 2027, "2026-11-15", "2027-01-02"],
    [S("valentines", "fixed:02-14", -56, 1), 2027, "2026-12-20", "2027-02-15"],
    [S("st_patricks", "fixed:03-17", -51, 1), 2027, "2027-01-25", "2027-03-18"],
    [S("easter", "easter", -55, 1), 2027, "2027-02-01", "2027-03-29"],
    [S("mothers_day", "nth:5:0:2", -55, 1), 2027, "2027-03-15", "2027-05-10"],
    [S("grad_fathers", "nth:6:0:3", -80, 1), 2027, "2027-04-01", "2027-06-21"],
    [S("july4_summer", "fixed:07-04", -50, null, "fixed:08-31"), 2027, "2027-05-15", "2027-08-31"],
    [S("back_to_school_fall", "fixed:07-01", 0, null, "fixed:11-30"), 2027, "2027-07-01", "2027-11-30"],
    [S("halloween", "fixed:10-31", -77, 1), 2027, "2027-08-15", "2027-11-01"],
  ];
  for (const [s, y, launch, end] of cases) { const w = m.windowFor(s, y); assertEquals([s.key, w.launch, w.end], [s.key, launch, end]); }
  assertEquals(m.easter(2027).toISOString().slice(0, 10), "2027-03-28");
  assertEquals(m.easter(2028).toISOString().slice(0, 10), "2028-04-16");
});
Deno.test("bugünü kapsayan pencere", () => {
  const xmas = S("christmas", "fixed:12-25", -71, 1);
  assertEquals(m.currentWindow(xmas, "2026-10-16").year, 2026);
  assertEquals(m.currentWindow(xmas, "2027-01-10").launch, "2027-10-15");
  const ny = S("new_year", "fixed:01-01", -47, 1);
  assertEquals(m.currentWindow(ny, "2026-12-01").year, 2027);
});
Deno.test("Noel teslim satırı", () => {
  assertEquals(m.holidayLine(null, "2026-11-01", "2026-12-26"), null);
  assertEquals(m.holidayLine("2026-12-10", "2026-11-01", "2026-12-26"), "🎄 Order by December 10 for Christmas delivery in the US.");
  assertEquals(m.holidayLine("2026-12-10", "2026-12-10", "2026-12-26"), "🎄 Order by December 10 for Christmas delivery in the US.");
  assertEquals(m.holidayLine("2026-12-10", "2026-12-11", "2026-12-26"), "⚠️ Orders placed now may arrive after Christmas.");
  assertEquals(m.holidayLine("2026-12-10", "2026-12-26", "2026-12-26"), null);
});
Deno.test("açıklamada satır değiştirilir, metin korunur", async () => {
  (Deno as any).serve = () => ({}) as any; Deno.env.set("CRON_SECRET", "x");
  const e = await import("../../supabase/functions/etsy-listings/index.ts");
  const base = "Most likely to eat all the cookies?\n\nPRODUCT DETAILS\n• Gildan 18000";
  const a = e.withHolidayLine(base, "🎄 Order by December 10 for Christmas delivery in the US.");
  assertEquals(a.split("\n")[0], "🎄 Order by December 10 for Christmas delivery in the US.");
  const b = e.withHolidayLine(a, "⚠️ Orders placed now may arrive after Christmas.");
  assertEquals(b, "⚠️ Orders placed now may arrive after Christmas.\n\n" + base);
  assertEquals(e.withHolidayLine(b, null), base);
});
