// =========================================================
// Sezon takvimi (zamanlanmış, günde 1; CRON_SECRET)
// - Her sezonun tarihleri kuraldan hesaplanır (seasons.holiday_rule; Paskalya ve "n'inci pazar" gibi değişen günler dahil), her yıl kendiliğinden.
// - Yayına çıkış günü gelen sezonun ilanları Etsy'de yayına alınır; bitiş günü gelenler PASİFE alınır (silinmez: yorum ve satış
//   geçmişi ilanda kalır, ertesi yıl aynı ilan yeniden açılır). Her yıl açık (evergreen) sezonlara dokunulmaz.
// - Sezondan 14 gün önce Etsy'de yükselen aramalar kontrol edilir (resmi API findAllListingsActive): tohum kelimelerin sonuç sayısı
//   geçen yılla karşılaştırılır, en yeni ilanlarda en sık geçen etiketler sezonun temalarına (seasons.trend_tags) eklenir.
// - Yayına alma / pasife alma / trend sonucu satıcıya asistan kanalından (Telegram) bildirilir.
// Sistem: { cronSecret } | { cronSecret, dryRun: true } (değiştirmeden ne yapılacağını döndürür) | { cronSecret, action: "windows", year? }
// Paket anahtarı: season_calendar
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { etsyApiKey } from "../_shared/etsy.ts";
import { featureEnabled } from "../_shared/features.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const DAY = 86400_000;

// ---------------- Tarih kuralları ----------------
export function easter(y: number): Date {  // Gregoryen (anonim algoritma)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
export function ruleDate(rule: string, y: number): Date {
  if (rule === "easter") return easter(y);
  const [kind, ...p] = rule.split(":");
  if (kind === "fixed") { const [m, d] = p[0].split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  if (kind === "nth") {  // nth:AY:HAFTAGÜNÜ:N
    const [m, wd, n] = p.map(Number); const first = new Date(Date.UTC(y, m - 1, 1));
    return new Date(Date.UTC(y, m - 1, 1 + ((wd - first.getUTCDay() + 7) % 7) + (n - 1) * 7));
  }
  throw new Error("Tanımsız tarih kuralı: " + rule);
}
export type Window = { key: string; year: number; holiday: string; launch: string; end: string; trendCheck: string };
const iso = (d: Date) => d.toISOString().slice(0, 10);
export function windowFor(s: any, y: number): Window {
  const h = ruleDate(s.holiday_rule, y);
  const launch = new Date(h.getTime() + (s.launch_offset ?? 0) * DAY);
  const end = s.end_rule ? ruleDate(s.end_rule, y) : new Date(h.getTime() + (s.end_offset ?? 1) * DAY);
  return { key: s.key, year: y, holiday: iso(h), launch: iso(launch), end: iso(end), trendCheck: iso(new Date(launch.getTime() - 14 * DAY)) };
}
// Bugünü kapsayan ya da sıradaki pencere (yayına çıkışı yılbaşını aşan sezonlar için önceki / sonraki yıl da denenir)
export function currentWindow(s: any, today: string): Window {
  const y = Number(today.slice(0, 4));
  const ws = [y - 1, y, y + 1].map((yy) => windowFor(s, yy));
  return ws.find((w) => w.trendCheck <= today && today < w.end) || ws.find((w) => w.launch > today)!;
}
const todayTR = () => iso(new Date(Date.now() + 3 * 3600_000));  // Türkiye günü

// ---------------- Etsy ----------------
async function listingState(userId: string, ids: string[], state: "active" | "inactive") {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/etsy-listings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cronSecret: CRON_SECRET, action: "listing_state", userId, etsyListingIds: ids, state }), signal: AbortSignal.timeout(120000),
  });
  return await r.json().catch(() => ({ ok: false, error: "cevap okunamadı" }));
}
async function etsySearch(keyword: string) {
  const q = new URLSearchParams({ keywords: keyword, limit: "100", sort_on: "created", sort_order: "desc" });
  const r = await fetch("https://api.etsy.com/v3/application/listings/active?" + q, { headers: { "x-api-key": etsyApiKey() }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Etsy arama ${r.status}`);
  const d = await r.json();
  return { count: Number(d.count) || 0, tags: (d.results || []).flatMap((l: any) => (l.tags || []).map((t: string) => String(t).toLowerCase())) };
}
async function trendCheck(s: any, w: Window) {
  const { data: prev } = await db.from("season_trend_checks").select("results").eq("season_key", s.key).eq("cycle_year", w.year - 1).maybeSingle();
  const prevMap = new Map<string, number>((prev?.results || []).map((r: any) => [r.keyword, r.count]));
  const results: any[] = []; const freq = new Map<string, number>();
  for (const kw of s.trend_seeds || []) {
    try {
      const r = await etsySearch(kw); const pc = prevMap.get(kw) ?? null;
      for (const t of r.tags) freq.set(t, (freq.get(t) || 0) + 1);
      results.push({ keyword: kw, count: r.count, prev_count: pc, growth: pc ? Math.round((r.count / pc - 1) * 100) : null });
    } catch (e) { results.push({ keyword: kw, error: (e as Error).message }); }
    await new Promise((res) => setTimeout(res, 300));  // Etsy kotası
  }
  const known = new Set([...(s.themes || []), ...(s.trend_seeds || [])].map((x: string) => x.toLowerCase()));
  const added = [...freq.entries()].filter(([t]) => !known.has(t) && t.length > 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  await db.from("season_trend_checks").upsert({ season_key: s.key, cycle_year: w.year, results, added_tags: added, checked_at: new Date().toISOString() }, { onConflict: "season_key,cycle_year" });
  await db.from("seasons").update({ trend_tags: added }).eq("key", s.key);
  return { results, added };
}

async function notify(userId: string, text: string, dedupe: string) {
  await db.rpc("assistant_enqueue", { p_user: userId, p_kind: "notice", p_payload: { text }, p_dedupe: dedupe });
}

// ---------------- Noel son sipariş tarihi (Printify) ----------------
// Printify her yıl ABD için Noel son sipariş tarihlerini yayınlar. Günde bir kez kaynak sayfalar okunur (Printify tedarikçi; pazar yeri değil),
// metinden AI ile "ABD standart kargo, giysi" son sipariş günü çıkarılır ve app_cache'e yazılır. 1 Aralık'a kadar açıklanmazsa
// tahmin kullanılır: USPS Ground Advantage son günü (17 Aralık) − 5 iş günü üretim = 10 Aralık (kaynak "tahmin" olarak işaretlenir).
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const DEADLINE_SOURCES = ["https://printify.com/blog/holiday-shipping-deadlines/", "https://printify.com/blog/holiday-season/", "https://printify.com/holiday-deadlines/"];
async function cacheGet(key: string) { const { data } = await db.from("app_cache").select("value").eq("key", key).maybeSingle(); return data?.value ?? null; }
async function cacheSet(key: string, value: unknown) { await db.from("app_cache").upsert({ key, value, updated_at: new Date().toISOString() }); }
async function aiDeadline(text: string, year: number): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 200, messages: [{ role: "user", content:
      `Below is text from Printify's website. If it states Printify's ${year} Christmas order deadline for delivery by December 25 within the United States ` +
      `with standard shipping for apparel (or a general US standard deadline), answer ONLY with JSON {"order_by":"${year}-12-DD"}. If the ${year} deadline is not stated, answer {"order_by":null}.\n\n` + text.slice(0, 60000) }] }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) return null;
  const m = /\{[^}]*\}/.exec((await r.json())?.content?.[0]?.text || "");
  try { const v = m ? JSON.parse(m[0]).order_by : null; return /^\d{4}-12-\d{2}$/.test(v || "") ? v : null; } catch { return null; }
}
export async function christmasDeadline(year: number, today: string): Promise<{ date: string; source: string } | null> {
  const key = `printify_holiday_deadline:${year}`;
  const c = await cacheGet(key);
  if (c?.date && c.source !== "tahmin" && c.source !== "satici") return c;   // satıcının verdiği tarih: Printify açıklarsa onunki geçer
  if ((await cacheGet(key + ":checked")) !== today) {
    await cacheSet(key + ":checked", today);
    for (const url of DEADLINE_SOURCES) {
      try {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Seltigo/1.0)" }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        const text = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        if (!text.includes(String(year)) || !/christmas|holiday/i.test(text)) continue;
        const d = await aiDeadline(text, year);
        if (d) { const v = { date: d, source: url }; await cacheSet(key, v); return v; }
      } catch { /* bir sonraki kaynak */ }
    }
  }
  if (c?.date) return c;
  if (today >= `${year}-12-01`) { const v = { date: `${year}-12-10`, source: "tahmin" }; await cacheSet(key, v); return v; }
  return null;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function holidayLine(deadline: string | null, today: string, end: string): string | null {
  if (!deadline || today >= end) return null;                                  // sezon bitti: satır kaldırılır
  const d = new Date(deadline + "T00:00:00Z");
  if (today <= deadline) return `Order by ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} for delivery before Christmas (US).`;  // metin: Mustafa, 16 Ekim 2026
  return "⚠️ Orders placed now may arrive after Christmas.";
}
async function christmasNotices(today: string, dryRun: boolean) {
  const { data: s } = await db.from("seasons").select("*").eq("key", "christmas").maybeSingle();
  if (!s) return null;
  const w = currentWindow(s, today);
  if (today < w.launch || today > iso(new Date(new Date(w.end).getTime() + 3 * DAY))) return { skipped: "sezon dışı" };
  const dl = await christmasDeadline(Number(w.holiday.slice(0, 4)), today);
  const line = holidayLine(dl?.date || null, today, w.end);
  const { data: pods } = await db.from("pod_products").select("user_id, external_listing_id").eq("status", "published").not("external_listing_id", "is", null);
  const byUser = new Map<string, string[]>();
  for (const p of pods || []) byUser.set(p.user_id, [...(byUser.get(p.user_id) || []), p.external_listing_id]);
  const out: any[] = [];
  for (const [userId, ids] of byUser) {
    const stateKey = `holiday_notice:${userId}:${w.year}`;
    const prev = await cacheGet(stateKey);
    if ((prev?.line ?? null) === line && prev?.count === ids.length) continue;   // değişiklik yok
    if (dryRun) { out.push({ userId, line, count: ids.length }); continue; }
    const r = await fetch(`${SUPABASE_URL}/functions/v1/etsy-listings`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(300000),
      body: JSON.stringify({ cronSecret: CRON_SECRET, action: "holiday_notice", userId, etsyListingIds: ids, line, announcement: true }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) await cacheSet(stateKey, { line, count: ids.length, at: new Date().toISOString() });
    await notify(userId, r.ok
      ? (line ? `🎄 Noel teslim notu güncellendi (${ids.length} ilan + mağaza duyurusu): "${line}"${dl?.source === "tahmin" ? " (Printify henüz açıklamadı; tahmini tarih)" : ""}` : `🎄 Noel teslim notu ilanlardan kaldırıldı.`)
      : `⚠️ Noel teslim notu güncellenemedi: ${String(r.error || "").slice(0, 200)}`, `holiday:${userId}:${line ?? "none"}`);
    out.push({ userId, line, ok: r.ok });
  }
  return { deadline: dl, line, users: out };
}

async function run(dryRun: boolean) {
  const today = todayTR();
  const christmas = await christmasNotices(today, dryRun).catch((e) => ({ error: String((e as Error).message).slice(0, 200) }));
  const { data: seasons } = await db.from("seasons").select("*").eq("evergreen", false).order("sort");
  const out: any[] = [];
  for (const s of seasons || []) {
    const w = currentWindow(s, today);
    const shouldBeActive = w.launch <= today && today < w.end;
    const item: any = { season: s.key, window: w, shouldBeActive };
    // 1) Yükselen aramalar (sezondan 14 gün önce, yılda bir)
    if (w.trendCheck <= today && today < w.end) {
      const { data: done } = await db.from("season_trend_checks").select("id").eq("season_key", s.key).eq("cycle_year", w.year).maybeSingle();
      if (!done) item.trend = dryRun ? "kontrol edilecek" : await trendCheck(s, w);
    }
    // 2) İlanları yayına al / pasife al (satıcı bazında)
    const { data: rows } = await db.from("season_listings").select("id, user_id, external_listing_id, state").eq("season_key", s.key).eq("marketplace_code", "etsy");
    const byUser = new Map<string, any[]>();
    for (const r of rows || []) {
      if (shouldBeActive ? r.state === "active" : r.state !== "active") continue;
      byUser.set(r.user_id, [...(byUser.get(r.user_id) || []), r]);
    }
    item.users = [];
    for (const [userId, list] of byUser) {
      if (!(await featureEnabled(userId, "season_calendar"))) { item.users.push({ userId, skipped: "paket" }); continue; }
      const target = shouldBeActive ? "active" : "inactive";
      if (dryRun) { item.users.push({ userId, target, count: list.length }); continue; }
      const res = await listingState(userId, list.map((x) => x.external_listing_id), target);
      const okIds = new Set((res.results || []).filter((x: any) => x.ok).map((x: any) => String(x.id)));
      const now = new Date().toISOString();
      for (const r of list) {
        const ok = okIds.has(String(r.external_listing_id)); const err = (res.results || []).find((x: any) => String(x.id) === String(r.external_listing_id))?.error || res.error || null;
        await db.from("season_listings").update(ok ? { state: target, last_action: target, last_action_at: now, last_error: null } : { last_error: String(err || "bilinmeyen hata").slice(0, 300), last_action_at: now }).eq("id", r.id);
      }
      const n = okIds.size, fail = list.length - n;
      const verb = shouldBeActive ? "yayına alındı" : "pasife alındı (silinmedi; gelecek yıl yorumlarıyla geri açılır)";
      await notify(userId, `📅 ${s.name_tr} sezonu: ${n} ilan ${verb}.${fail ? ` ${fail} ilanda hata var, panelden bakılmalı.` : ""}`, `season:${s.key}:${w.year}:${target}`);
      item.users.push({ userId, target, ok: n, fail });
    }
    if (item.trend?.added?.length) {
      const owners = new Set((rows || []).map((r: any) => r.user_id));
      for (const u of owners) await notify(u, `🔎 ${s.name_tr} için Etsy'de öne çıkan aramalar: ${item.trend.added.join(", ")}. Temalara eklendi.`, `season-trend:${s.key}:${w.year}`);
    }
    out.push(item);
  }
  return { ok: true, today, dryRun, christmas, seasons: out };
}

Deno.serve(async (req) => {
  const b = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(b?.cronSecret || "").trim() !== CRON_SECRET.trim()) return json({ ok: false, error: "unauthorized" }, 401);
  try {
    if (b.action === "windows") {
      const { data: seasons } = await db.from("seasons").select("*").eq("evergreen", false).order("sort");
      const y = Number(b.year) || Number(todayTR().slice(0, 4));
      return json({ ok: true, windows: (seasons || []).map((s: any) => windowFor(s, y)) });
    }
    return json(await run(b.dryRun === true));
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message).slice(0, 300) }, 500);
  }
});
