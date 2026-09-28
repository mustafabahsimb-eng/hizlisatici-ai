// Supabase Edge Function: store-spy (Mağaza X-Ray)
// Rakip mağaza linkini web aramasıyla inceleyip JSON analiz döndürür.
// language: 'tr' (varsayılan) | 'en' -> analiz metinleri ve hata mesajları bu dilde döner.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MSG = {
  tr: {
    needUrl: "Mağaza linki gerekli.",
    badSession: "Oturum doğrulanamadı.",
    apiError: "AI servisi hatası: ",
    badFormat: "AI beklenen formatta yanıt vermedi, lütfen tekrar dene.",
  },
  en: {
    needUrl: "Store link is required.",
    badSession: "Session could not be verified.",
    apiError: "AI service error: ",
    badFormat: "AI did not respond in the expected format, please try again.",
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
    const storeUrl = body?.storeUrl;
    const userAccessToken = body?.userAccessToken;
    lang = body?.language === "en" ? "en" : "tr";
    const m = MSG[lang];

    if (!storeUrl || typeof storeUrl !== "string") {
      return jsonResponse({ error: m.needUrl }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(userAccessToken);
    if (userError || !userData?.user) {
      return jsonResponse({ error: m.badSession }, 401);
    }

    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
    const outLang = lang === "en" ? "İngilizce (English)" : "Türkçe";

    const systemPrompt = `Sen bir e-ticaret rekabet analisti asistanısın. Sana verilen rakip mağaza linkini (Trendyol, Hepsiburada, Shopify, Etsy, eBay, herhangi bir pazaryeri mağaza sayfası vb. olabilir) web_search aracıyla en fazla 2 arama yaparak araştır. Şu bilgileri çıkar:
1. En çok satan / öne çıkan 5 ürüne kadar (varsa) - isim, tahmini fiyat, neden popüler olabileceği
2. Genel fiyatlandırma stratejisi (düşük fiyat/hacim mi, premium/marj mı, vb.)
3. Mağazanın güçlü yönleri (varsa: ürün çeşitliliği, marka, sosyal kanıt vb.)
4. Bu mağazaya karşı kullanıcının fark yaratabileceği somut fırsatlar (en az 2, en fazla 4 madde)

Eğer link hakkında yeterli bilgi bulunamazsa (özel/erişilemeyen sayfa, çok küçük mağaza vb.), bunu dürüstçe belirt ve genel pazaryeri/niş bazlı tahmini bir analiz sun.

DİL KURALI: JSON içindeki TÜM metin alanlarını (storeSummary, reason, pricingStrategy, strengths, opportunities) ${outLang} yaz. Ürün adlarını (name) mağazada nasıl geçiyorsa öyle bırakabilirsin. Fiyatları mağazanın kendi para birimiyle yaz.

SADECE aşağıdaki JSON formatında yanıt ver, başka hiçbir metin ekleme:
{
  "storeSummary": "kısa mağaza özeti (1-2 cümle)",
  "topProducts": [
    { "name": "ürün adı", "estimatedPrice": "fiyat veya tahmini aralık", "reason": "neden öne çıkıyor" }
  ],
  "pricingStrategy": "fiyatlandırma stratejisi açıklaması",
  "strengths": ["güçlü yön 1", "güçlü yön 2"],
  "opportunities": ["fırsat 1", "fırsat 2", "fırsat 3"]
}`;

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
        messages: [
          { role: "user", content: `Rakip mağaza linki: ${storeUrl}\nAnalizi ${outLang} yaz.` },
        ],
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
    if (!result || typeof result !== "object") {
      return jsonResponse({ error: m.badFormat }, 500);
    }

    result.language = lang;
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});