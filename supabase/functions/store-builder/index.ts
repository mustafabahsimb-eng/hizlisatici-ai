// Supabase Edge Function: store-builder
// "Mağazanı Kur" - kullanıcının hobisi/ilgi alanı + bütçesine göre
// kişiselleştirilmiş ürün önerileri + platform önerisi + başlangıç planı üretir.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

function extractJson(fullText: string): any {
  let text = fullText.replace(/```json/gi, "").replace(/```/g, "");

  try {
    return JSON.parse(text.trim());
  } catch {
    // devam et
  }

  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;

  let candidate = text.slice(start, end + 1);
  candidate = Array.from(candidate)
    .map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch))
    .join("");

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { hobby, budget, currency, platformPreference, userAccessToken } = await req.json().catch(() => ({}));

    if (!userAccessToken) {
      return json({ error: "Oturum bilgisi gerekli" }, 400);
    }
    if (!hobby || !budget) {
      return json({ error: "Hobi/ilgi alanı ve bütçe gerekli" }, 400);
    }

    // Sadece giriş yapmış kullanıcıların çağırabilmesi için oturum doğrulanıyor
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: "Geçersiz oturum" }, 401);
    }

    const currencyLabel = currency === "$" ? "USD ($)" : "TRY (₺)";
    const platformLine = platformPreference
      ? `Kullanıcının tercih ettiği platform: ${platformPreference}.`
      : `Kullanıcı platform konusunda kararsız, en uygun platformu sen öner.`;

    const systemPrompt = `Sen bir e-ticaret/dropshipping danışmanısın. Sıfırdan mağaza açmak isteyen bir kullanıcıya hobisine/ilgi alanına göre kişiselleştirilmiş bir başlangıç planı hazırlıyorsun.

Kullanıcının hobisi/ilgi alanı: ${hobby}
Bütçesi: ${budget} ${currencyLabel}
${platformLine}

ÖNEMLİ - HIZ KURALI: En fazla 2 web araması yap, sonra doğrudan yanıtı yaz.

Görevin:
1. "title": Bu hobiye özel, kişiselleştirilmiş kısa bir başlık üret (örnek biçim: "Balık tutma hobinden mağaza kuralım" - kullanıcının kendi hobisine göre uyarla, Türkçe).
2. "products": Bu hobiyle ilgili, belirtilen bütçeye sığan 3-5 somut dropshipping ürün fikri öner. Her biri için kısa bir isim, 1 cümlelik gerekçe (neden bu hobiye uygun/satılabilir) ve tahmini birim tedarik maliyeti aralığı (${currencyLabel} cinsinden, metin olarak, örn. "50-80 ₺").
3. "platformRecommendation": ${platformPreference ? "Kullanıcının seçtiği platformun bu niş için neden uygun olduğunu 1-2 cümleyle açıkla." : "Bu niş için en uygun satış platformunu (Trendyol, Etsy, TikTok Shop, Shopify vb. gibi somut bir isim ver) ve nedenini 1-2 cümleyle açıkla."}
4. "launchSteps": İlk hafta somut olarak ne yapılması gerektiğini anlatan, sırayla 5 adımlık eyleme dönük bir başlangıç planı (her adım kısa ve net, Türkçe).

Yanıtın SADECE tek satırlık, geçerli bir JSON nesnesi olsun. JSON dışında hiçbir metin, açıklama veya markdown ekleme. Metin alanlarında satır sonu (yeni satır) kullanma.
Format: {"title": "...", "products": [{"name": "...", "reasoning": "...", "estimatedCost": "..."}], "platformRecommendation": "...", "launchSteps": ["...", "...", "...", "...", "..."]}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2500,
        system: systemPrompt,
        messages: [{ role: "user", content: `Hobi: ${hobby}, Bütçe: ${budget} ${currencyLabel}` }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      }),
    });

    const aiData = await response.json();
    if (!response.ok) {
      return json({ error: "AI hatası: " + JSON.stringify(aiData).slice(0, 300) }, 500);
    }

    const textBlocks = (aiData.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    const fullText = textBlocks.join("\n");
    const parsed = extractJson(fullText);

    if (!parsed) {
      return json({ error: "AI yanıtı JSON olarak ayrıştırılamadı", raw: fullText.slice(0, 800) }, 500);
    }

    return json({
      title: parsed.title || `${hobby} hobinden mağaza kuralım`,
      products: Array.isArray(parsed.products) ? parsed.products : [],
      platformRecommendation: parsed.platformRecommendation || "",
      launchSteps: Array.isArray(parsed.launchSteps) ? parsed.launchSteps : [],
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});