// =========================================================
// İade: yasal çerçeve + satıcı kuralı -> etkin kural, karar, para iadesi son günü, politika metni (saf fonksiyonlar; test edilebilir)
// Yasal veriler return_laws tablosunda (bölge: TR | EU | GB | US | OTHER). Satıcı yasal minimumun altına inemez, yalnız lehine değiştirir.
// =========================================================
export type Law = {
  region: string; statutory: boolean; window_days: number; refund_days: number; refund_clock: "handed_to_carrier" | "request" | "approval";
  customer_may_pay: boolean; disclosure_required: boolean; defect_days: number; refund_original_shipping: boolean; law_name_tr: string; law_name_en: string;
};
export type SellerRules = {
  auto_approve: boolean; max_auto_amount: number; window_days: number; policy_days?: number; restock: boolean; supplier_claim: boolean;
  customer_pays?: boolean; refund_warn_days?: number;
};
export const REASONS = ["size", "changed_mind", "defective", "damaged", "wrong_item", "not_as_described", "late", "other"] as const;
// Ayıplı mal: kusurlu / hasarlı / yanlış / açıklamayla uyuşmayan — tüm masraf satıcıda, fotoğraf yalnız bunlarda istenir
export const DEFECT_REASONS = ["defective", "damaged", "wrong_item", "not_as_described"];
export const isDefect = (r: string) => DEFECT_REASONS.includes(r);
export const DEFAULT_SELLER: SellerRules = { auto_approve: true, max_auto_amount: 1000, window_days: 14, policy_days: 30, restock: true, supplier_claim: true, customer_pays: false, refund_warn_days: 3 };

export const FALLBACK_LAW: Law = { region: "TR", statutory: true, window_days: 14, refund_days: 14, refund_clock: "handed_to_carrier", customer_may_pay: false,
  disclosure_required: false, defect_days: 730, refund_original_shipping: true, law_name_tr: "Mesafeli Sözleşmeler Yönetmeliği", law_name_en: "Turkish Distance Contracts Regulation" };

// Etkin kural: yasal minimum + satıcının lehine değişiklikleri
export function effective(law: Law, seller: Partial<SellerRules>) {
  const s = { ...DEFAULT_SELLER, ...seller };
  const windowDays = law.statutory ? Math.max(law.window_days, Number(s.window_days) || 0) : Math.max(1, Number(s.policy_days ?? s.window_days) || law.window_days);
  return {
    law, windowDays,
    defectDays: law.defect_days,
    customerPays: law.customer_may_pay && !!s.customer_pays,          // TR: her zaman kapalı (yasal)
    customerPaysLocked: !law.customer_may_pay,
    refundDays: law.refund_days,
    autoApprove: s.auto_approve, maxAuto: Number(s.max_auto_amount) || 0, restock: s.restock, supplierClaim: s.supplier_claim,
    warnDays: Math.max(1, Number(s.refund_warn_days) || 3),
  };
}
export type Eff = ReturnType<typeof effective>;

// Müşterinin seçebileceği nedenler: cayma istisnası üründe yalnız ayıplı mal nedenleri
export function allowedReasons(exempt: boolean) {
  return exempt ? [...DEFECT_REASONS] : [...REASONS];
}

export type DecideIn = { reason: string; amount: number | null; photos: number; ai: any; daysSince: number; exempt: boolean; fraud: string[] };
export type Decision = { auto: boolean; approve: boolean; rejectable: boolean; withdrawal: boolean; note: string };

export function decide(eff: Eff, x: DecideIn): Decision {
  const defect = isDefect(x.reason);
  const withdrawal = !defect;
  const fraudNote = x.fraud.length ? " · Kontrol: " + x.fraud.join(", ") : "";
  if (withdrawal) {
    if (x.exempt) return { auto: false, approve: false, rejectable: true, withdrawal, note: "Ürün cayma hakkı istisnası (yalnız kusurlu / yanlış ürün iadesi)" };
    const inWindow = x.daysSince <= eff.windowDays;
    if (eff.law.statutory && inWindow) {
      // Yasal cayma: reddedilemez, fotoğraf istenmez, tutar sınırı uygulanmaz; şüphe işaretleri yalnız satıcıya bilgi
      return { auto: true, approve: true, rejectable: false, withdrawal, note: `Yasal cayma hakkı (${eff.windowDays} gün)` + fraudNote };
    }
    if (!inWindow) return { auto: false, approve: false, rejectable: true, withdrawal, note: `İade süresi (${eff.windowDays} gün) geçmiş` };
    // Yasal cayma yok (ABD vb.): mağaza politikası
    if (!eff.autoApprove) return { auto: false, approve: false, rejectable: true, withdrawal, note: "Otomatik onay kapalı" };
    if (x.amount != null && eff.maxAuto && x.amount > eff.maxAuto) return { auto: false, approve: false, rejectable: true, withdrawal, note: `Tutar otomatik onay sınırının üstünde (${eff.maxAuto})` };
    if (x.fraud.length) return { auto: false, approve: false, rejectable: true, withdrawal, note: "Şüpheli: " + x.fraud.join(", ") };
    return { auto: true, approve: true, rejectable: true, withdrawal, note: "Mağaza iade politikasına uygun" };
  }
  // Ayıplı mal iddiası
  if (x.daysSince > eff.defectDays) return { auto: false, approve: false, rejectable: true, withdrawal, note: `Ayıp bildirimi süresi (${eff.defectDays} gün) geçmiş` };
  if (!x.photos) return { auto: false, approve: false, rejectable: true, withdrawal, note: "Kusur için fotoğraf yok" };
  if (!eff.autoApprove) return { auto: false, approve: false, rejectable: true, withdrawal, note: "Otomatik onay kapalı" };
  if (x.amount != null && eff.maxAuto && x.amount > eff.maxAuto) return { auto: false, approve: false, rejectable: true, withdrawal, note: `Tutar otomatik onay sınırının üstünde (${eff.maxAuto})` };
  if (x.fraud.length) return { auto: false, approve: false, rejectable: true, withdrawal, note: "Şüpheli: " + x.fraud.join(", ") };
  if (!x.ai) return { auto: false, approve: false, rejectable: true, withdrawal, note: "Fotoğraf kontrol edilemedi" };
  if (x.ai.defect_visible && Number(x.ai.confidence || 0) >= 0.6) return { auto: true, approve: true, rejectable: true, withdrawal, note: "Fotoğrafta kusur görüldü (AI)" };
  return { auto: false, approve: false, rejectable: true, withdrawal, note: "Fotoğrafta kusur net görülmedi (AI)" };
}

// İade kargosunu kim öder: ayıplı malda her zaman satıcı; caymada yalnız yasa izin veriyor ve satıcı açmışsa (ön bilgilendirmede yazılı) müşteri
export const shippingPayer = (eff: Eff, reason: string) => (!isDefect(reason) && eff.customerPays ? "customer" : "seller");

// Para iadesi son günü
//  TR: ürün iade kargosuna verildikten sonra 14 gün (kargo yoksa / dropshipping: onaydan)
//  AB / GB: cayma bildiriminden 14 gün (ürün dönene kadar bekletilebilir)
//  ABD / diğer: onaydan sonra politika süresi
export function refundDue(eff: Eff, t: { requestedAt: string; approvedAt?: string | null; handedAt?: string | null; dropship?: boolean }): string | null {
  const add = (iso: string, d: number) => new Date(new Date(iso).getTime() + d * 86400000).toISOString();
  if (eff.law.refund_clock === "request") return add(t.requestedAt, eff.refundDays);
  if (eff.law.refund_clock === "handed_to_carrier") {
    if (t.handedAt) return add(t.handedAt, eff.refundDays);
    if (t.dropship && t.approvedAt) return add(t.approvedAt, eff.refundDays);
    return null; // ürün henüz kargoya verilmedi
  }
  return t.approvedAt ? add(t.approvedAt, eff.refundDays) : null;
}

// Şüphe kontrolü (cayma reddedilemez; yalnız satıcıya bilgi / ayıp iddiasında satıcıya düşürür)
export function fraudFlags(x: { amount: number | null; maxAuto: number; recentReturns: number; daysSince: number; reason: string }) {
  const f: string[] = [];
  if (x.recentReturns >= 3) f.push(`son 90 günde ${x.recentReturns} iade`);
  if (x.amount != null && x.maxAuto && x.amount > x.maxAuto) f.push("yüksek tutar");
  if (isDefect(x.reason) && x.daysSince < 0) f.push("teslimden önce kusur bildirimi");
  return f;
}

const EXEMPT_TR: Record<string, string> = { personalized: "kişiye özel / isme özel üretilen ürünler", digital: "anında teslim edilen dijital içerikler",
  hygiene: "ambalajı açılmış hijyen ürünleri (iç giyim, kozmetik vb.)", perishable: "çabuk bozulan ürünler", market_price: "fiyatı piyasaya bağlı ürünler (altın vb.)", sealed_media: "ambalajı açılmış kitap, yazılım ve benzeri" };
const EXEMPT_EN: Record<string, string> = { personalized: "personalised / made-to-order items", digital: "instantly delivered digital content",
  hygiene: "hygiene products once unsealed (underwear, cosmetics)", perishable: "perishable goods", market_price: "goods whose price depends on the market (e.g. gold)", sealed_media: "unsealed books, software and similar" };

// Ön bilgilendirme (iade bölümü) + iade politikası metni — satıcı bilgileri ve etkin kurallarla otomatik
export function policyText(eff: Eff, s: { seller: string; address?: string | null; returnCarrier?: string | null; returnAddress?: string | null; exemptKinds?: string[]; lang: "tr" | "en" }) {
  const L = eff.law, ex = (s.exemptKinds || Object.keys(EXEMPT_TR));
  if (s.lang === "tr") {
    const lines = [`İADE VE CAYMA KOŞULLARI — ${s.seller}`, ``];
    if (L.statutory) {
      lines.push(`Cayma hakkı: Ürünü teslim aldığınız günden itibaren ${eff.windowDays} gün içinde hiçbir gerekçe göstermeden ve cezai şart ödemeden sözleşmeden cayabilirsiniz (${L.law_name_tr}).`);
      lines.push(`İade kargosu: ${s.returnCarrier ? `İade taşıyıcısı: ${s.returnCarrier}. ` : ""}${eff.customerPays ? "Cayma halinde iade kargo ücreti alıcıya aittir." : "İade kargo ücreti alınmaz."}${L.region === "TR" ? " Bulunduğunuz yerde taşıyıcının şubesi yoksa ürün adresinizden ücretsiz teslim alınır." : ""}`);
      lines.push(`Para iadesi: ${L.refund_clock === "handed_to_carrier" ? "Ürünün iade kargosuna verilmesinden" : "Cayma bildiriminizden"} itibaren en geç ${eff.refundDays} gün içinde${L.refund_original_shipping ? ", ilk gönderim kargo ücreti dahil" : ""}, ödemenizle aynı yöntemle iade edilir.`);
      lines.push(`Cayma hakkı kullanılamayan ürünler: ${ex.map((k) => EXEMPT_TR[k]).filter(Boolean).join("; ")}. Bu ürünlerde yalnızca kusurlu veya yanlış ürün iadesi yapılır.`);
    } else {
      lines.push(`İade süresi: Teslimden itibaren ${eff.windowDays} gün içinde iade talebi oluşturabilirsiniz (mağaza iade politikası).`);
      lines.push(`İade kargosu: ${eff.customerPays ? "Fikir değişikliği iadelerinde iade kargo ücreti alıcıya aittir." : "İade kargo ücreti alınmaz."}`);
      lines.push(`Para iadesi: Talebiniz onaylandıktan sonra en geç ${eff.refundDays} gün içinde yapılır.`);
    }
    lines.push(`Kusurlu, hasarlı veya yanlış ürün: Tüm masraflar satıcıya aittir; talep formunda ürünün fotoğrafını eklemeniz yeterlidir.`);
    lines.push(`İade talebi: Sipariş takip sayfanızdaki "İade talebi oluştur" bölümünden.${s.returnAddress ? ` İade adresi: ${s.returnAddress}.` : ""}`);
    return lines.join("\n");
  }
  const lines = [`RETURNS & CANCELLATION POLICY — ${s.seller}`, ``];
  if (L.statutory) {
    lines.push(`Right of withdrawal: You may cancel your order within ${eff.windowDays} days of receiving it, without giving any reason (${L.law_name_en}).`);
    lines.push(`Return shipping: ${s.returnCarrier ? `Our return carrier is ${s.returnCarrier}. ` : ""}${eff.customerPays ? "If you withdraw, you pay the cost of returning the goods." : "Return shipping is free of charge."}`);
    lines.push(`Refunds: within ${eff.refundDays} days of your withdrawal notice${L.refund_original_shipping ? ", including the original standard delivery cost" : ""}, using the same payment method. We may withhold the refund until we receive the goods or proof of return.`);
    lines.push(`Exceptions: ${ex.map((k) => EXEMPT_EN[k]).filter(Boolean).join("; ")}. For these items only faulty or wrong items can be returned.`);
  } else {
    lines.push(`Returns: You may request a return within ${eff.windowDays} days of delivery.`);
    lines.push(`Return shipping: ${eff.customerPays ? "For change-of-mind returns, return shipping is paid by the customer." : "Return shipping is free of charge."}`);
    lines.push(`Refunds: issued within ${eff.refundDays} days after your return is approved, to the original payment method.`);
    lines.push(`Non-returnable: ${ex.map((k) => EXEMPT_EN[k]).filter(Boolean).join("; ")} (unless faulty).`);
  }
  lines.push(`Faulty, damaged or wrong items: we cover all costs; just attach a photo in the return form.`);
  lines.push(`How to return: use "Request a return" on your order tracking page.${s.returnAddress ? ` Return address: ${s.returnAddress}.` : ""}`);
  return lines.join("\n");
}
