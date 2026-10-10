// Supabase Edge Function: whatsapp-send
// Seçili ürünleri, satıcının bağlı WhatsApp numarasından müşteriye ÜRÜN KARTI olarak gönderir.
// 1 ürün -> tek ürün kartı, 2+ ürün -> çoklu ürün listesi (en fazla 30). Kartlar Meta kataloğundan gelir.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GRAPH = "https://graph.facebook.com/v21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function niceWaError(e: any): string {
  const code = e?.code;
  const msg = String(e?.error_user_msg || e?.message || "WhatsApp hatası");
  if (code === 131047 || /re-engagement|24 hours/i.test(msg)) return "Müşteri son 24 saat içinde sana yazmamış. WhatsApp kuralı gereği önce müşterinin sana bir mesaj atması gerekiyor (ör. \"merhaba\"); sonra ürünleri hemen gönderebilirsin.";
  if (code === 131030 || /not in allowed list|recipient phone number not in/i.test(msg)) return "Bu numara test listesinde değil. Test numarasıyla sadece Meta'da eklediğin numaralara gönderilebilir.";
  if (code === 131009 || /product|catalog/i.test(msg)) return "Ürün kataloğu WhatsApp'ta henüz hazır değil ya da ürün katalogda yok. Önce \"Tüm ürünleri kataloğa gönder\" de, birkaç dakika sonra tekrar dene. (" + msg + ")";
  if (/expired|validating access token|session has been invalidated/i.test(msg)) return "WhatsApp bağlantısının süresi dolmuş. WhatsApp'ı tekrar bağla.";
  return msg;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const { userAccessToken } = body;
    if (!userAccessToken) return json({ error: "Oturum bilgisi gerekli" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });
    const { data: u, error: uErr } = await supabase.auth.getUser(userAccessToken);
    if (uErr || !u?.user) return json({ error: "Oturum geçersiz" }, 401);
    const userId = u.user.id;

    // Alıcı numara: sadece rakam, Türkiye için 0'la başlıyorsa 90 ekle
    let to = String(body.to || "").replace(/\D/g, "");
    if (to.startsWith("00")) to = to.slice(2);
    if (to.length === 11 && to.startsWith("0")) to = "90" + to.slice(1);
    if (to.length === 10 && to.startsWith("5")) to = "90" + to;
    if (to.length < 8) return json({ error: "Müşterinin telefon numarasını yaz." }, 400);

    const ids: string[] = (Array.isArray(body.productIds) ? body.productIds : []).map(String).slice(0, 30);
    if (!ids.length) return json({ error: "Önce en az bir ürün seç." }, 400);

    // WhatsApp numarası
    let q = supabase.from("social_channels").select("*").eq("user_id", userId).eq("platform", "whatsapp").eq("active", true);
    if (body.channelId) q = q.eq("id", body.channelId);
    const { data: chans } = await q.limit(1);
    const ch = chans?.[0];
    if (!ch) return json({ error: "Önce WhatsApp'ı bağla." }, 400);

    // Katalog
    const { data: cat } = await supabase.from("meta_catalogs").select("catalog_id, user_token").eq("user_id", userId).maybeSingle();
    if (!cat?.catalog_id) return json({ error: "Önce bir katalog seç ve ürünleri kataloğa gönder." }, 400);
    const token = ch.access_token || cat.user_token;

    // Ürün adları (liste başlığı/bölüm için)
    const { data: prods } = await supabase.from("products").select("id, name, generated_title").eq("user_id", userId).in("id", ids);
    const nameOf: Record<string, string> = {};
    (prods || []).forEach((p: any) => { nameOf[String(p.id)] = p.generated_title || p.name || ""; });

    const text = String(body.text || "").trim().slice(0, 1000);
    const header = String(body.header || "Ürünlerimiz").trim().slice(0, 60) || "Ürünlerimiz";

    let interactive: any;
    if (ids.length === 1) {
      interactive = {
        type: "product",
        body: { text: text || (nameOf[ids[0]] ? nameOf[ids[0]].slice(0, 1000) : "Ürünümüzü inceleyebilirsin 👇") },
        action: { catalog_id: String(cat.catalog_id), product_retailer_id: `seltigo_${ids[0]}` },
      };
    } else {
      interactive = {
        type: "product_list",
        header: { type: "text", text: header },
        body: { text: text || "Seçtiğimiz ürünleri inceleyebilir, sepete ekleyip sipariş verebilirsin 👇" },
        action: {
          catalog_id: String(cat.catalog_id),
          sections: [{ title: header.slice(0, 24), product_items: ids.map((id) => ({ product_retailer_id: `seltigo_${id}` })) }],
        },
      };
    }

    const r = await fetch(`${GRAPH}/${ch.account_id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.error) return json({ error: niceWaError(d.error), raw: d.error?.message }, 400);

    return json({ ok: true, to, count: ids.length, message_id: d.messages?.[0]?.id || null });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});