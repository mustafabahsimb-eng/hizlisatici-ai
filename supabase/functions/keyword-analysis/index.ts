// Supabase Edge Function: keyword-analysis
// Ürün adı için gerçek rakip ilanlarını (web araması ile) tarayıp
// gerçekten kullanılan/aranan anahtar kelimeleri bulur (AI'nin kör tahmini değil).

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// AI'nin döndürdüğü metin içinden gerçek JSON nesnesini güvenli şekilde çıkarır.
// Süslü parantezleri tek tek sayar (string içindekileri saymaz), böylece
// metnin içinde fazladan yazı veya bozuk karakter olsa bile doğru JSON'u bulur.
function extractJson(fullText: string): any {
  let text = fullText.replace(/```json/gi, "").replace(/```/g, "");

  try {
    return JSON.parse(text.trim());
  } catch {
    // devam et, aşağıda daha dikkatli dene
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
  // JSON string içinde olmaması gereken ham kontrol karakterlerini (satır sonu vb.) temizle
  candidate = candidate.replace(/[\u0000-\u001F]/g, (c) =>
    c === "\n" || c === "\r" || c === "\t" ? " " : ""
  );

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
    const { productName, platform } = await req.json().catch(() => ({}));
    if (!productName) {
      return new Response(JSON.stringify({ error: "Ürün adı gerekli" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const platformHint = platform ? ` (özellikle ${platform} platformunda satan ilanlara bak)` : "";

    const systemPrompt = `Sen bir e-ticaret SEO/anahtar kelime araştırmacısısın. Web aramasını kullanarak "${productName}" ürünü için gerçek, satan/popüler ilanların başlıklarını ve açıklamalarını tara${platformHint}.
Amacın AI'nin kör tahmini değil, GERÇEK ilanlarda geçen kelimeleri bulmak.

Kurallar:
- En az 8, en fazla 15 anahtar kelime/kelime öbeği öner.
- Her biri için, gerçekten ilan başlıklarında/açıklamalarında gördüğünse "gozlemlenen", arama sinyallerine dayalı profesyonel bir tahminse "tahmini" olarak işaretle.
- Arama sonuçları yetersiz olsa bile boş liste döndürme, elindeki sinyallerle en iyi profesyonel tahmini yap ve "tahmini" olarak işaretle.
- Yanıtın SADECE tek satırlık, geçerli bir JSON nesnesi olsun. JSON dışında hiçbir metin, açıklama veya markdown ekleme. "note" alanlarında satır sonu (yeni satır) kullanma.
- Format: {"keywords": [{"term": "...", "source": "gozlemlenen veya tahmini", "note": "kısa açıklama"}], "summary": "1-2 cümlelik özet"}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: "user", content: `Ürün: ${productName}` }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
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