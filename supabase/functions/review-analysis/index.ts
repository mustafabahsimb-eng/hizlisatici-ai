// Supabase Edge Function: review-analysis
// "ProductName" için gerçek müşteri yorumlarını (kendi ürünün henüz yorumu yoksa
// benzer/rakip ürünlerin yorumlarını) web'de tarayıp olumlu/olumsuz noktaları ve
// sık sorulan soruları çıkarır.

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
    const { productName } = await req.json().catch(() => ({}));
    if (!productName) {
      return new Response(JSON.stringify({ error: "Ürün adı gerekli" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const systemPrompt = `Sen bir e-ticaret müşteri deneyimi analistisin. "${productName}" ürünü/benzerleri için gerçek müşteri yorumlarını web'de tara (Trendyol, Hepsiburada, Amazon, Akakçe, Google gibi kaynaklarda).

ÖNEMLİ - HIZ KURALI: En fazla 2 web araması yap, sonra aramayı bırak ve doğrudan yanıtı yaz. Zaman sınırın var, uzun/tekrarlı araştırmaya girme.

Kurallar:
- Tam 5 olumlu nokta, 5 olumsuz/dikkat edilmesi gereken nokta ve 4 sık sorulan soru bul.
- Olumsuz noktalar gerçekten yardımcı olmalı: satıcının önceden önlem alabileceği şeyler (ör. "paketleme zayıf geliyor", "pil ömrü beklenenden kısa" gibi).
- Aramada gerçekten gördüğün bir yorum/soru ise "gozlemlenen", kendi uzmanlığına dayalı tahminse "tahmini" olarak işaretle.
- Yanıtın SADECE tek satırlık, geçerli bir JSON nesnesi olsun. JSON dışında hiçbir metin, açıklama veya markdown ekleme. Metin alanlarında satır sonu (yeni satır) kullanma.
- Format: {"positives": [{"point": "...", "source": "gozlemlenen veya tahmini"}], "negatives": [{"point": "...", "source": "gozlemlenen veya tahmini"}], "commonQuestions": [{"question": "...", "source": "gozlemlenen veya tahmini"}], "summary": "1-2 cümlelik genel özet"}`;

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