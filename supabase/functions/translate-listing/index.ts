// Supabase Edge Function: translate-listing
// Verilen Türkçe ürün başlığı/açıklama/etiketlerini (ya da sadece ürün adını) SEO dostu,
// pazarlama diline uygun İngilizceye çevirir. Uluslararası platformlar (Etsy, Amazon Global,
// eBay vb.) için kullanılır. Web araması gerekmez, bu yüzden hızlıdır.

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
    const { title, description, tags, productName } = await req.json().catch(() => ({}));

    if (!title && !description && !productName) {
      return new Response(JSON.stringify({ error: "Çevrilecek içerik yok (başlık, açıklama ya da ürün adı gerekli)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parts: string[] = [];
    if (productName) parts.push(`Ürün adı: ${productName}`);
    if (title) parts.push(`Başlık: ${title}`);
    if (description) parts.push(`Açıklama: ${description}`);
    if (tags) parts.push(`Etiketler: ${tags}`);
    const sourceText = parts.join("\n");

    const systemPrompt = `Sen profesyonel bir e-ticaret çevirmeni ve pazarlama metni yazarısın. Sana verilen Türkçe ürün bilgisini, uluslararası platformlarda (Etsy, Amazon Global, eBay, TikTok Shop vb.) satılacak şekilde doğal, akıcı ve SEO dostu İngilizceye çevir. Birebir kelime çevirisi yapma; İngilizce konuşan alıcıya hitap eden pazarlama diliyle yaz.

Kurallar:
- titleEn: kısa, çarpıcı, anahtar kelime içeren İngilizce ürün başlığı.
- descriptionEn: akıcı, satış odaklı İngilizce açıklama (2-4 cümle).
- tagsEn: tam 8 adet İngilizce etiket/anahtar kelime (dizi olarak).
- Girdi olarak sadece ürün adı verildiyse, başlık/açıklama/etiketleri sen İngilizce olarak baştan üret.
- Yanıtın SADECE tek satırlık, geçerli bir JSON nesnesi olsun. JSON dışında hiçbir metin, açıklama veya markdown ekleme. Metin alanlarında satır sonu (yeni satır) kullanma.
- Format: {"titleEn": "...", "descriptionEn": "...", "tagsEn": ["...", "..."]}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: "user", content: sourceText }],
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