// Supabase Edge Function: trend-calendar (Trend Takvimi)
// Ürünün yıl içindeki talep dalgalanmasını ve önemli tarihleri çıkarır, ürüne kaydeder.
// language: 'tr' (varsayılan) | 'en' -> açıklama metinleri ve hata mesajları bu dilde döner.
// "month", "level" ve "impact" değerleri HER ZAMAN sabit Türkçe döner (sayfa bunları kendi diline çevirir).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MSG = {
  tr: {
    needId: "Ürün ID gerekli.",
    badSession: "Oturum doğrulanamadı.",
    notFound: "Ürün bulunamadı.",
    apiError: "AI servisi hatası: ",
    badFormat: "AI beklenen formatta yanıt vermedi, lütfen tekrar dene.",
    unknown: "bilinmiyor",
  },
  en: {
    needId: "Product ID is required.",
    badSession: "Session could not be verified.",
    notFound: "Product not found.",
    apiError: "AI service error: ",
    badFormat: "AI did not respond in the expected format, please try again.",
    unknown: "unknown",
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractJson(text: string): any {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (cleaned[i] === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = cleaned.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch (_) {
            continue;
          }
        }
      }
    }
    const stripped = cleaned.replace(/[\x00-\x1F\x7F]/g, "");
    return JSON.parse(stripped);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let lang: "tr" | "en" = "tr";

  try {
    const body = await req.json().catch(() => ({}));
    const productId = body?.productId;
    const userAccessToken = body?.userAccessToken;
    lang = body?.language === "en" ? "en" : "tr";
    const m = MSG[lang];

    if (!productId) {
      return jsonResponse({ error: m.needId }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(userAccessToken);
    if (userError || !userData?.user) {
      return jsonResponse({ error: m.badSession }, 401);
    }

    const { data: product, error: productError } = await supabaseAdmin
      .from("products")
      .select("*")
      .eq("id", productId)
      .eq("user_id", userData.user.id)
      .single();

    if (productError || !product) {
      return jsonResponse({ error: m.notFound }, 404);
    }

    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
    const outLang = lang === "en" ? "İngilizce (English)" : "Türkçe";

    const systemPrompt = `Sen bir e-ticaret mevsimsellik/talep analisti asistanısın. Sana verilen ürün için web_search aracıyla en fazla 2 arama yaparak yıl içindeki talep dalgalanmalarını araştır (mevsimsellik, özel günler - Anneler/Babalar Günü, Sevgililer Günü, Yılbaşı, Black Friday, okula dönüş, yaz/kış sezonu vb. - hangileri bu ürünle ilgiliyse).

DİL KURALI: "overallPattern", "recommendation" ve keyDates içindeki "name", "approxDate", "note" alanlarını ${outLang} yaz. Ancak "month" değerleri (Ocak...Aralık), "level" değerleri ("düşük", "orta", "yüksek") ve "impact" değerleri ("yüksek", "orta") dil ne olursa olsun AŞAĞIDAKİ SABİT TÜRKÇE DEĞERLERLE yazılmalı, çevirme.

SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir metin ekleme:
{
  "overallPattern": "ürünün genel talep deseninin 1-2 cümlelik özeti",
  "monthlyDemand": [
    {"month": "Ocak", "level": "düşük"},
    {"month": "Şubat", "level": "orta"},
    {"month": "Mart", "level": "düşük"},
    {"month": "Nisan", "level": "orta"},
    {"month": "Mayıs", "level": "yüksek"},
    {"month": "Haziran", "level": "düşük"},
    {"month": "Temmuz", "level": "düşük"},
    {"month": "Ağustos", "level": "orta"},
    {"month": "Eylül", "level": "orta"},
    {"month": "Ekim", "level": "orta"},
    {"month": "Kasım", "level": "yüksek"},
    {"month": "Aralık", "level": "yüksek"}
  ],
  "keyDates": [
    {"name": "özel gün adı", "approxDate": "yaklaşık tarih", "impact": "yüksek", "note": "bu ürünle neden ilgili"}
  ],
  "recommendation": "somut, eyleme dönük 1-2 cümlelik öneri (örn. ne zaman stok/fiyat/reklam artırılmalı)"
}

monthlyDemand dizisi HER ZAMAN tam 12 ay içermeli (Ocak'tan Aralık'a), level değeri sadece "düşük", "orta" veya "yüksek" olabilir. impact değeri sadece "yüksek" veya "orta" olabilir. keyDates en fazla 4 madde olsun, ürünle gerçekten ilgisizse boş dizi döndür.`;

    const userMessage = `Ürün adı: ${product.generated_title || product.name || m.unknown}
Kategori/açıklama: ${product.generated_description || product.category || m.unknown}
Platform: ${product.platform || m.unknown}
Açıklama metinlerini ${outLang} yaz.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      }),
    });

    const data = await response.json();

    if (data?.error) {
      return jsonResponse({ error: m.apiError + (data.error.message || "") }, 500);
    }

    const textBlocks = (data.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    let result;
    try {
      result = extractJson(textBlocks);
    } catch (_) {
      return jsonResponse({ error: m.badFormat }, 500);
    }
    if (!result || typeof result !== "object" || !Array.isArray(result.monthlyDemand)) {
      return jsonResponse({ error: m.badFormat }, 500);
    }

    result.language = lang;

    await supabaseAdmin
      .from("products")
      .update({
        trend_calendar_data: result,
        trend_calendar_updated_at: new Date().toISOString(),
      })
      .eq("id", productId);

    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});