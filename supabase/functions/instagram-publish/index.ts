import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const GRAPH = "https://graph.instagram.com/v23.0";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeCaption(p: any, lang: string): Promise<string> {
  const title = p.generated_title || p.name || "";
  const desc = String(p.generated_description || "").slice(0, 1500);
  const price = p.sale_price ? `${p.sale_price}` : "";
  const fallback = [title, desc.slice(0, 600), price ? `Fiyat: ${price}` : ""].filter(Boolean).join("\n\n");

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return fallback.slice(0, 2100);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 700,
        messages: [{
          role: "user",
          content:
            `Bir e-ticaret ürünü için Instagram gönderi açıklaması yaz. Dil: ${lang === "en" ? "İngilizce" : "Türkçe"}.\n` +
            `Kurallar: dikkat çeken ilk satır, 2-4 kısa paragraf, ürünün faydaları, uygun yerlerde az sayıda emoji, ` +
            `fiyat varsa belirt, sonda "Sipariş için DM" gibi kısa bir çağrı, en sonda 8-12 alakalı hashtag. ` +
            `Toplam 2000 karakteri geçme. Sadece açıklama metnini yaz, başka hiçbir şey yazma.\n\n` +
            `Ürün adı: ${title}\nAçıklama: ${desc}\nFiyat: ${price}`,
        }],
      }),
    });
    const data = await res.json();
    const text = (data?.content || []).map((c: any) => c?.text || "").join("").trim();
    return (text || fallback).slice(0, 2150);
  } catch {
    return fallback.slice(0, 2100);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { userAccessToken, channelId, productId, caption, imageUrl } = await req.json();
    if (!userAccessToken || !channelId || !productId) {
      return json({ error: "Eksik bilgi (userAccessToken, channelId, productId)" }, 400);
    }

    // 1) Kullanıcı
    const { data: u, error: uErr } = await supabase.auth.getUser(userAccessToken);
    if (uErr || !u?.user) return json({ error: "Oturum doğrulanamadı" }, 401);
    const userId = u.user.id;

    // 2) Kanal (kullanıcıya ait, aktif Instagram)
    const { data: ch } = await supabase
      .from("social_channels")
      .select("id, user_id, platform, account_id, account_name, active, token_expires_at")
      .eq("id", channelId)
      .maybeSingle();
    if (!ch || ch.user_id !== userId || ch.platform !== "instagram") {
      return json({ error: "Instagram hesabı bulunamadı" }, 404);
    }
    if (ch.active === false) return json({ error: "Bu Instagram hesabı pasif" }, 400);
    if (ch.token_expires_at && new Date(ch.token_expires_at).getTime() < Date.now()) {
      return json({ error: "Instagram bağlantısının süresi dolmuş, yeniden bağla" }, 400);
    }

    const { data: token, error: tErr } = await supabase.rpc("social_channel_get_token", { p_channel_id: ch.id });
    if (tErr || !token) return json({ error: "Erişim anahtarı okunamadı", detail: tErr?.message }, 500);

    // 3) Ürün (kullanıcıya ait)
    const { data: p } = await supabase
      .from("products")
      .select("id, user_id, name, generated_title, generated_description, sale_price, image_url, content_language")
      .eq("id", productId)
      .maybeSingle();
    if (!p || p.user_id !== userId) return json({ error: "Ürün bulunamadı" }, 404);

    let image = imageUrl || p.image_url;
    if (!image) {
      const { data: img } = await supabase
        .from("product_images")
        .select("*")
        .eq("product_id", productId)
        .limit(1)
        .maybeSingle();
      image = img?.url || img?.image_url || null;
    }
    if (!image || !/^https?:\/\//i.test(image)) {
      return json({ error: "Ürünün herkese açık bir görseli yok" }, 400);
    }

    // 4) Açıklama
    const finalCaption = (caption && String(caption).trim()) || await makeCaption(p, p.content_language || "tr");

    // 5) Instagram'da medya oluştur
    const createRes = await fetch(`${GRAPH}/${ch.account_id}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ image_url: image, caption: finalCaption, access_token: token }),
    });
    const created = await createRes.json();
    if (!createRes.ok || !created?.id) {
      return json({ error: "Instagram görseli kabul etmedi", detail: created?.error?.message || created }, 400);
    }

    // 6) Hazır olmasını bekle (en fazla ~30 sn)
    let status = "IN_PROGRESS";
    for (let i = 0; i < 10; i++) {
      const sRes = await fetch(`${GRAPH}/${created.id}?fields=status_code&access_token=${encodeURIComponent(token)}`);
      const s = await sRes.json();
      status = s?.status_code || status;
      if (status === "FINISHED") break;
      if (status === "ERROR" || status === "EXPIRED") {
        return json({ error: "Instagram görseli işleyemedi", detail: s }, 400);
      }
      await sleep(3000);
    }

    // 7) Yayınla
    const pubRes = await fetch(`${GRAPH}/${ch.account_id}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: created.id, access_token: token }),
    });
    const pub = await pubRes.json();
    if (!pubRes.ok || !pub?.id) {
      return json({ error: "Gönderi yayınlanamadı", detail: pub?.error?.message || pub }, 400);
    }

    // 8) Gönderi linki
    let permalink: string | null = null;
    try {
      const lRes = await fetch(`${GRAPH}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      permalink = (await lRes.json())?.permalink || null;
    } catch { /* link alınamazsa sorun değil */ }

    return json({
      ok: true,
      media_id: pub.id,
      permalink,
      account_name: ch.account_name,
      caption: finalCaption,
    });
  } catch (e) {
    return json({ error: "Beklenmeyen hata", detail: String(e) }, 500);
  }
});