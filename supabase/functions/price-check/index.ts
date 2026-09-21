// Supabase Edge Function: price-check
// "productName" için rakip/piyasa fiyatlarını web'de tarayıp bulur, kullanıcının
// girdiği kendi satış fiyatıyla karşılaştırır (ucuz/pahalı/rekabetçi mi).

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { productName, myPrice, platform, currency } = await req.json().catch(() => ({}));
    if (!productName) {
      return new Response(JSON.stringify({ error: "Ürün adı gerekli" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const priceText = myPrice ? `Kullanıcının satış fiyatı: ${myPrice} ${currency || "TL"}.` : "Kullanıcı henüz fiyat girmedi.";
    const platformText = platform ? `Satış platformu: ${platform}.` : "";

    const systemPrompt = `Sen bir e-ticaret fiyat analistisin. "${productName}" ürünü için Trendyol, Hepsiburada, Amazon, Akakçe gibi gerçek platformlarda web'de fiyat taraması yap. ${priceText} ${platformText}

ÖNEMLİ - HIZ KURALI: En fazla 2 web araması yap, sonra aramayı bırak ve doğrudan yanıtı yaz. Zaman sınırın var, uzun/tekrarlı araştırmaya girme.

Kurallar:
- Tam 5 adet gerçek/tahmini rakip fiyat bul (platform adı + fiyat + kaynak).
- minPrice, maxPrice, avgPrice: bulduğun fiyatların minimum, maksimum, ortalaması (sayı, TL cinsinden tahmini, döviz farklıysa yaklaşık TL karşılığını hesapla).
- Kullanıcı kendi fiyatını verdiyse, positionText alanında onun fiyatının piyasaya göre "ucuz kaçmış", "rekabetçi/normal aralıkta" ya da "pahalı kaçmış" olduğunu net şekilde belirt ve kısa bir öneri ekle.
- Kullanıcı fiyat vermediyse positionText'i null bırak.
- Aramada gerçekten gördüğün bir fiyatsa "gozlemlenen", kendi uzmanlığına dayalı tahminse "tahmini" olarak işaretle.
- Yanıtın SADECE tek satırlık, geçerli bir JSON nesnesi olsun. JSON dışında hiçbir metin, açıklama veya markdown ekleme. Metin alanlarında satır sonu (yeni satır) kullanma.
- Format: {"competitors": [{"platform": "...", "price": "...", "source": "gozlemlenen veya tahmini"}], "minPrice": 0, "maxPrice": 0, "avgPrice": 0, "positionText": "..." veya null, "summary": "1-2 cümlelik genel özet"}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: `Ürün: ${productName}` }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: "AI hatası: " + JSON.stringify(data).slice(0, 300) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const textBlocks = (data.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    const fullText = textBlocks.join("\n");

    const parsed = extractJson(fullText);

    if (!parsed) {
      return new Response(
        JSON.stringify({
          error: "AI yanıtı JSON olarak ayrıştırılamadı",
          raw: fullText.slice(0, 800),
          stopReason: data.stop_reason || null,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});