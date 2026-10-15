// =========================================================
// Seltigo Ads — kural motoru (saf fonksiyonlar; test edilebilir)
//  - Kârlı ürün seçimi: reklam yalnız kârı (satış - maliyet - komisyon) hedefin üstünde kalan ürünlere; başabaş ROAS hedefin altında olmalı
//  - Bütçe: günlük ve aylık üst sınır ASLA aşılmaz (diğer aktif kampanyaların bütçesi ve bu ay harcanan düşülür)
//  - Optimizasyon: hedefin altında N gün -> durdur; başabaşın altı (zarar) -> hemen durdur (kapatılamaz); hedefin %20 üstü -> bütçe artır (açıksa)
// =========================================================
export type AdRules = {
  auto_launch: boolean; daily_cap: number; monthly_cap: number; target_roas: number; min_margin_pct: number;
  auto_scale: boolean; scale_pct: number; pause_after_days: number; min_spend_to_judge: number; countries: string[]; approval_mode: "approve" | "direct";
};
export const DEFAULT_RULES: AdRules = { auto_launch: false, daily_cap: 0, monthly_cap: 0, target_roas: 3, min_margin_pct: 25, auto_scale: false, scale_pct: 20,
  pause_after_days: 3, min_spend_to_judge: 0, countries: ["TR"], approval_mode: "approve" };
export const rulesOf = (r: Partial<AdRules> | null | undefined): AdRules => ({ ...DEFAULT_RULES, ...(r || {}), daily_cap: Number(r?.daily_cap ?? 0), monthly_cap: Number(r?.monthly_cap ?? 0),
  target_roas: Number(r?.target_roas ?? 3), min_margin_pct: Number(r?.min_margin_pct ?? 25), scale_pct: Number(r?.scale_pct ?? 20), pause_after_days: Number(r?.pause_after_days ?? 3),
  min_spend_to_judge: Number(r?.min_spend_to_judge ?? 0) });

export type AdProduct = { id: number; name: string; price: number; cost: number | null; commissionPct?: number; inStock: boolean; hasImage: boolean; visible: boolean };
export type Pick = AdProduct & { margin: number; marginPct: number; breakevenRoas: number; reason?: string };

// Reklam öncesi kâr: satış - maliyet - pazaryeri/ödeme komisyonu. Başabaş ROAS = satış / kâr (bu ROAS'ın altında reklam zarar ettirir)
export function economics(p: AdProduct) {
  if (p.cost == null || !(p.price > 0)) return null;
  const margin = p.price - p.cost - p.price * (Number(p.commissionPct) || 0) / 100;
  return { margin, marginPct: (margin / p.price) * 100, breakevenRoas: margin > 0 ? p.price / margin : Infinity };
}

export function pickProducts(products: AdProduct[], rules: AdRules, max = 50): { picked: Pick[]; skipped: Pick[] } {
  const picked: Pick[] = [], skipped: Pick[] = [];
  for (const p of products) {
    const e = economics(p);
    const row: Pick = { ...p, margin: e?.margin ?? 0, marginPct: e?.marginPct ?? 0, breakevenRoas: e?.breakevenRoas ?? Infinity };
    if (!p.visible) skipped.push({ ...row, reason: "Mağazada yayında değil" });
    else if (!p.inStock) skipped.push({ ...row, reason: "Stokta yok" });
    else if (!p.hasImage) skipped.push({ ...row, reason: "Görsel yok" });
    else if (!e) skipped.push({ ...row, reason: "Maliyet bilinmiyor (kâr hesaplanamaz)" });
    else if (e.margin <= 0) skipped.push({ ...row, reason: "Zararına satılıyor" });
    else if (e.marginPct < rules.min_margin_pct) skipped.push({ ...row, reason: `Kâr oranı %${e.marginPct.toFixed(0)} (en az %${rules.min_margin_pct})` });
    else if (e.breakevenRoas >= rules.target_roas) skipped.push({ ...row, reason: `Başabaş ROAS ${e.breakevenRoas.toFixed(1)} hedefin (${rules.target_roas}) üstünde` });
    else picked.push(row);
  }
  picked.sort((a, b) => b.margin - a.margin || a.breakevenRoas - b.breakevenRoas);
  return { picked: picked.slice(0, max), skipped: [...skipped, ...picked.slice(max).map((x) => ({ ...x, reason: "Liste sınırı" }))] };
}

// Kampanyaya verilebilecek günlük bütçe: günlük sınırdan diğer aktif bütçeler düşülür; aylık sınırdan bu ay harcanan düşülüp kalan günlere bölünür
export function allowedDailyBudget(rules: AdRules, x: { otherActiveDaily: number; spentThisMonth: number; daysLeftInMonth: number; requested?: number | null }) {
  if (!(rules.daily_cap > 0) || !(rules.monthly_cap > 0)) return { budget: 0, reason: "Günlük ve aylık bütçe sınırı girilmemiş" };
  const byDaily = rules.daily_cap - x.otherActiveDaily;
  const monthLeft = rules.monthly_cap - x.spentThisMonth;
  if (monthLeft <= 0) return { budget: 0, reason: "Aylık bütçe sınırına ulaşıldı" };
  const byMonth = monthLeft / Math.max(1, x.daysLeftInMonth);
  let b = Math.min(byDaily, byMonth, x.requested != null && x.requested > 0 ? x.requested : Infinity);
  b = Math.floor(b * 100) / 100;
  if (b <= 0) return { budget: 0, reason: "Günlük bütçe sınırı dolu (diğer reklamlar)" };
  return { budget: b, reason: null as string | null };
}

export type DayMetric = { day: string; spend: number; revenue: number; purchases: number };
export type Decision = { action: "keep" | "pause" | "scale" | "pause_cap"; newBudget?: number; reason: string; belowSince?: string | null };

// Günlük karar (kampanya başına). metrics: son günler (eskiden yeniye). belowSince: hedefin altında kaldığı ilk gün (kayıt)
export function optimize(rules: AdRules, c: { dailyBudget: number; breakevenRoas: number; belowSince: string | null; today: string; metrics: DayMetric[];
  spentThisMonth: number; otherActiveDaily: number; daysLeftInMonth: number }): Decision {
  if (rules.monthly_cap > 0 && c.spentThisMonth >= rules.monthly_cap) return { action: "pause_cap", reason: "Aylık bütçe sınırına ulaşıldı" };
  const last7 = c.metrics.slice(-7);
  const spend = last7.reduce((a, m) => a + m.spend, 0), revenue = last7.reduce((a, m) => a + m.revenue, 0);
  const minSpend = rules.min_spend_to_judge > 0 ? rules.min_spend_to_judge : c.dailyBudget;
  if (spend < minSpend) return { action: "keep", reason: "Karar için yeterli harcama yok", belowSince: c.belowSince };
  const roas = spend > 0 ? revenue / spend : 0;
  // Zarar kontrolü (kapatılamaz): başabaşın altında ve en az 2 günlük bütçe harcandıysa hemen durdur
  if (roas < c.breakevenRoas && spend >= 2 * c.dailyBudget) return { action: "pause", reason: `Zarar ediyor: ROAS ${roas.toFixed(2)} < başabaş ${c.breakevenRoas.toFixed(2)}` };
  if (roas < rules.target_roas) {
    const since = c.belowSince || c.today;
    const days = Math.floor((Date.parse(c.today) - Date.parse(since)) / 86400000) + 1;
    if (days >= rules.pause_after_days) return { action: "pause", reason: `${days} gündür hedefin altında (ROAS ${roas.toFixed(2)} < ${rules.target_roas})`, belowSince: since };
    return { action: "keep", reason: `Hedefin altında (${days}/${rules.pause_after_days}. gün)`, belowSince: since };
  }
  if (rules.auto_scale && roas >= rules.target_roas * 1.2) {
    const want = Math.round(c.dailyBudget * (1 + rules.scale_pct / 100) * 100) / 100;
    const allowed = allowedDailyBudget(rules, { otherActiveDaily: c.otherActiveDaily, spentThisMonth: c.spentThisMonth, daysLeftInMonth: c.daysLeftInMonth, requested: want });
    if (allowed.budget > c.dailyBudget) return { action: "scale", newBudget: allowed.budget, reason: `ROAS ${roas.toFixed(2)} hedefin üstünde; bütçe ${c.dailyBudget} -> ${allowed.budget}`, belowSince: null };
    return { action: "keep", reason: "Hedefin üstünde; bütçe sınırı dolu", belowSince: null };
  }
  return { action: "keep", reason: `ROAS ${roas.toFixed(2)} hedefte`, belowSince: null };
}

// Meta Insights satırından satın alma sayısı / tutarı
const PURCHASE_TYPES = ["offsite_conversion.fb_pixel_purchase", "omni_purchase", "purchase", "onsite_web_purchase"];
export function purchasesOf(row: any): { purchases: number; revenue: number } {
  const pick = (arr: any[] | undefined) => {
    for (const t of PURCHASE_TYPES) { const x = (arr || []).find((a: any) => a.action_type === t); if (x) return Number(x.value) || 0; }
    return 0;
  };
  return { purchases: pick(row.actions), revenue: pick(row.action_values) };
}

export function monthInfo(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { start, daysLeft: days - now.getUTCDate() + 1, today: now.toISOString().slice(0, 10) };
}
