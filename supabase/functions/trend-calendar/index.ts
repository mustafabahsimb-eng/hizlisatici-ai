import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  try {
    const { productId, userAccessToken } = await req.json();

    if (!productId) {
      return new Response(JSON.stringify({ error: "Ürün ID gerekli." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(userAccessToken);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Oturum doğrulanamadı." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: product, error: productError } = await supabaseAdmin
      .from("products")
      .select("*")
      .eq("id", productId)
      .eq("user_id", userData.user.id)
      .single();

    if (productError || !product) {
      return new Response(JSON.stringify({ error: "Ürün bulunamadı." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

    const systemPrompt = `Sen bir e-ticaret mevsimsellik/talep analisti asistanısın. Sana verilen ürün için web_search aracıyla en fazla 2 arama yaparak yıl içindeki talep dalgalanmalarını araştır (mevsimsellik, özel günler - Anneler/Babalar Günü, Sevgililer Günü, Yılbaşı, Black Friday, okula dönüş, yaz/kış sezonu vb. - hangileri bu ürünle ilgiliyse).

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
    {"name": "özel gün adı", "approxDate": "yaklaşık tarih", "impact": "yüksek/orta", "note": "bu ürünle neden ilgili"}
  ],
  "recommendation": "somut, eyleme dönük 1-2 cümlelik öneri (örn. ne zaman stok/fiyat/reklam artırılmalı)"
}

monthlyDemand dizisi HER ZAMAN tam 12 ay içermeli (Ocak'tan Aralık'a), level değeri sadece "düşük", "orta" veya "yüksek" olabilir. keyDates en fazla 4 madde olsun, ürünle gerçekten ilgisizse boş dizi döndür.`;

    const userMessage = `Ürün adı: ${product.generated_title || product.name || "bilinmiyor"}
Kategori/açıklama: ${product.generated_description || "bilinmiyor"}
Platform: ${product.platform || "bilinmiyor"}`;

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
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });

    const data = await response.json();

    const textBlocks = (data.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    const result = extractJson(textBlocks);

    await supabaseAdmin
      .from("products")
      .update({
        trend_calendar_data: result,
        trend_calendar_updated_at: new Date().toISOString(),
      })
      .eq("id", productId);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});