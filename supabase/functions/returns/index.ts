// =========================================================
// İade otomasyonu
// Müşteri (giriş yok, takip anahtarıyla — takip.html):
//   { action: "info", token }                                  -> sipariş, iade hakkı (süre), varsa iade durumu + iade etiketi
//   { action: "request", token, reasonCode, text, quantity, photos: [base64...], pickup } -> talep; yasal çerçeve + AI + satıcı kuralları -> onay / satıcıya
//   { action: "policy", slug | token | userId, country? }        -> ön bilgilendirme / iade politikası metni (TR + EN), otomatik
// Yasal çerçeve: _shared/returns-law.ts + return_laws (TR / AB / GB / ABD / diğer). Süre içindeki yasal cayma reddedilemez; fotoğraf yalnız ayıplı malda.
// Satıcı (userAccessToken):
//   { action: "decide", returnId, approve, note }  { action: "received", returnId }  { action: "refunded", returnId }
//   { action: "photos", returnId } -> imzalı fotoğraf adresleri   { action: "label", returnId } -> iade etiketini tekrar dene
// Sistem (CRON_SECRET; 30 dk): { action: "run" } -> teslim alınanlar (stok + para iadesi), pazaryeri iadeleri (Trendyol / n11), CJ anlaşmazlıkları
//   { action: "decide", userId, ... } (asistan düğmeleri)
// Kurallar: return_rules (yoksa varsayılan). Paket anahtarı: returns_auto (kapalıysa her talep satıcı onayına düşer, otomatik işlem yok).
// Dropshipping ürünü (CJ / AliExpress): müşteri ürünü geri göndermez; kusurluysa fotoğraflarla CJ'den bakiyeye iade istenir.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled } from "../_shared/features.ts";
import { cjAccessToken, cjCall, cjKeyForUser, openCjDispute } from "../_shared/cj.ts";
import { returnsAdapterFor } from "../_shared/marketplace-returns.ts";
import { etsyApiKey, etsyToken } from "../_shared/etsy.ts";
import { allowedReasons, decide as decideLaw, DEFECT_REASONS, effective, FALLBACK_LAW, fraudFlags, isDefect, type Law, policyText, REASONS as LAW_REASONS, refundDue, shippingPayer } from "../_shared/returns-law.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const REASONS: string[] = [...LAW_REASONS];

async function rulesFor(userId: string) {
  const { data } = await db.from("return_rules").select("*").eq("user_id", userId).maybeSingle();
  return data || {};
}
// Hangi hukuk: alıcının ülkesi (yoksa satıcının ana ülkesi) -> return_laws bölgesi
const lawCache = new Map<string, Law>();
async function lawFor(country: string | null | undefined, userId: string): Promise<Law> {
  let c = country;
  if (!c) { const { data } = await db.from("user_profiles").select("home_country").eq("user_id", userId).maybeSingle(); c = data?.home_country || "TR"; }
  const { data: region } = await db.rpc("return_law_region", { p_country: c });
  const key = String(region || "OTHER");
  if (!lawCache.has(key)) { const { data } = await db.from("return_laws").select("*").eq("region", key).maybeSingle(); lawCache.set(key, (data as Law) || FALLBACK_LAW); }
  return lawCache.get(key)!;
}
async function lawByRegion(region: string | null | undefined, userId: string): Promise<Law> {
  if (!region) return await lawFor(null, userId);
  if (!lawCache.has(region)) { const { data } = await db.from("return_laws").select("*").eq("region", region).maybeSingle(); lawCache.set(region, (data as Law) || FALLBACK_LAW); }
  return lawCache.get(region)!;
}
async function effFor(userId: string, country?: string | null) { return effective(await lawFor(country, userId), await rulesFor(userId)); }
const daysFrom = (iso: string) => (Date.now() - new Date(iso).getTime()) / 86400000;
async function recentReturns(userId: string, phone: string | null) {
  if (!phone) return 0;
  const { count } = await db.from("returns").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("customer_phone", phone).gte("created_at", new Date(Date.now() - 90 * 86400000).toISOString());
  return count || 0;
}

const ev = (r: any, status: string, note?: string) => [...(r.events || []), { at: new Date().toISOString(), status, ...(note ? { note } : {}) }];

// ---------- AI: neden + fotoğraf kontrolü ----------
async function aiCheck(reasonCode: string, text: string, productName: string, photos: { b64: string; mime: string }[]) {
  if (!ANTHROPIC_API_KEY) return null;
  const content: any[] = photos.slice(0, 4).map((p) => ({ type: "image", source: { type: "base64", media_type: p.mime, data: p.b64 } }));
  content.push({ type: "text", text: `Ürün: ${productName}\nMüşterinin seçtiği neden: ${reasonCode}\nMüşterinin açıklaması: ${text || "-"}\n\nBir e-ticaret iade talebini değerlendir. Yalnız JSON döndür: {"category": "${REASONS.join("|")}", "defect_visible": true|false, "matches_reason": true|false, "summary": "satıcı için 1 cümle Türkçe özet", "confidence": 0-1}. Fotoğraf yoksa defect_visible=false.` });
  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-4-6"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: "user", content }] }), signal: AbortSignal.timeout(45000),
      });
      const d = await r.json();
      if (!r.ok) continue;
      const m = (d?.content || []).map((c: any) => c.text || "").join("").match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch (_) { /* sonraki model */ }
  }
  return null;
}

async function isDropship(productId: number | null) {
  if (!productId) return false;
  const { data } = await db.from("products").select("supplier").eq("id", productId).maybeSingle();
  return ["cj", "aliexpress"].includes(data?.supplier);
}

// Onaylandı: dropshipping ise ürün geri gelmez (doğrudan para iadesi + CJ talebi); değilse iade etiketi
async function approve(ret: any, decision: "auto" | "seller" | "marketplace", note: string) {
  const drop = await isDropship(ret.product_id);
  const now = new Date().toISOString();
  const eff = effective(await lawByRegion(ret.law, ret.user_id), await rulesFor(ret.user_id));
  const due = refundDue(eff, { requestedAt: ret.created_at, approvedAt: now, dropship: drop });
  await db.from("returns").update({ status: "approved", decision, decision_note: note, events: ev(ret, "approved", note), updated_at: now, ...(due ? { refund_due_at: due } : {}) }).eq("id", ret.id);
  if (drop) {
    // Ürün geri gönderilmez; para iadesi hemen
    const { data: r2 } = await db.from("returns").select("*").eq("id", ret.id).single();
    await refundStep(r2, "Dropshipping ürünü: müşteri ürünü geri göndermez");
    return { label: false, dropship: true };
  }
  if (ret.source !== "own_store") return { label: false }; // pazaryeri iadesinde etiket pazaryerinden
  const r = await fetch(`${SUPABASE_URL}/functions/v1/shipping-hub`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON },
    body: JSON.stringify({ action: "create_return", userId: ret.user_id, returnId: ret.id, cronSecret: CRON_SECRET }), signal: AbortSignal.timeout(120000),
  }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
  if (!r?.ok) {
    const { data: r3 } = await db.from("returns").select("events").eq("id", ret.id).single();
    await db.from("returns").update({ events: [...(r3?.events || []), { at: new Date().toISOString(), status: "approved", note: "İade etiketi hazırlanamadı: " + short(r.error, 150) }] }).eq("id", ret.id);
  }
  return { label: !!r?.ok, error: r?.ok ? undefined : r?.error };
}

async function reject(ret: any, decision: "auto" | "seller", note: string) {
  await db.from("returns").update({ status: "rejected", decision, decision_note: note, events: ev(ret, "rejected", note), updated_at: new Date().toISOString() }).eq("id", ret.id);
}

// Teslim alındı / dropship onayı: stok + para iadesi (Kendi Mağazam: ödeme altyapısı gelene kadar satıcı onayıyla; pazaryeri: pazaryeri iade eder)
async function refundStep(ret: any, note?: string) {
  const rules: any = { restock: true, ...(await rulesFor(ret.user_id)) };
  const now = new Date().toISOString();
  const drop = await isDropship(ret.product_id);
  if (!drop && rules.restock && !ret.restocked && ret.product_id && ret.status === "received") {
    if (ret.variant_id) {
      const { data: v } = await db.from("product_variants").select("stock_qty").eq("id", ret.variant_id).maybeSingle();
      if (v && v.stock_qty != null) await db.from("product_variants").update({ stock_qty: Number(v.stock_qty) + ret.quantity }).eq("id", ret.variant_id);
    }
    const { data: p } = await db.from("products").select("stock_qty").eq("id", ret.product_id).maybeSingle();
    if (p && p.stock_qty != null) await db.from("products").update({ stock_qty: Number(p.stock_qty) + ret.quantity, stock_status: null }).eq("id", ret.product_id);
    await db.from("returns").update({ restocked: true }).eq("id", ret.id);
  }
  let amount = Number(ret.amount) || 0;
  // Müşteri öder (yalnız yasanın izin verdiği yerde ve ön bilgilendirmede yazılıysa; TR'de hiçbir zaman): iade kargo ücreti düşülür
  if (ret.shipping_payer === "customer" && !isDefect(ret.reason_code)) {
    const { data: sh } = await db.from("shipments").select("cost").eq("return_id", ret.id).maybeSingle();
    if (sh?.cost) amount = Math.max(0, Math.round((amount - Number(sh.cost)) * 100) / 100);
  }
  // Cayma (TR / AB / GB) ve ayıp: ilk gönderim kargo ücreti de iade edilir (sipariş kaydında varsa)
  const law = await lawByRegion(ret.law, ret.user_id);
  if ((law.refund_original_shipping || isDefect(ret.reason_code)) && ret.marketplace_order_id && !(ret.events || []).some((e: any) => /refund/.test(e.status))) {
    const { data: mo } = await db.from("marketplace_orders").select("shipping_charged").eq("id", ret.marketplace_order_id).maybeSingle();
    if (mo?.shipping_charged) amount = Math.round((amount + Number(mo.shipping_charged)) * 100) / 100;
  }
  const marketplace = ret.source !== "own_store";
  const { data: led } = await db.from("refund_ledger").select("id").eq("return_id", ret.id).maybeSingle();
  if (!led) await db.from("refund_ledger").insert({ user_id: ret.user_id, return_id: ret.id, amount, currency: ret.currency, method: marketplace ? "marketplace" : "manual", status: marketplace ? "done" : "pending",
    note: marketplace ? "Pazaryeri iade etti" : "Ödeme altyapısı bağlanınca otomatik; şimdilik satıcı iade edip onaylar", done_at: marketplace ? now : null });
  await db.from("returns").update({ amount, refund_status: marketplace ? "marketplace" : "pending", status: marketplace ? "refunded" : ret.status === "received" ? "received" : ret.status,
    ...(marketplace ? { refunded_at: now } : {}), events: ev(ret, marketplace ? "refunded" : "refund_pending", note), updated_at: now }).eq("id", ret.id);
  if (!marketplace) await db.rpc("assistant_enqueue", { p_user: ret.user_id, p_kind: "return", p_payload: { return_id: ret.id, status: "refund_pending", amount, currency: ret.currency, text: "Müşteriye para iadesi yap" }, p_dedupe: "refund:" + ret.id });
  // Sipariş kârına: iade
  if (ret.marketplace_order_id) await db.from("marketplace_orders").update({ status: "refunded" }).eq("id", ret.marketplace_order_id);
  else if (ret.store_order_id) await db.from("marketplace_orders").update({ status: "refunded" }).eq("source_table", "store_orders").eq("source_id", ret.store_order_id);
}

// Kusurlu dropshipping ürünü: CJ'den bakiyeye iade talebi
async function supplierClaim(ret: any) {
  const rules: any = { supplier_claim: true, ...(await rulesFor(ret.user_id)) };
  if (!rules.supplier_claim || ret.supplier_claim || !isDefect(ret.reason_code)) return null;
  const { data: o } = await db.from("orders").select("id, supplier, supplier_order_id, fulfilled_via").eq("user_id", ret.user_id)
    .or(ret.store_order_id ? `store_order_id.eq.${ret.store_order_id}` : `id.eq.${ret.supplier_order_id || "00000000-0000-0000-0000-000000000000"}`).limit(1).maybeSingle();
  const viaCj = o && (o.supplier === "cj" || o.fulfilled_via === "cj") && o.supplier_order_id;
  if (!viaCj) {
    await db.from("returns").update({ supplier_claim: { status: "skipped", note: o ? "CJ siparişi değil (AliExpress API'si anlaşmazlık açmaya izin vermiyor)" : "Tedarikçi siparişi bulunamadı" } }).eq("id", ret.id);
    return null;
  }
  const token = await cjAccessToken(db, await cjKeyForUser(db, ret.user_id));
  if (!token) return null;
  const urls: string[] = [];
  for (const p of ret.photos || []) { const { data } = await db.storage.from("return-photos").createSignedUrl(p, 7 * 86400); if (data?.signedUrl) urls.push(data.signedUrl); }
  const r = await openCjDispute(token, { cjOrderId: o.supplier_order_id, businessId: "SLT-RET-" + ret.id, reasonCode: ret.reason_code,
    message: `Customer return: ${ret.reason_code}. ${short(ret.ai?.summary || ret.reason_text, 300)}`, imageUrls: urls, quantity: ret.quantity });
  await db.from("returns").update({ supplier_claim: { status: r.ok ? "opened" : "error", at: new Date().toISOString(), ...r, request: undefined } }).eq("id", ret.id);
  return r;
}

// ---------- Müşteri: takip anahtarıyla ----------
async function orderByToken(token: string) {
  if (!token || token.length < 16) return null;
  const { data } = await db.from("store_orders").select("*").eq("tracking_token", token).maybeSingle();
  return data;
}
async function publicReturn(r: any) {
  if (!r) return null;
  let label: string | null = null;
  const { data: sh } = await db.from("shipments").select("label_path").eq("return_id", r.id).maybeSingle();
  if (sh?.label_path) { const { data } = await db.storage.from("shipping-labels").createSignedUrl(sh.label_path, 3600); label = data?.signedUrl || null; }
  return { id: r.id, status: r.status, reason: r.reason_code, carrier: r.carrier, returnCode: r.return_code, tracking: r.tracking_number, label, amount: r.amount, currency: r.currency,
    refund: r.refund_status, refundDueAt: r.refund_due_at, pickup: r.pickup, note: r.status === "rejected" ? r.decision_note : null, createdAt: r.created_at };
}

async function productInfo(id: number | null) {
  if (!id) return null;
  const { data } = await db.from("products").select("name, generated_title, withdrawal_exempt, withdrawal_exempt_reason, supplier").eq("id", id).maybeSingle();
  return data;
}

// Süre içindeki yasal cayma talebi reddedilemez
async function withdrawalLocked(ret: any) {
  if (!ret.withdrawal || ret.status !== "requested") return false;
  const law = await lawByRegion(ret.law, ret.user_id);
  if (!law.statutory) return false;
  if ((await productInfo(ret.product_id))?.withdrawal_exempt) return false;
  const { data: so } = ret.store_order_id ? await db.from("store_orders").select("delivered_at, shipped_at, created_at").eq("id", ret.store_order_id).maybeSingle() : { data: null };
  const eff = effective(law, await rulesFor(ret.user_id));
  const base = so ? (so.delivered_at || so.shipped_at || so.created_at) : ret.created_at;
  return daysFrom(base) - daysFrom(ret.created_at) <= eff.windowDays;   // talep, süre içinde açılmışsa
}

async function info(token: string) {
  const so = await orderByToken(token);
  if (!so) return { ok: false, error: "Sipariş bulunamadı" };
  const eff = await effFor(so.user_id, so.customer_country);
  const prod = await productInfo(so.product_id);
  const exempt = !!prod?.withdrawal_exempt;
  const base = so.delivered_at || so.shipped_at || so.created_at;
  const daysLeft = Math.ceil(eff.windowDays - daysFrom(base));
  const { data: rs } = await db.from("returns").select("*").eq("store_order_id", so.id).not("status", "in", "(cancelled)").order("created_at", { ascending: false }).limit(1);
  return { ok: true, canRequest: so.status !== "cancelled" && !rs?.length, daysLeft, windowDays: eff.windowDays, statutory: eff.law.statutory, law: eff.law.region,
    exempt, exemptReason: prod?.withdrawal_exempt_reason || null, maxQuantity: so.quantity || 1, reasons: allowedReasons(exempt), photoReasons: DEFECT_REASONS,
    returnCarrier: so.return_carrier || null, returnCode: so.return_code || null, freeReturn: !eff.customerPays, pickupAllowed: eff.law.region === "TR",
    return: await publicReturn(rs?.[0]) };
}

async function request(b: any) {
  const so = await orderByToken(String(b.token || ""));
  if (!so) return { ok: false, error: "Sipariş bulunamadı" };
  const reasonCode = REASONS.includes(b.reasonCode) ? b.reasonCode : "other";
  const { data: exists } = await db.from("returns").select("id").eq("store_order_id", so.id).not("status", "in", "(cancelled,rejected)").maybeSingle();
  if (exists) return { ok: false, error: "Bu sipariş için zaten bir iade talebi var" };
  const eff = await effFor(so.user_id, so.customer_country);
  const prod = await productInfo(so.product_id);
  const exempt = !!prod?.withdrawal_exempt;
  if (!allowedReasons(exempt).includes(reasonCode)) return { ok: false, error: "Bu ürün cayma hakkı kapsamında değil; yalnız kusurlu, hasarlı veya yanlış ürün iadesi yapılabilir" };
  const defect = isDefect(reasonCode);
  const qty = Math.max(1, Math.min(Number(so.quantity || 1), Number(b.quantity) || 1));
  const amount = so.unit_price != null ? Math.round(Number(so.unit_price) * qty * 100) / 100 : null;
  // Fotoğraf yalnız ayıplı mal nedenlerinde (caymada istenemez)
  const photos = defect ? (Array.isArray(b.photos) ? b.photos : []).slice(0, 4).map((x: string) => String(x)).filter((x: string) => x.length < 7_000_000) : [];
  const base = so.delivered_at || so.shipped_at || so.created_at;
  const daysSince = daysFrom(base);
  const fraud = fraudFlags({ amount, maxAuto: eff.maxAuto, recentReturns: await recentReturns(so.user_id, so.customer_phone), daysSince, reason: reasonCode });
  const { data: ret, error } = await db.from("returns").insert({
    user_id: so.user_id, source: "own_store", external_id: "store-" + so.id, store_order_id: so.id, product_id: so.product_id, variant_id: so.variant_id, quantity: qty,
    reason_code: reasonCode, reason_text: short(b.text, 1000), customer_name: so.customer_name, customer_phone: so.customer_phone, amount, currency: so.currency || "TRY",
    shipping_payer: shippingPayer(eff, reasonCode), law: eff.law.region, withdrawal: !defect, fraud: fraud.length ? fraud : null, pickup: !!b.pickup && eff.law.region === "TR",
    events: [{ at: new Date().toISOString(), status: "requested" }],
  }).select("*").single();
  if (error) throw error;
  const paths: string[] = [], imgs: { b64: string; mime: string }[] = [];
  for (let i = 0; i < photos.length; i++) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(photos[i]);
    const mime = m ? m[1] : "image/jpeg", b64 = m ? m[2] : photos[i];
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const path = `${so.user_id}/${ret.id}/${i + 1}.${mime.split("/")[1]}`;
      const up = await db.storage.from("return-photos").upload(path, bytes, { contentType: mime, upsert: true });
      if (!up.error) { paths.push(path); imgs.push({ b64, mime }); }
    } catch (_) { /* bozuk fotoğraf atlanır */ }
  }
  const ai = defect ? await aiCheck(reasonCode, b.text, prod?.generated_title || prod?.name || "", imgs) : null;
  await db.from("returns").update({ photos: paths, ai }).eq("id", ret.id);
  const full = { ...ret, photos: paths, ai };
  const d = decideLaw(eff, { reason: reasonCode, amount, photos: paths.length, ai, daysSince, exempt, fraud });
  // Paket anahtarı kapalıysa otomatik işlem yok (yasal cayma yine reddedilemez; satıcı onaylar)
  if (!(await featureEnabled(so.user_id, "returns_auto"))) {
    await db.from("returns").update({ decision_note: d.note }).eq("id", ret.id);
    return { ok: true, return: await publicReturn({ ...full, decision_note: d.note }), waiting: true };
  }
  if (d.auto && d.approve) {
    const a = await approve(full, "auto", d.note);
    if (a.dropship) await supplierClaim({ ...full, status: "approved" });
  } else {
    await db.from("returns").update({ decision_note: d.note }).eq("id", ret.id);
  }
  const { data: now } = await db.from("returns").select("*").eq("id", ret.id).single();
  return { ok: true, return: await publicReturn(now), waiting: !(d.auto && d.approve) };
}

const CARRIER_NAMES: Record<string, string> = { yurtici: "Yurtiçi Kargo", aras: "Aras Kargo", mng: "MNG Kargo", ptt: "PTT Kargo", surat: "Sürat Kargo", geliver: "Geliver", hepsijet: "HepsiJet", sendeo: "Sendeo" };

// Ön bilgilendirme / iade politikası metni (mağaza adresi, takip anahtarı ya da satıcı); otomatik üretilir
async function policy(b: any) {
  let userId: string | null = null, country: string | null = b.country ? String(b.country) : null, carrier: string | null = null;
  if (b.token) { const so = await orderByToken(String(b.token)); if (so) { userId = so.user_id; country = so.customer_country || country; carrier = so.return_carrier; } }
  if (!userId && b.slug) { const { data } = await db.from("store_settings").select("user_id").eq("store_slug", String(b.slug)).maybeSingle(); userId = data?.user_id || null; }
  if (!userId && b.userId) userId = String(b.userId);
  if (!userId) return { ok: false, error: "Mağaza bulunamadı" };
  if (!carrier) {
    const { data: a } = await db.from("shipping_accounts").select("provider").eq("user_id", userId).eq("is_default", true).in("status", ["connected", "verify_pending"]).maybeSingle();
    carrier = a ? (CARRIER_NAMES[a.provider] || a.provider) : null;
  }
  const { data: ss } = await db.from("store_settings").select("store_name, business_name, business_address").eq("user_id", userId).maybeSingle();
  const { data: up } = await db.from("user_profiles").select("company_name, return_address").eq("user_id", userId).maybeSingle();
  const ra = up?.return_address || {};
  const retAddr = [ra.name, ra.address, ra.district, ra.city, ra.postal_code].filter(Boolean).join(", ") || null;
  const seller = ss?.business_name || up?.company_name || ss?.store_name || "Satıcı";
  const eff = await effFor(userId, country);
  const o = { seller, address: ss?.business_address, returnCarrier: carrier, returnAddress: retAddr };
  return { ok: true, law: eff.law.region, statutory: eff.law.statutory, windowDays: eff.windowDays, freeReturn: !eff.customerPays, returnCarrier: carrier,
    tr: policyText(eff, { ...o, lang: "tr" }), en: policyText(eff, { ...o, lang: "en" }) };
}

// ---------- Satıcı ----------
async function sellerAction(userId: string, b: any) {
  const { data: ret } = await db.from("returns").select("*").eq("id", String(b.returnId || "")).eq("user_id", userId).maybeSingle();
  if (!ret) return { ok: false, error: "İade bulunamadı" };
  if (b.action === "decide") {
    if (!["requested", "received"].includes(ret.status) && !(ret.status === "approved" && b.approve)) return { ok: false, error: "Bu iade için karar verilmiş" };
    if (b.approve) {
      if (ret.source !== "own_store") return await marketplaceApprove(ret);
      const a = await approve(ret, "seller", short(b.note || "Satıcı onayladı", 200));
      if (a.dropship) await supplierClaim({ ...ret, status: "approved" });
      return { ok: true, ...a };
    }
    if (await withdrawalLocked(ret)) return { ok: false, error: "Yasal cayma hakkı: süre içindeki cayma talebi reddedilemez" };
    await reject(ret, "seller", short(b.note || "Satıcı reddetti", 300));
    return { ok: true };
  }
  if (b.action === "received") {
    if (!["approved", "label_ready", "in_transit"].includes(ret.status)) return { ok: false, error: "İade bu aşamada değil" };
    await db.from("returns").update({ status: "received", received_at: new Date().toISOString(), events: ev(ret, "received", "Satıcı teslim aldı") }).eq("id", ret.id);
    const { data: r2 } = await db.from("returns").select("*").eq("id", ret.id).single();
    await refundStep(r2);
    return { ok: true };
  }
  if (b.action === "refunded") {
    const now = new Date().toISOString();
    await db.from("refund_ledger").update({ status: "done", done_at: now }).eq("return_id", ret.id);
    await db.from("returns").update({ status: "refunded", refund_status: "done", refunded_at: now, events: ev(ret, "refunded", "Satıcı parayı iade etti") }).eq("id", ret.id);
    return { ok: true };
  }
  if (b.action === "label") {
    // İade etiketini tekrar dene (kargo firması geç yanıt verdiyse)
    if (ret.source !== "own_store" || !["approved", "label_ready"].includes(ret.status) || await isDropship(ret.product_id)) return { ok: false, error: "Bu iade için etiket gerekmiyor" };
    const r = await fetch(`${SUPABASE_URL}/functions/v1/shipping-hub`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON },
      body: JSON.stringify({ action: "create_return", userId: ret.user_id, returnId: ret.id, cronSecret: CRON_SECRET }), signal: AbortSignal.timeout(120000),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    return { ok: !!r?.ok, error: r?.ok ? undefined : r?.error };
  }
  if (b.action === "photos") {
    const urls: string[] = [];
    for (const p of ret.photos || []) { const { data } = await db.storage.from("return-photos").createSignedUrl(p, 3600); if (data?.signedUrl) urls.push(data.signedUrl); }
    return { ok: true, urls };
  }
  return { ok: false, error: "Geçersiz işlem" };
}

// ---------- Pazaryeri iadeleri ----------
async function marketplaceApprove(ret: any) {
  const ad = returnsAdapterFor(ret.source);
  if (!ad) return { ok: false, error: "Bu pazaryerinde iade onayı desteklenmiyor" };
  const { data: conn } = await db.from("store_connections").select("id, environment").eq("user_id", ret.user_id).eq("marketplace_code", ret.source).eq("status", "connected").is("deleted_at", null).limit(1).maybeSingle();
  if (!conn) return { ok: false, error: "Pazaryeri bağlantısı yok" };
  const { data: creds } = await db.rpc("store_connection_get_credentials", { p_connection_id: conn.id });
  await ad.approve({ env: conn.environment === "sandbox" ? "sandbox" : "live", creds, since: new Date() }, { claimRef: ret.raw?.claimRef || String(ret.external_id).split("/")[0], lineRefs: ret.raw?.lineRefs || [] } as any);
  await db.from("returns").update({ status: "refunded", decision: "seller", refund_status: "marketplace", refunded_at: new Date().toISOString(), events: ev(ret, "refunded", "Pazaryerinde onaylandı") }).eq("id", ret.id);
  return { ok: true };
}

async function syncMarketplaceReturns(deadline: number) {
  const { data: conns } = await db.from("store_connections").select("id, user_id, marketplace_code, environment, settings").eq("status", "connected").is("deleted_at", null).in("marketplace_code", ["trendyol_tr", "n11_tr", "etsy"]);
  const out: unknown[] = [];
  for (const c of conns || []) {
    if (Date.now() > deadline) break;
    if (!(await featureEnabled(c.user_id, "returns_auto"))) continue;
    const ad = returnsAdapterFor(c.marketplace_code)!;
    try {
      let { data: creds } = await db.rpc("store_connection_get_credentials", { p_connection_id: c.id });
      if (c.marketplace_code === "etsy") { const t = await etsyToken(db, c.id); creds = { access_token: t.token, shop_id: t.cred.shop_id, apiKey: etsyApiKey() }; }
      const since = c.settings?.returns_synced_at ? new Date(new Date(c.settings.returns_synced_at).getTime() - 3600_000) : new Date(Date.now() - 30 * 86400_000);
      const ctx = { env: c.environment === "sandbox" ? "sandbox" as const : "live" as const, creds, since };
      const list = await ad.list(ctx);
      let added = 0, approved = 0;
      for (const r of list) {
        const { data: ex } = await db.from("returns").select("*").eq("user_id", c.user_id).eq("source", c.marketplace_code).eq("external_id", r.externalId).maybeSingle();
        // Sipariş eşleme: sipariş numarası ham kayıtta (Trendyol orderNumber, n11 orderNo)
        const { data: mo } = r.orderNo ? await db.from("marketplace_orders").select("id, product_id, variant_id, buyer_country").eq("user_id", c.user_id).eq("marketplace_code", c.marketplace_code)
          .or(`raw->>orderNumber.eq.${r.orderNo},raw->>orderNo.eq.${r.orderNo}`).limit(1).maybeSingle() : { data: null };
        let row = ex;
        const eff = await effFor(c.user_id, mo?.buyer_country || (r.raw as any)?.buyerCountry || (c.marketplace_code.endsWith("_tr") ? "TR" : null));
        if (!ex) {
          const ins = await db.from("returns").insert({
            law: eff.law.region, withdrawal: !isDefect(r.reasonCode), shipping_payer: shippingPayer(eff, r.reasonCode),
            user_id: c.user_id, source: c.marketplace_code, external_id: r.externalId, marketplace_order_id: mo?.id || null, product_id: mo?.product_id || null, variant_id: mo?.variant_id || null,
            quantity: r.quantity, reason_code: r.reasonCode, reason_text: r.reasonText, customer_name: r.customerName, amount: r.amount, currency: "TRY",
            status: r.status === "received" ? "received" : r.status, decision: ["refunded", "rejected"].includes(r.status) ? "marketplace" : null,
            ...(r.status === "refunded" ? { refund_status: "marketplace", refunded_at: new Date().toISOString() } : {}),
            ...(r.status === "received" ? { received_at: new Date().toISOString() } : {}), events: [{ at: r.createdAt, status: "requested", note: c.marketplace_code }],
            raw: { claimRef: r.claimRef, lineRefs: r.lineRefs, orderNo: r.orderNo },
          }).select("*").single();
          if (ins.error) continue;
          row = ins.data;
          added++;
        } else if (ex.status !== r.status && ["refunded", "rejected", "cancelled"].includes(r.status)) {
          await db.from("returns").update({ status: r.status, decision: "marketplace", ...(r.status === "refunded" ? { refund_status: "marketplace", refunded_at: new Date().toISOString() } : {}), events: ev(ex, r.status, "Pazaryeri") }).eq("id", ex.id);
          continue;
        }
        // Ürün satıcıya ulaştı (Trendyol WaitingInAction): kurala uygunsa pazaryerinde onayla (müşteriye para iadesi pazaryerinden)
        if (row && r.status === "received" && row.status !== "refunded") {
          const d = decideLaw(eff, { reason: r.reasonCode, amount: r.amount, photos: 1, ai: { defect_visible: true, confidence: 1 }, daysSince: 0, exempt: false, fraud: [] });
          if (d.auto && d.approve) {
            try { await ad.approve(ctx, { claimRef: r.claimRef, lineRefs: r.lineRefs } as any); await db.from("returns").update({ status: "refunded", decision: "auto", refund_status: "marketplace", refunded_at: new Date().toISOString(), restocked: false, events: ev(row, "refunded", "Kurala uygun, pazaryerinde onaylandı") }).eq("id", row.id); approved++;
              const { data: r2 } = await db.from("returns").select("*").eq("id", row.id).single(); if (r2) await refundStep({ ...r2, status: "received" });
            } catch (e) { await db.from("returns").update({ decision_note: "Onay hatası: " + short((e as Error).message, 150) }).eq("id", row.id); }
          }
        }
      }
      await db.from("store_connections").update({ settings: { ...(c.settings || {}), returns_synced_at: new Date().toISOString() } }).eq("id", c.id);
      out.push({ id: c.id, code: c.marketplace_code, found: list.length, added, approved });
    } catch (e) { out.push({ id: c.id, error: short((e as Error).message) }); }
  }
  return out;
}

async function run() {
  const started = Date.now(), deadline = started + 110_000;
  const out: Record<string, unknown> = {};
  // 1) Teslim alınan (iade kargosu teslim edildi) -> stok + para iadesi
  const { data: rec } = await db.from("returns").select("*").eq("status", "received").eq("refund_status", "none").eq("source", "own_store").limit(50);
  for (const r of rec || []) { if (Date.now() > deadline) break; if (await featureEnabled(r.user_id, "returns_auto")) await refundStep(r); }
  out.received = (rec || []).length;
  // 1b) TR: para iadesi süresi ürünün iade kargosuna verilmesinden başlar
  const { data: nodue } = await db.from("returns").select("*").is("refund_due_at", null).in("status", ["in_transit", "received"]).neq("refund_status", "done").limit(100);
  for (const r of nodue || []) {
    const handed = (r.events || []).find((e: any) => e.status === "in_transit")?.at || r.received_at;
    const eff = effective(await lawByRegion(r.law, r.user_id), await rulesFor(r.user_id));
    const due = refundDue(eff, { requestedAt: r.created_at, approvedAt: (r.events || []).find((e: any) => e.status === "approved")?.at, handedAt: handed });
    if (due) await db.from("returns").update({ refund_due_at: due }).eq("id", r.id);
  }
  // 1c) Para iadesi son günü yaklaşan / geçen iadeler: satıcıya uyarı (bir kez)
  const { data: soon } = await db.from("returns").select("id, user_id, amount, currency, refund_due_at, customer_name").is("refund_warned_at", null).not("refund_due_at", "is", null)
    .not("status", "in", "(refunded,rejected,cancelled,closed)").neq("refund_status", "done").neq("refund_status", "marketplace").limit(100);
  let warned = 0;
  for (const r of soon || []) {
    const rules: any = await rulesFor(r.user_id);
    const warnDays = Math.max(1, Number(rules.refund_warn_days) || 3);
    const left = (new Date(r.refund_due_at).getTime() - Date.now()) / 86400000;
    if (left > warnDays) continue;
    await db.rpc("assistant_enqueue", { p_user: r.user_id, p_kind: "return", p_payload: { return_id: r.id, status: "refund_due", amount: r.amount, currency: r.currency, due_at: r.refund_due_at,
      text: left < 0 ? "Para iadesi yasal süresi geçti" : `Para iadesi için son ${Math.max(0, Math.ceil(left))} gün` }, p_dedupe: "refund_due:" + r.id });
    await db.from("returns").update({ refund_warned_at: new Date().toISOString() }).eq("id", r.id);
    warned++;
  }
  out.refundWarned = warned;
  // 2) Pazaryeri iadeleri
  out.marketplaces = await syncMarketplaceReturns(deadline);
  // 3) CJ anlaşmazlıkları: açık olanların durumu
  const { data: open } = await db.from("returns").select("id, user_id, supplier_claim").filter("supplier_claim->>status", "eq", "opened").limit(30);
  let checked = 0;
  for (const r of open || []) {
    if (Date.now() > deadline) break;
    const token = await cjAccessToken(db, await cjKeyForUser(db, r.user_id));
    if (!token) continue;
    const d = await cjCall(token, `/disputes/getDisputeList?orderId=${encodeURIComponent(r.supplier_claim?.request?.orderId || "")}&pageSize=10`);
    const item = (d?.data?.list || [])[0];
    if (item) await db.from("returns").update({ supplier_claim: { ...r.supplier_claim, cjStatus: item.status, cjDisputeId: item.id, money: item.money, finallyDeal: item.finallyDeal, checked_at: new Date().toISOString() } }).eq("id", r.id);
    checked++;
  }
  out.cjChecked = checked;
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "run") return json({ ok: true, ...(await run()) });
      if (b.userId && ["decide", "received", "refunded", "label"].includes(b.action)) return json(await sellerAction(String(b.userId), b));
      return json({ error: "Geçersiz işlem" }, 400);
    }
    if (b.action === "info") return json(await info(String(b.token || "")));
    if (b.action === "request") return json(await request(b));
    if (b.action === "policy") return json(await policy(b));
    const token = String(b?.userAccessToken || "").trim();
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    return json(await sellerAction(userId, b));
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
