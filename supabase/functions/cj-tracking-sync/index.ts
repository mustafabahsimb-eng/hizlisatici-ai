// =========================================================
// Seltigo - cj-tracking-sync (otomatik kargo takibi + müşteriye WhatsApp; CJ ve AliExpress)
// CJ'ye gönderilmiş siparişlerin kargo numarasını ve durumunu
// zamanlanmış görevle (cron) kendiliğinden günceller:
//   - Satıcının CJ panelinden elle ödediği siparişleri yakalar
//   - Takip numarasını mağaza siparişine yazar (müşteri takip sayfası)
//   - Satıcının WhatsApp'ı bağlı, şablonu onaylı ve bildirimi açıksa
//     müşteriye takip linkli WhatsApp mesajı gönderir
// Sipariş oluşturmaz, ödeme yapmaz. Sadece satıcının KENDİ tedarikçi hesabı (CJ / AliExpress).
// Güvenlik: CRON_SECRET (sync-worker ile aynı şifre).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const AUTH_URL = "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken";
const ORDER_DETAIL_URL = "https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetail";
const GRAPH = "https://graph.facebook.com/v21.0";

// wa-template-worker ile aynı şablon
const WA_TEMPLATE_NAME = "seltigo_kargo_takip_v1";
const WA_TEMPLATE_LANG = "tr";

const MAX_ORDERS = 100;        // bir çalışmada en fazla kaç sipariş
const TIME_BUDGET_MS = 45000;  // Edge Function süresini aşmamak için

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function isAuthorized(req: Request): Promise<boolean> {
  if (!CRON_SECRET) return false;
  const candidates: string[] = [];
  req.headers.forEach((value) => {
    if (!value) return;
    candidates.push(value.trim());
    if (value.startsWith("Bearer ")) candidates.push(value.slice(7).trim());
  });
  new URL(req.url).searchParams.forEach((v) => candidates.push(String(v).trim()));
  try {
    const b = await req.clone().json();
    if (b && typeof b === "object") {
      Object.values(b).forEach((v) => { if (typeof v === "string") candidates.push(v.trim()); });
    }
  } catch (_) { /* gövde yok */ }
  return candidates.includes(CRON_SECRET.trim());
}

// CJ durumunu bizim durumlarımıza çevir
const CJ_NOT_PAID = ["CREATED", "IN_CART", "UNPAID"];
function mapStatus(current: string, cjStatus: string | null, trackNumber: string | null): string {
  const s = String(cjStatus || "").toUpperCase();
  if (s === "DELIVERED") return "teslim_edildi";
  if (s === "CANCELLED" || s === "CANCELED") return "iptal";
  if (trackNumber || s === "SHIPPED") return "kargoya_verildi";
  // Satıcı CJ panelinden elle ödediyse
  if (current === "odeme_bekliyor" && s && !CJ_NOT_PAID.includes(s)) return "tedarikciye_verildi";
  return current;
}

// CJ giriş anahtarı: 180 gün geçerli, getAccessToken saniyede en fazla 1 çağrı kabul ediyor.
// Bu yüzden anahtar veritabanında (cj_tokens, sadece sunucu) saklanıp tüm fonksiyonlarca paylaşılır.
const cjTokenMemo = new Map<string, string>();
async function cjAccessToken(apiKey: string): Promise<string | null> {
  if (!apiKey) return null;
  if (cjTokenMemo.has(apiKey)) return cjTokenMemo.get(apiKey)!;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { data: row } = await admin.from("cj_tokens").select("access_token, expires_at").eq("key_hash", hash).maybeSingle();
  if (row?.access_token && new Date(row.expires_at).getTime() > Date.now() + 86400000) {
    cjTokenMemo.set(apiKey, row.access_token);
    return row.access_token;
  }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }),
      });
      const d = await r.json().catch(() => ({}));
      const t = d?.data?.accessToken;
      if (t) {
        const exp = new Date(d.data.accessTokenExpiryDate || "");
        await admin.from("cj_tokens").upsert({
          key_hash: hash, access_token: t,
          expires_at: (isNaN(exp.getTime()) ? new Date(Date.now() + 14 * 86400000) : exp).toISOString(),
          updated_at: new Date().toISOString(),
        });
        cjTokenMemo.set(apiKey, t);
        return t;
      }
    } catch (_) { /* tekrar dene */ }
    await new Promise((res) => setTimeout(res, 1100 * (i + 1))); // saniyede 1 çağrı sınırı
  }
  return null;
}
async function getCjToken(apiKey: string): Promise<string | null> {
  return await cjAccessToken(apiKey);
}

// Müşteri telefonunu WhatsApp biçimine çevir (TR varsayılan)
function waPhone(raw: string | null, country: string | null): string | null {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if ((country || "TR").toUpperCase() === "TR") {
    if (d.length === 11 && d.startsWith("0")) d = "90" + d.slice(1);
    else if (d.length === 10 && d.startsWith("5")) d = "90" + d;
  }
  return d.length >= 10 && d.length <= 15 ? d : null;
}

// Mağaza siparişini güncelle; uygunsa müşteriye WhatsApp gönder
async function updateStoreOrder(o: any, newStatus: string, trackNumber: string | null, carrier: string | null, summary: any) {
  if (!o.store_order_id) return;
  const { data: so } = await db.from("store_orders").select("*").eq("id", o.store_order_id).maybeSingle();
  if (!so) return;

  const patch: Record<string, unknown> = {};
  if (trackNumber && trackNumber !== so.tracking_number) patch.tracking_number = trackNumber;
  if (carrier && carrier !== so.tracking_carrier) patch.tracking_carrier = carrier;
  if (newStatus === "kargoya_verildi" && !so.shipped_at) { patch.shipped_at = new Date().toISOString(); patch.status = "shipped"; }
  if (newStatus === "teslim_edildi" && !so.delivered_at) { patch.delivered_at = new Date().toISOString(); patch.status = "delivered"; }
  if (newStatus === "iptal" && so.status !== "cancelled") patch.status = "cancelled";
  if (Object.keys(patch).length) {
    const { error } = await db.from("store_orders").update(patch).eq("id", so.id);
    if (error) { summary.errors.push(`${o.id}: mağaza siparişi: ${error.message}`); return; }
  }

  const number = trackNumber || so.tracking_number;
  if (!number || so.whatsapp_notified_at || newStatus === "iptal") return;
  const sent = await notifyWhatsApp(o.user_id, so, number);
  if (sent === true) summary.whatsapp++;
  else if (sent) summary.errors.push(`${o.id}: WhatsApp: ${sent}`);
}

// true: gönderildi, null: gönderilmesi gerekmiyor/şartlar yok, string: hata
async function notifyWhatsApp(userId: string, so: any, trackNumber: string): Promise<true | null | string> {
  const { data: prof } = await db.from("user_profiles").select("wa_tracking_notify").eq("user_id", userId).maybeSingle();
  if (prof && prof.wa_tracking_notify === false) return null;

  const { data: tpl } = await db
    .from("whatsapp_templates")
    .select("channel_id, status")
    .eq("user_id", userId)
    .eq("name", WA_TEMPLATE_NAME)
    .eq("language", WA_TEMPLATE_LANG)
    .eq("status", "APPROVED")
    .limit(1)
    .maybeSingle();
  if (!tpl) return null; // şablon henüz onaylı değil: sadece takip sayfası

  const { data: ch } = await db
    .from("social_channels")
    .select("account_id, access_token, active")
    .eq("id", tpl.channel_id)
    .maybeSingle();
  if (!ch?.active || !ch.access_token) return null;

  const to = waPhone(so.customer_phone, so.customer_country);
  if (!to) return "müşteri telefonu geçersiz";

  const { data: store } = await db.from("store_settings").select("store_name, business_name").eq("user_id", userId).maybeSingle();
  const storeName = String(store?.store_name || store?.business_name || "Mağaza").slice(0, 60);
  const firstName = String(so.customer_name || "").trim().split(/\s+/)[0] || "Merhaba";

  const r = await fetch(`${GRAPH}/${ch.account_id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ch.access_token}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: WA_TEMPLATE_NAME,
        language: { code: WA_TEMPLATE_LANG },
        components: [
          { type: "body", parameters: [
            { type: "text", text: firstName.slice(0, 40) },
            { type: "text", text: storeName },
            { type: "text", text: String(trackNumber).slice(0, 60) },
          ] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: so.tracking_token }] },
        ],
      },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.error) return String(d?.error?.message || `HTTP ${r.status}`).slice(0, 160);

  await db.from("store_orders").update({ whatsapp_notified_at: new Date().toISOString() }).eq("id", so.id);
  return true;
}

// ---------------------------------------------------------
// AliExpress (satıcının kendi hesabı; sipariş-worker ile aynı anahtar yönetimi)
// ---------------------------------------------------------
const AE_APP_KEY = Deno.env.get("ALIEXPRESS_APP_KEY") || "";
const AE_APP_SECRET = Deno.env.get("ALIEXPRESS_APP_SECRET") || "";

async function aeSign(pathname: string, params: Record<string, string>): Promise<string> {
  const base = pathname + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(AE_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function aeCall(method: string, accessToken: string, extra: Record<string, string>): Promise<any> {
  const params: Record<string, string> = {
    app_key: AE_APP_KEY, sign_method: "sha256", timestamp: Date.now().toString(),
    access_token: accessToken, method, ...extra,
  };
  const sign = await aeSign("", params);
  const r = await fetch("https://api-sg.aliexpress.com/sync", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, sign }).toString(),
  });
  return await r.json().catch(() => ({}));
}

function aeList(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") for (const k of Object.keys(v)) if (Array.isArray(v[k])) return v[k];
  return [];
}

async function aeToken(userId: string): Promise<string | null> {
  const { data: conn } = await db.from("supplier_connections")
    .select("id, status").eq("user_id", userId).eq("supplier", "aliexpress").maybeSingle();
  if (!conn || conn.status !== "connected") return null;
  const { data: cred } = await db.rpc("supplier_connection_get_credentials", { p_connection_id: conn.id });
  if (!cred?.access_token) return null;
  const exp = cred.expires_at ? new Date(cred.expires_at).getTime() : 0;
  if (!exp || exp > Date.now() + 10 * 60000 || !cred.refresh_token) return cred.access_token;
  const params: Record<string, string> = {
    app_key: AE_APP_KEY, refresh_token: cred.refresh_token, sign_method: "sha256", timestamp: Date.now().toString(),
  };
  const sign = await aeSign("/auth/token/refresh", params);
  const r = await fetch("https://api-sg.aliexpress.com/rest/auth/token/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, sign }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) {
    await db.from("supplier_connections").update({ status: "expired", last_error: String(d.message || d.code || "yenilenemedi").slice(0, 200), updated_at: new Date().toISOString() }).eq("id", conn.id);
    return null;
  }
  const expiresAt = new Date(Date.now() + (Number(d.expires_in) || 86400) * 1000).toISOString();
  await db.rpc("supplier_connection_set_credentials", {
    p_connection_id: conn.id,
    p_credentials: { ...cred, access_token: d.access_token, refresh_token: d.refresh_token || cred.refresh_token, expires_at: expiresAt },
  });
  await db.from("supplier_connections").update({ token_expires_at: expiresAt, updated_at: new Date().toISOString() }).eq("id", conn.id);
  return d.access_token;
}

// AliExpress sipariş durumunu bizim durumlarımıza çevir
function mapAeStatus(current: string, orderStatus: string, logisticsStatus: string, endReason: string, trackNumber: string | null): string {
  const os = orderStatus.toUpperCase();
  const ls = logisticsStatus.toUpperCase();
  if (os === "IN_CANCEL" || (os === "FINISH" && /cancel|close|timeout/i.test(endReason))) return "iptal";
  if (ls === "BUYER_ACCEPT_GOODS" || os === "FINISH") return "teslim_edildi";
  if (trackNumber || ls === "SELLER_SEND_GOODS" || os === "WAIT_BUYER_ACCEPT_GOODS") return "kargoya_verildi";
  if (current === "odeme_bekliyor" && os && os !== "PLACE_ORDER_SUCCESS") return "tedarikciye_verildi";
  return current;
}

// Tedarikçiden sipariş durumu: { trackNumber, carrier, supplierStatus, newStatus } ya da { error }
async function cjDetail(o: any, token: string) {
  const r = await fetch(`${ORDER_DETAIL_URL}?orderId=${encodeURIComponent(o.supplier_order_id)}`, {
    headers: { "CJ-Access-Token": token },
  });
  const d = await r.json().catch(() => ({}));
  if (!d?.result) return { error: "CJ sipariş bilgisi alınamadı: " + String(d?.message || "CJ yanıtı yok").slice(0, 120) };
  const trackNumber = d?.data?.trackNumber || null;
  const supplierStatus = d?.data?.orderStatus || null;
  return {
    trackNumber,
    carrier: d?.data?.trackingProvider || d?.data?.logisticName || null,
    supplierStatus,
    newStatus: mapStatus(o.status, supplierStatus, trackNumber),
  };
}

async function aeDetail(o: any, token: string) {
  const d = await aeCall("aliexpress.trade.ds.order.get", token, {
    order_id: String(o.supplier_order_id),
    single_order_query: JSON.stringify({ order_id: Number(o.supplier_order_id) }),
  });
  const res = d?.aliexpress_trade_ds_order_get_response?.result || d?.aliexpress_ds_trade_order_get_response?.result;
  if (!res) {
    const e = d?.error_response || d;
    return { error: "AliExpress sipariş bilgisi alınamadı: " + String(e?.msg || e?.sub_msg || e?.message || "yanıt yok").slice(0, 120) };
  }
  const logi = aeList(res.logistics_info_list)[0] || null;
  const trackNumber = logi?.logistics_no ? String(logi.logistics_no) : null;
  const supplierStatus = String(res.order_status || "");
  return {
    trackNumber,
    carrier: logi?.logistics_service || null,
    supplierStatus,
    newStatus: mapAeStatus(o.status, supplierStatus, String(res.logistics_status || ""), String(res.end_reason || ""), trackNumber),
  };
}

// Tek siparişin tedarikçi durumunu çek, siparişe ve mağaza siparişine işle
async function syncOne(o: any, token: string, summary: any) {
  const det: any = o.supplier === "aliexpress" ? await aeDetail(o, token) : await cjDetail(o, token);
  if (det.error) {
    summary.errors.push(`${o.id}: ${det.error}`);
    return { error: det.error };
  }
  const trackNumber = det.trackNumber;
  const carrier = det.carrier;
  const cjStatus = det.supplierStatus;
  const newStatus = det.newStatus;

  if (newStatus !== o.status || (trackNumber && trackNumber !== o.tracking_number)) {
    const patch: Record<string, unknown> = { status: newStatus };
    if (trackNumber) patch.tracking_number = trackNumber;
    if (carrier) patch.tracking_carrier = carrier;
    if (o.status === "odeme_bekliyor" && newStatus !== "odeme_bekliyor") {
      patch.hold_reason = null;
      patch.paid_at = new Date().toISOString();
      summary.paid++;
    }
    const { error: uErr } = await db.from("orders").update(patch).eq("id", o.id);
    if (uErr) { summary.errors.push(`${o.id}: ${uErr.message}`); return { error: uErr.message }; }
    summary.updated++;
    if (newStatus === "kargoya_verildi" && o.status !== "kargoya_verildi") summary.shipped++;
    if (newStatus === "teslim_edildi") summary.delivered++;
    if (newStatus === "iptal") summary.cancelled++;
  }

  // Mağaza siparişi + müşteri bildirimi (bildirim daha önce gitmediyse tekrar dener)
  await updateStoreOrder(o, newStatus, trackNumber, carrier, summary);
  return { success: true, trackingNumber: trackNumber, trackingCarrier: carrier, cjOrderStatus: cjStatus, status: newStatus };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const summary = { checked: 0, updated: 0, shipped: 0, delivered: 0, cancelled: 0, paid: 0, whatsapp: 0, errors: [] as string[] };

  // Satıcı modu: Siparişler sayfasındaki "takibi güncelle" (tek sipariş)
  if (!(await isAuthorized(req))) {
    const body = await req.json().catch(() => ({}));
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const userToken = String(body?.userAccessToken || bearer || "");
    const { data: u } = userToken ? await db.auth.getUser(userToken) : { data: { user: null } };
    const userId = u?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    try {
      const { data: o } = await db
        .from("orders")
        .select("id, user_id, status, supplier, supplier_order_id, tracking_number, store_order_id")
        .eq("id", String(body?.orderId || ""))
        .eq("user_id", userId)
        .maybeSingle();
      if (!o) return json({ error: "Sipariş bulunamadı" }, 404);
      if (o.supplier === "aliexpress") {
        if (!o.supplier_order_id) return json({ error: "Bu sipariş henüz AliExpress'e verilmemiş" }, 400);
        const aeTok = await aeToken(userId);
        if (!aeTok) return json({ error: "AliExpress hesabın bağlı değil ya da süresi doldu. Hesaplarım sayfasından bağla." }, 400);
        const res = await syncOne(o, aeTok, summary);
        return json(res, res.error ? 500 : 200);
      }
      if (o.supplier !== "cj" || !o.supplier_order_id) return json({ error: "Bu sipariş henüz CJ'ye iletilmemiş" }, 400);
      const { data: integ } = await db.from("user_integrations").select("api_key").eq("user_id", userId).eq("platform", "cj").maybeSingle();
      if (!integ?.api_key) return json({ error: "CJ hesabın bağlı değil. Hesaplarım sayfasından CJ'yi bağla." }, 400);
      const token = await getCjToken(integ.api_key);
      if (!token) return json({ error: "CJ girişi başarısız (API anahtarını kontrol et)." }, 400);
      const res = await syncOne(o, token, summary);
      return json(res, res.error ? 500 : 200);
    } catch (e) {
      return json({ error: String((e as Error)?.message || e) }, 500);
    }
  }

  const started = Date.now();

  try {
    const { data: orders, error } = await db
      .from("orders")
      .select("id, user_id, status, supplier, supplier_order_id, tracking_number, store_order_id")
      .in("supplier", ["cj", "aliexpress"])
      .not("supplier_order_id", "is", null)
      .in("status", ["odeme_bekliyor", "tedarikciye_verildi", "kargoya_verildi"])
      .order("created_at", { ascending: true })
      .limit(MAX_ORDERS);
    if (error) throw error;
    if (!orders || orders.length === 0) return json({ ok: true, ...summary, note: "takip edilecek sipariş yok" });

    // Kullanıcı başına KENDİ CJ anahtarı
    const userIds = [...new Set(orders.map((o) => o.user_id))];
    const { data: integ } = await db
      .from("user_integrations")
      .select("user_id, api_key")
      .eq("platform", "cj")
      .in("user_id", userIds);
    const keyByUser = new Map<string, string>();
    (integ || []).forEach((r: any) => { if (r.api_key) keyByUser.set(String(r.user_id), r.api_key); });

    const tokenByKey = new Map<string, string | null>();
    const aeTokenByUser = new Map<string, string | null>();

    for (const o of orders) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      summary.checked++;

      if (o.supplier === "aliexpress") {
        const uid = String(o.user_id);
        if (!aeTokenByUser.has(uid)) aeTokenByUser.set(uid, await aeToken(uid));
        const aeTok = aeTokenByUser.get(uid);
        if (!aeTok) { summary.errors.push(`${o.id}: AliExpress hesabı bağlı değil`); continue; }
        try { await syncOne(o, aeTok, summary); } catch (e) { summary.errors.push(`${o.id}: ${String(e).slice(0, 120)}`); }
        continue;
      }

      const apiKey = keyByUser.get(String(o.user_id));
      if (!apiKey) { summary.errors.push(`${o.id}: CJ hesabı bağlı değil`); continue; }

      if (!tokenByKey.has(apiKey)) tokenByKey.set(apiKey, await getCjToken(apiKey));
      const token = tokenByKey.get(apiKey);
      if (!token) { summary.errors.push(`${o.id}: CJ girişi başarısız`); continue; }

      try {
        await syncOne(o, token, summary);
      } catch (e) {
        summary.errors.push(`${o.id}: ${String(e).slice(0, 120)}`);
      }
    }

    return json({ ok: true, ...summary, ms: Date.now() - started });
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message || err), ...summary }, 500);
  }
});
