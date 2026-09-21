// Supabase Edge Function: cj-place-order
// Bir "orders" kaydını CJ Dropshipping'e gerçek sipariş olarak iletir.
// Güvenlik: payType=3 (sadece OLUŞTUR, otomatik ÖDEME YAPMA) - CJ panelinden
// elle onaylayıp ödemen gerekiyor. Test edilip güvenilir bulununca otomatik
// ödemeye geçirilebilir.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CJ_API_KEY_DEFAULT = Deno.env.get("CJ_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const AUTH_URL = "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken";
const PRODUCT_QUERY_URL = "https://developers.cjdropshipping.com/api2.0/v1/product/query";
const CREATE_ORDER_URL = "https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrderV2";

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

// cj-search'teki ile aynı desen: kullanıcının kendi CJ anahtarı varsa onu kullan
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

    // RLS ile kullanıcı sadece kendi siparişini/ürününü görebilir
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*, products(id, supplier, supplier_item_id, supplier_variant_id)")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) return json({ error: "Sipariş bulunamadı" }, 404);
    if (order.supplier !== "cj" || !order.products) {
      return json({ error: "Bu sipariş CJ Dropshipping ürünü değil ya da ürün silinmiş" }, 400);
    }
    const pid = order.products.supplier_item_id;
    if (!pid) {
      return json({
        error: "Bu ürünün CJ ürün kimliği kayıtlı değil. Ürünü add-product.html'de CJ aramasından tekrar seçip kaydet, sonra tekrar dene.",
      }, 400);
    }

    const userApiKey = await getUserCjApiKey(supabase);
    const CJ_API_KEY = userApiKey || CJ_API_KEY_DEFAULT;
    if (!CJ_API_KEY) return json({ error: "CJ Dropshipping API anahtarı bulunamadı" }, 500);

    const { token: accessToken, raw: authRaw } = await getCjAccessToken(CJ_API_KEY);
    if (!accessToken) {
      return json({ error: "CJ girişi başarısız: " + JSON.stringify(authRaw).slice(0, 400) }, 500);
    }

    // vid daha önce çözümlenip kaydedildiyse tekrar sorma, yoksa CJ'den ürün
    // varyantlarını çek ve ilkini (varsayılan) kullan.
    let vid = order.products.supplier_variant_id;
    if (!vid) {
      const pRes = await fetch(`${PRODUCT_QUERY_URL}?pid=${encodeURIComponent(pid)}`, {
        headers: { "CJ-Access-Token": accessToken },
      });
      const pData = await pRes.json();
      const variants = pData?.data?.variants || [];
      if (variants.length === 0) {
        return json({ error: "CJ'de bu ürün için varyant bulunamadı: " + JSON.stringify(pData).slice(0, 400) }, 500);
      }
      vid = variants[0].vid;
      // Sonraki siparişlerde tekrar sormamak için ürüne kaydet
      await supabase.from("products").update({ supplier_variant_id: vid }).eq("id", order.products.id);
    }

    const orderNumber = "HS-" + order.id;
    const createBody = {
      orderNumber,
      shippingCountryCode: "TR", // Not: şu an sabit TR - CJ üzerinden uluslararası satış otomasyonu eklenince alan olarak açılabilir
      shippingCountry: "Turkey", // CJ'nin API'si hem kısa kodu hem tam ülke adını zorunlu istiyor
      fromCountryCode: "CN",
      shippingCustomerName: order.customer_name || "Müşteri",
      shippingAddress: order.customer_address || "",
      shippingCity: order.customer_city || "",
      shippingProvince: order.customer_city || "",
      shippingPhone: order.customer_phone || "",
      logisticName: "CJPacket Ordinary",
      payType: 3, // 3 = sadece oluştur, ÖDEME YAPMA (CJ panelinden elle onaylanacak)
      products: [{ vid, quantity: order.quantity || 1 }],
    };

    const orderRes = await fetch(CREATE_ORDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CJ-Access-Token": accessToken },
      body: JSON.stringify(createBody),
    });
    const orderData = await orderRes.json();

    if (!orderData?.result || !orderData?.data?.orderId) {
      const errMsg = orderData?.message || JSON.stringify(orderData).slice(0, 400);
      await supabase.from("orders").update({ status: "hata", error_message: errMsg }).eq("id", orderId);
      return json({ error: "CJ sipariş oluşturamadı: " + errMsg }, 500);
    }

    await supabase.from("orders").update({
      status: "tedarikciye_verildi",
      supplier_order_id: orderData.data.orderId,
      error_message: null,
    }).eq("id", orderId);

    return json({
      success: true,
      supplierOrderId: orderData.data.orderId,
      note: "Sipariş CJ'de oluşturuldu ama ÖDENMEDİ. CJ panelinden (cjdropshipping.com > Orders) girip ödemeyi/onayı sen yapmalısın.",
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});