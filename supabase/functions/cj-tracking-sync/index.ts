// =========================================================
// HızlıSatıcı AI - cj-tracking-sync (otomatik kargo takibi)
// CJ'ye gönderilmiş siparişlerin kargo numarasını ve durumunu
// zamanlanmış görevle (cron) birkaç saatte bir kendiliğinden günceller.
// Sadece OKUR: CJ'de sipariş oluşturmaz, ödeme yapmaz.
// Güvenlik: CRON_SECRET (sync-worker ile aynı şifre).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const CJ_API_KEY_DEFAULT = Deno.env.get("CJ_API_KEY") ?? "";

const AUTH_URL = "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken";
const ORDER_DETAIL_URL = "https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetail";

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
function mapStatus(current: string, cjStatus: string | null, trackNumber: string | null): string {
  const s = String(cjStatus || "").toUpperCase();
  if (s === "DELIVERED") return "teslim_edildi";
  if (s === "CANCELLED" || s === "CANCELED") return "iptal";
  if (trackNumber || s === "SHIPPED") return "kargoya_verildi";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await isAuthorized(req))) return json({ ok: false, error: "unauthorized" }, 401);

  const started = Date.now();
  const summary = { checked: 0, updated: 0, shipped: 0, delivered: 0, cancelled: 0, errors: [] as string[] };

  try {
    const { data: orders, error } = await db
      .from("orders")
      .select("id, user_id, status, supplier_order_id, tracking_number")
      .eq("supplier", "cj")
      .not("supplier_order_id", "is", null)
      .in("status", ["tedarikciye_verildi", "kargoya_verildi"])
      .order("created_at", { ascending: true })
      .limit(MAX_ORDERS);
    if (error) throw error;
    if (!orders || orders.length === 0) return json({ ok: true, ...summary, note: "takip edilecek sipariş yok" });

    // Kullanıcı başına CJ anahtarı (kendi anahtarı yoksa sistem anahtarı)
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

      const apiKey = keyByUser.get(String(o.user_id)) || CJ_API_KEY_DEFAULT;
      if (!apiKey) { summary.errors.push(`${o.id}: CJ anahtarı yok`); continue; }

      if (!tokenByKey.has(apiKey)) tokenByKey.set(apiKey, await getCjToken(apiKey));
      const token = tokenByKey.get(apiKey);
      if (!token) { summary.errors.push(`${o.id}: CJ girişi başarısız`); continue; }

      try {
        const r = await fetch(`${ORDER_DETAIL_URL}?orderId=${encodeURIComponent(o.supplier_order_id)}`, {
          headers: { "CJ-Access-Token": token },
        });
        const d = await r.json();
        if (!d?.result) { summary.errors.push(`${o.id}: ${String(d?.message || "CJ yanıtı yok").slice(0, 120)}`); continue; }

        const trackNumber = d?.data?.trackNumber || null;
        const carrier = d?.data?.trackingProvider || null;
        const newStatus = mapStatus(o.status, d?.data?.orderStatus || null, trackNumber);

        if (newStatus !== o.status || (trackNumber && trackNumber !== o.tracking_number)) {
          const patch: Record<string, unknown> = { status: newStatus };
          if (trackNumber) patch.tracking_number = trackNumber;
          if (carrier) patch.tracking_carrier = carrier;
          const { error: uErr } = await db.from("orders").update(patch).eq("id", o.id);
          if (uErr) { summary.errors.push(`${o.id}: ${uErr.message}`); continue; }
          summary.updated++;
          if (newStatus === "kargoya_verildi" && o.status !== "kargoya_verildi") summary.shipped++;
          if (newStatus === "teslim_edildi") summary.delivered++;
          if (newStatus === "iptal") summary.cancelled++;
        }
      } catch (e) {
        summary.errors.push(`${o.id}: ${String(e).slice(0, 120)}`);
      }
    }

    return json({ ok: true, ...summary, ms: Date.now() - started });
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message || err), ...summary }, 500);
  }
});