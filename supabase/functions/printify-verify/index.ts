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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { userAccessToken, apiToken } = await req.json();
    if (!userAccessToken || !apiToken) {
      return json({ ok: false, error: "Eksik bilgi: oturum veya Printify token'ı yok" }, 400);
    }

    // Kullanıcının oturumunu doğrula
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(userAccessToken);
    if (authError || !user) return json({ ok: false, error: "Oturum doğrulanamadı" }, 401);

    // Printify'a gerçek istek at: token geçerliyse mağaza listesini döndürür
    const res = await fetch("https://api.printify.com/v1/shops.json", {
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
        "User-Agent": "HizliSaticiAI",
      },
    });

    if (res.status === 401 || res.status === 403) {
      return json({ ok: false, error: "Printify token'ı geçersiz veya yetkisiz" });
    }
    if (!res.ok) {
      const text = await res.text();
      return json({ ok: false, error: `Printify hatası (${res.status}): ${text.slice(0, 200)}` });
    }

    const shops = await res.json();
    return json({
      ok: true,
      shops: (Array.isArray(shops) ? shops : []).map((s: any) => ({
        id: s.id,
        title: s.title,
        sales_channel: s.sales_channel,
      })),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});