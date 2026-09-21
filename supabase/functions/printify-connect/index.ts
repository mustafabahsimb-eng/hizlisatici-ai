import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function fetchShops(apiToken: string) {
  const res = await fetch("https://api.printify.com/v1/shops.json", {
    headers: {
      Authorization: `Bearer ${apiToken.trim()}`,
      "User-Agent": "HizliSaticiAI",
    },
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false as const, error: "Printify token'ı geçersiz veya yetkisiz" };
  }
  if (!res.ok) {
    const text = await res.text();
    return { ok: false as const, error: `Printify hatası (${res.status}): ${text.slice(0, 200)}` };
  }
  const data = await res.json();
  const shops = (Array.isArray(data) ? data : []).map((s: any) => ({
    id: s.id,
    title: s.title,
    sales_channel: s.sales_channel,
  }));
  return { ok: true as const, shops };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { userAccessToken, action, apiToken, shopId } = await req.json();
    if (!userAccessToken || !action) {
      return json({ ok: false, error: "Eksik bilgi" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser(userAccessToken);
    if (authError || !user) return json({ ok: false, error: "Oturum doğrulanamadı" }, 401);

    // Bağlantı durumu (token asla geri gönderilmez)
    if (action === "status") {
      const { data: row } = await supabase
        .from("printify_connections")
        .select("shop_id, shop_title")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!row) return json({ ok: true, connected: false });
      return json({
        ok: true,
        connected: true,
        shop_id: row.shop_id,
        shop_title: row.shop_title,
      });
    }

    // Token'ı doğrula ve kaydet
    if (action === "connect") {
      if (!apiToken) return json({ ok: false, error: "Printify token'ı boş" }, 400);
      const result = await fetchShops(apiToken);
      if (!result.ok) return json({ ok: false, error: result.error });

      const only = result.shops.length === 1 ? result.shops[0] : null;
      const { error: upsertError } = await supabase.from("printify_connections").upsert(
        {
          user_id: user.id,
          api_token: apiToken.trim(),
          shop_id: only ? only.id : null,
          shop_title: only ? only.title : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
      if (upsertError) return json({ ok: false, error: `Kayıt hatası: ${upsertError.message}` });

      return json({
        ok: true,
        shops: result.shops,
        selected_shop_id: only ? only.id : null,
        selected_shop_title: only ? only.title : null,
      });
    }

    // Birden fazla mağaza varsa birini seç
    if (action === "select_shop") {
      if (!shopId) return json({ ok: false, error: "Mağaza seçilmedi" }, 400);
      const { data: row } = await supabase
        .from("printify_connections")
        .select("api_token")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!row) return json({ ok: false, error: "Önce Printify'ı bağlamalısın" }, 400);

      const result = await fetchShops(row.api_token);
      if (!result.ok) return json({ ok: false, error: result.error });
      const shop = result.shops.find((s: any) => String(s.id) === String(shopId));
      if (!shop) return json({ ok: false, error: "Bu mağaza hesabında bulunamadı" }, 400);

      const { error: updateError } = await supabase
        .from("printify_connections")
        .update({ shop_id: shop.id, shop_title: shop.title, updated_at: new Date().toISOString() })
        .eq("user_id", user.id);
      if (updateError) return json({ ok: false, error: `Kayıt hatası: ${updateError.message}` });

      return json({ ok: true, shop_id: shop.id, shop_title: shop.title });
    }

    // Kayıtlı token ile mağaza listesini yeniden çek (arayüzde seçim için)
    if (action === "list_shops") {
      const { data: row } = await supabase
        .from("printify_connections")
        .select("api_token, shop_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!row) return json({ ok: false, error: "Önce Printify'ı bağlamalısın" }, 400);
      const result = await fetchShops(row.api_token);
      if (!result.ok) return json({ ok: false, error: result.error });
      return json({ ok: true, shops: result.shops, selected_shop_id: row.shop_id });
    }

    // Bağlantıyı kaldır
    if (action === "disconnect") {
      await supabase.from("printify_connections").delete().eq("user_id", user.id);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Bilinmeyen işlem" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});