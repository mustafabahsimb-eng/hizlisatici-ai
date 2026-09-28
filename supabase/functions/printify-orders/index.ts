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

async function pf(path: string, token: string) {
  const res = await fetch(`https://api.printify.com${path}`, {
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "User-Agent": "HizliSaticiAI",
    },
  });
  if (res.status === 401 || res.status === 403) throw new Error("TOKEN");
  if (res.status === 429) throw new Error("RATE");
  const text = await res.text();
  if (!res.ok) throw new Error(`Printify hatası (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Sipariş verisini arayüzün ihtiyacı kadar sadeleştirir (müşteriden sadece ad ve ülke; tutarlar cent cinsinden)
function summarize(o: any) {
  const addr = o.address_to || {};
  const items = Array.isArray(o.line_items) ? o.line_items : [];
  const shipments = Array.isArray(o.shipments) ? o.shipments : [];
  return {
    id: o.id,
    status: o.status,
    label: o.label || null,
    external_id: o.external_id || null,
    created_at: o.created_at || null,
    sent_to_production_at: o.sent_to_production_at || null,
    fulfilled_at: o.fulfilled_at || null,
    customer_name: [addr.first_name, addr.last_name].filter(Boolean).join(" ") || null,
    country: addr.country || null,
    city: addr.city || null,
    total_price: o.total_price ?? null,
    total_shipping: o.total_shipping ?? null,
    total_tax: o.total_tax ?? null,
    currency: "USD",
    items: items.map((i: any) => ({
      title: i.metadata?.title || "Ürün",
      variant: i.metadata?.variant_label || null,
      quantity: i.quantity || 1,
      status: i.status || null,
    })),
    shipments: shipments.map((s: any) => ({
      carrier: s.carrier || null,
      number: s.number || null,
      url: s.url || null,
      delivered_at: s.delivered_at || null,
    })),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { userAccessToken, action } = body;
    if (!userAccessToken || !action) return json({ ok: false, error: "Eksik bilgi" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(userAccessToken);
    if (authError || !user) return json({ ok: false, error: "Oturum doğrulanamadı" }, 401);

    const { data: conn } = await supabase
      .from("printify_connections")
      .select("api_token, shop_id, shop_title")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!conn) return json({ ok: false, error: "Önce Printify hesabını bağlamalısın (Hesaplarım sayfası)" });
    if (!conn.shop_id) return json({ ok: false, error: "Önce bir Printify mağazası seçmelisin (Hesaplarım sayfası)" });

    // Sipariş listesi (sadece okuma, Printify'da hiçbir şeyi değiştirmez)
    if (action === "list") {
      const page = Math.max(1, Number(body.page) || 1);
      const data = await pf(`/v1/shops/${conn.shop_id}/orders.json?page=${page}&limit=10`, conn.api_token);
      const items = Array.isArray(data.data) ? data.data : [];
      return json({
        ok: true,
        shop_title: conn.shop_title,
        page: data.current_page || page,
        last_page: data.last_page || 1,
        total: data.total ?? items.length,
        orders: items.map(summarize),
      });
    }

    return json({ ok: false, error: "Bilinmeyen işlem" }, 400);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg === "TOKEN") return json({ ok: false, error: "Printify token'ın geçersiz veya süresi dolmuş, yeniden bağla" });
    if (msg === "RATE") return json({ ok: false, error: "Printify istek limiti doldu, bir dakika sonra tekrar dene" });
    return json({ ok: false, error: msg }, 500);
  }
});