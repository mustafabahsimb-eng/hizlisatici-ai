// Supabase Edge Function: cj-sync-tracking
// Bir "orders" kaydının CJ'deki durumunu/kargo takip numarasını çeker ve
// orders tablosuna işler.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CJ_API_KEY_DEFAULT = Deno.env.get("CJ_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const AUTH_URL = "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken";
const ORDER_DETAIL_URL = "https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetail";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getUserCjApiKey(supabase: any): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("user_integrations")
      .select("api_key")
      .eq("platform", "cj")
      .maybeSingle();
    if (error) return null;
    return data?.api_key || null;
  } catch {
    return null;
  }
}

async function getCjAccessToken(apiKey: string): Promise<{ token?: string; raw?: any }> {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const data = await res.json();
  return { token: data?.data?.accessToken, raw: data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { orderId, userAccessToken } = await req.json().catch(() => ({}));
    if (!orderId || !userAccessToken) {
      return json({ error: "orderId ve oturum bilgisi gerekli" }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, supplier, supplier_order_id, status")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) return json({ error: "Sipariş bulunamadı" }, 404);
    if (order.supplier !== "cj" || !order.supplier_order_id) {
      return json({ error: "Bu sipariş henüz CJ'ye iletilmemiş" }, 400);
    }

    const userApiKey = await getUserCjApiKey(supabase);
    const CJ_API_KEY = userApiKey || CJ_API_KEY_DEFAULT;
    if (!CJ_API_KEY) return json({ error: "CJ Dropshipping API anahtarı bulunamadı" }, 500);

    const { token: accessToken, raw: authRaw } = await getCjAccessToken(CJ_API_KEY);
    if (!accessToken) {
      return json({ error: "CJ girişi başarısız: " + JSON.stringify(authRaw).slice(0, 400) }, 500);
    }

    const detailRes = await fetch(
      `${ORDER_DETAIL_URL}?orderId=${encodeURIComponent(order.supplier_order_id)}`,
      { headers: { "CJ-Access-Token": accessToken } }
    );
    const detailData = await detailRes.json();

    if (!detailData?.result) {
      return json({ error: "CJ sipariş bilgisi alınamadı: " + JSON.stringify(detailData).slice(0, 400) }, 500);
    }

    const trackNumber = detailData?.data?.trackNumber || null;
    const trackingProvider = detailData?.data?.trackingProvider || null;

    let newStatus = order.status;
    if (trackNumber && order.status !== "teslim_edildi" && order.status !== "iptal") {
      newStatus = "kargoya_verildi";
    }

    await supabase.from("orders").update({
      tracking_number: trackNumber,
      tracking_carrier: trackingProvider,
      status: newStatus,
    }).eq("id", orderId);

    return json({
      success: true,
      trackingNumber: trackNumber,
      trackingCarrier: trackingProvider,
      cjOrderStatus: detailData?.data?.orderStatus || null,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});