// =========================================================
// İçerik otomasyonu — planlayıcı + öğrenme (saf fonksiyonlar; test edilebilir)
//  - Haftalık plan: günde N gönderi (en iyi saat), haftada M hikâye; özel gün yaklaşıyorsa özel gün şablonu
//  - Ürün seçimi: yeni ürün > çok satan > uzun süredir paylaşılmayan; hafta içinde tekrar yok; stokta + görselli + vitrinde
//  - Öğrenme: şablon × saat başına ortalama etkileşim; iyi giden öne alınır (%20 keşif payı)
// =========================================================
export type ContentSettings = { posts_per_day: number; stories_per_week: number; channels: string[]; post_hours: string[]; approval_mode: "approve" | "direct"; timezone: string };
export type CProduct = { id: number; name: string; price: number; currency: string; image: string | null; createdAt: string; sold30: number; lastPostedAt: string | null; inStock: boolean; visible: boolean };
export type Stat = { template: string; hour: string; n: number; engagement: number };
export type PlanItem = { channel: string; kind: "post" | "story"; template: "photo" | "price" | "collage" | "season" | "story"; productIds: number[]; reason: string; scheduledAt: string; season?: string };

export const POST_TEMPLATES = ["photo", "price", "collage"] as const;

// Türkiye özel günleri (satış için) — 2026 / 2027
export const SPECIAL_DAYS: { date: string; name: string }[] = [
  { date: "2026-10-29", name: "Cumhuriyet Bayramı" }, { date: "2026-11-11", name: "11.11 İndirimleri" }, { date: "2026-11-27", name: "Efsane Cuma" },
  { date: "2026-11-30", name: "Siber Pazartesi" }, { date: "2026-12-31", name: "Yılbaşı" }, { date: "2027-02-14", name: "Sevgililer Günü" },
  { date: "2027-03-08", name: "Dünya Kadınlar Günü" }, { date: "2027-03-10", name: "Ramazan Bayramı" }, { date: "2027-05-09", name: "Anneler Günü" },
  { date: "2027-05-17", name: "Kurban Bayramı" }, { date: "2027-06-20", name: "Babalar Günü" }, { date: "2027-09-13", name: "Okula Dönüş" },
];

// Yerel saat (HH:MM, saat dilimi) -> UTC ISO
export function localToUtc(day: string, hm: string, tz: string): string {
  const [h, m] = hm.split(":").map(Number);
  const guess = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h, m || 0);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return new Date(guess - (asLocal - guess)).toISOString();
}
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Basit tekrarlanabilir rastgelelik (test için tohumlu)
export function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function bestHours(settings: ContentSettings, stats: Stat[]): string[] {
  const hours = [...new Set(settings.post_hours.length ? settings.post_hours : ["19:30"])];
  const score = (h: string) => { const xs = stats.filter((s) => s.hour === h && s.n >= 2); return xs.length ? xs.reduce((a, s) => a + s.engagement * s.n, 0) / xs.reduce((a, s) => a + s.n, 0) : -1; };
  return hours.sort((a, b) => score(b) - score(a));
}

export function pickTemplate(stats: Stat[], rand: () => number, exclude: string[] = []): "photo" | "price" | "collage" {
  const options = POST_TEMPLATES.filter((t) => !exclude.includes(t));
  const known = options.map((t) => { const xs = stats.filter((s) => s.template === t && s.n >= 2); const n = xs.reduce((a, s) => a + s.n, 0);
    return { t, n, e: n ? xs.reduce((a, s) => a + s.engagement * s.n, 0) / n : 0 }; });
  if (rand() < 0.2 || known.every((k) => k.n === 0)) return options[Math.floor(rand() * options.length)] as any;   // keşif
  return known.sort((a, b) => b.e - a.e)[0].t as any;
}

export function scoreProduct(p: CProduct, now: number) {
  const ageDays = (now - Date.parse(p.createdAt)) / 86400000;
  const sincePost = p.lastPostedAt ? (now - Date.parse(p.lastPostedAt)) / 86400000 : 999;
  let s = 0, reason = "";
  if (ageDays <= 7) { s += 30; reason = "Yeni ürün"; }
  if (p.sold30 > 0) { s += 10 + Math.min(20, p.sold30 * 2); if (!reason) reason = "Çok satan"; }
  if (sincePost > 14) { s += 8; if (!reason) reason = sincePost > 900 ? "Hiç paylaşılmadı" : "Bir süredir paylaşılmadı"; }
  else s -= 20;   // yakın zamanda paylaşıldı
  return { s, reason: reason || "Vitrinden" };
}

export function planWeek(x: { settings: ContentSettings; products: CProduct[]; stats: Stat[]; weekStart: string; now: number; seed?: number; taken?: { scheduledAt: string; channel: string; kind: string }[] }): PlanItem[] {
  const rand = rng(x.seed ?? 1);
  const pool = x.products.filter((p) => p.visible && p.inStock && p.image).map((p) => ({ p, ...scoreProduct(p, x.now) }))
    .sort((a, b) => b.s - a.s || rand() - 0.5);
  if (!pool.length) return [];
  const used = new Set<number>();
  const next = (n = 1) => {
    const out: typeof pool = [];
    for (const c of pool) { if (out.length >= n) break; if (!used.has(c.p.id)) { out.push(c); used.add(c.p.id); } }
    if (out.length < n) for (const c of pool) { if (out.length >= n) break; if (!out.includes(c)) out.push(c); }   // havuz bitti: tekrar
    return out;
  };
  const hours = bestHours(x.settings, x.stats);
  const channels = x.settings.channels.filter((c) => ["instagram", "facebook"].includes(c));
  const items: PlanItem[] = [];
  const takenKey = new Set((x.taken || []).map((t) => `${t.channel}|${t.kind}|${t.scheduledAt.slice(0, 13)}`));
  let lastTemplate = "";
  for (let d = 0; d < 7; d++) {
    const day = addDays(x.weekStart, d);
    const season = SPECIAL_DAYS.find((s) => { const diff = (Date.parse(s.date) - Date.parse(day)) / 86400000; return diff >= 0 && diff <= 3; });
    for (let k = 0; k < x.settings.posts_per_day; k++) {
      const at = localToUtc(day, hours[k % hours.length], x.settings.timezone);
      if (Date.parse(at) < x.now + 30 * 60000) continue;   // geçmiş / çok yakın saat
      let template: PlanItem["template"] = season && k === 0 ? "season" : pickTemplate(x.stats, rand, lastTemplate === "collage" ? ["collage"] : []);
      const picks = next(template === "collage" ? 4 : 1);
      if (template === "collage" && picks.length < 4) template = "photo";
      lastTemplate = template;
      const reason = template === "season" ? `${season!.name} yaklaşıyor` : template === "collage" ? "Haftanın seçkisi" : picks[0].reason;
      for (const ch of channels) {
        if (takenKey.has(`${ch}|post|${at.slice(0, 13)}`)) continue;
        items.push({ channel: ch, kind: "post", template, productIds: picks.slice(0, template === "collage" ? 4 : 1).map((c) => c.p.id), reason, scheduledAt: at, ...(template === "season" ? { season: season!.name } : {}) });
      }
    }
  }
  // Hikâyeler: haftaya yayılır (öğlen), yalnız Instagram (Facebook hikâye API'si sayfa gönderisi gibi çalışmaz)
  const nStories = Math.min(21, x.settings.stories_per_week);
  for (let i = 0; i < nStories && channels.includes("instagram"); i++) {
    const day = addDays(x.weekStart, Math.floor((i * 7) / Math.max(1, nStories)));
    const at = localToUtc(day, i % 2 ? "13:00" : "12:30", x.settings.timezone);
    if (Date.parse(at) < x.now + 30 * 60000 || takenKey.has(`instagram|story|${at.slice(0, 13)}`)) continue;
    const pick = next(1)[0];
    items.push({ channel: "instagram", kind: "story", template: "story", productIds: [pick.p.id], reason: pick.reason, scheduledAt: at });
  }
  return items.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

// Öğrenme: yayınlanmış içeriklerin etkileşim oranı (etkileşim / erişim; erişim yoksa beğeni + yorum) -> şablon × saat
export function learn(items: { template: string; scheduledAt: string; tz: string; metrics: any }[]): Stat[] {
  const m = new Map<string, Stat>();
  for (const it of items) {
    if (!it.metrics) continue;
    const reach = Number(it.metrics.reach) || 0;
    const inter = (Number(it.metrics.likes) || 0) + (Number(it.metrics.comments) || 0) * 2 + (Number(it.metrics.saves) || 0) * 3 + (Number(it.metrics.shares) || 0) * 3;
    const e = reach > 0 ? inter / reach : inter / 100;
    const hour = new Intl.DateTimeFormat("en-GB", { timeZone: it.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(it.scheduledAt));
    const k = it.template + "|" + hour;
    const s = m.get(k) || { template: it.template, hour, n: 0, engagement: 0 };
    s.engagement = (s.engagement * s.n + e) / (s.n + 1); s.n++;
    m.set(k, s);
  }
  return [...m.values()];
}

export function weekStartOf(now: Date, tz: string) {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(now);
  const day = `${local.find((p) => p.type === "year")!.value}-${local.find((p) => p.type === "month")!.value}-${local.find((p) => p.type === "day")!.value}`;
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(local.find((p) => p.type === "weekday")!.value);
  return addDays(day, -Math.max(0, wd));
}

// Yedek metin (AI yoksa)
export function fallbackCaption(t: PlanItem["template"], names: string[], price: string | null, store: string, season?: string) {
  const tags = "#alışveriş #yeniürün #indirim #" + store.toLocaleLowerCase("tr").replace(/[^a-zçğıöşü0-9]/gi, "");
  if (t === "season") return `${season} için seçtiklerimiz 🎁 ${names[0]}${price ? " — " + price : ""}\nSipariş için profildeki bağlantı.\n\n${tags}`;
  if (t === "collage") return `Haftanın seçkisi ✨\n${names.slice(0, 4).map((n) => "• " + n).join("\n")}\nHepsi mağazamızda.\n\n${tags}`;
  if (t === "price") return `${names[0]} ${price ? "sadece " + price : ""} 🔥\nStoklar sınırlı, profildeki bağlantıdan sipariş ver.\n\n${tags}`;
  return `${names[0]} ${price ? "— " + price : ""}\nHızlı kargo, güvenli ödeme. Sipariş için profildeki bağlantı.\n\n${tags}`;
}
