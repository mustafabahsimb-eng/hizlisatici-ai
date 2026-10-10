// =========================================================
// Seltigo - cj-tracking-sync (otomatik kargo takibi + müşteriye WhatsApp)
// CJ'ye gönderilmiş siparişlerin kargo numarasını ve durumunu
// zamanlanmış görevle (cron) kendiliğinden günceller:
//   - Satıcının CJ panelinden elle ödediği siparişleri yakalar
//   - Takip numarasını mağaza siparişine yazar (müşteri takip sayfası)
//   - Satıcının WhatsApp'ı bağlı, şablonu onaylı ve bildirimi açıksa
//     müşteriye takip linkli WhatsApp mesajı gönderir
// CJ'de sipariş oluşturmaz, ödeme yapmaz. Sadece satıcının KENDİ CJ hesabı.
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

async function getCjToken(apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const data = await res.json();
    return data?.data?.accessToken || null;
  } catch (_) {
    return null;
  }
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

// Tek siparişin CJ durumunu çek, siparişe ve mağaza siparişine işle
async function syncOne(o: any, token: string, summary: any) {
  const r = await fetch(`${ORDER_DETAIL_URL}?orderId=${encodeURIComponent(o.supplier_order_id)}`, {
    headers: { "CJ-Access-Token": token },
  });
  const d = await r.json();
  if (!d?.result) {
    const m = String(d?.message || "CJ yanıtı yok").slice(0, 120);
    summary.errors.push(`${o.id}: ${m}`);
    return { error: "CJ sipariş bilgisi alınamadı: " + m };
  }

  const trackNumber = d?.data?.trackNumber || null;
  const carrier = d?.data?.trackingProvider || d?.data?.logisticName || null;
  const cjStatus = d?.data?.orderStatus || null;
  const newStatus = mapStatus(o.status, cjStatus, trackNumber);

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
      .select("id, user_id, status, supplier_order_id, tracking_number, store_order_id")
      .eq("supplier", "cj")
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

    for (const o of orders) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      summary.checked++;

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
