// Supabase Edge Function: shipping-estimate
// "productName" ve "platform" için gerçekçi kargo/teslimat süresi tahmini üretir:
// tedarikçiden (ör. CJ Dropshipping, genelde Çin) yurda giriş + yurtiçi kargo teslimatı,
// olası gecikme risklerini ve satıcının alabileceği önlemleri web taraması ile bulur.

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
    const { productName, platform } = await req.json().catch(() => ({}));
    if (!productName) {
      return new Response(JSON.stringify({ error: "Ürün adı gerekli" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const platformText = platform ? `Satış platformu: ${platform}.` : "Satış platformu belirtilmedi.";

    const systemPrompt = `Sen bir e-ticaret lojistik/kargo uzmanısın. Türkiye'de dropshipping ile satış yapan bir satıcı için "${productName}" ürününün kargo/teslimat süresini tahmin et. ${platformText}

Satıcı büyük ihtimalle ürünü CJ Dropshipping gibi bir tedarikçiden (çoğunlukla Çin) tedarik ediyor ve Türkiye'deki müşteriye kargolatıyor. Web'de gerçek/güncel verileri tara: CJ Dropshipping'in Türkiye'ye ortalama teslimat süresi, gümrükte yaşanan gecikmeler, PTT/kargo firmalarının yurtiçi teslimat süreleri, yoğun dönemlerdeki (11.11, Black Friday, yılbaşı) gecikme riskleri.

ÖNEMLİ - HIZ KURALI: En fazla 2 web araması yap, sonra aramayı bırak ve doğrudan yanıtı yaz. Zaman sınırın var, uzun/tekrarlı araştırmaya girme.

Kurallar:
- supplierLeadDays: tedarikçiden (Çin) yurda/kargo firmasına ulaşana kadar geçen gün aralığı (min/max). Yerli/Türkiye içi tedarikçiyse 0-1 gün gibi çok düşük olmalı.
- domesticDays: yurtiçi kargo firmasının müşteriye teslim süresi gün aralığı (min/max).
- totalDays: toplam gün aralığı (min/max).
- Tam 4 risk faktörü ve tam 3 öneri/ipucu bul.
- Risk faktörleri gerçekten yardımcı olmalı: satıcının önceden müşteriyi bilgilendirebileceği ya da önlem alabileceği şeyler (ör. "gümrükte rastgele ek kontrol/gecikme olabilir", "11.11 gibi kampanya dönemlerinde teslimat süresi 2 katına çıkabilir").
- Önerilerin en az biri satıcının müşteri iletişimiyle ilgili olsun (ör. ürün sayfasında tahmini teslimat süresini net belirtmek).
- Aramada gerçekten gördüğün bir bilgi ise "gozlemlenen", kendi uzmanlığına dayalı tahminse "tahmini" olarak işaretle.
- Yanıtın SADECE tek satırlık, geçerli bir JSON nesnesi olsun. JSON dışında hiçbir metin, açıklama veya markdown ekleme. Metin alanlarında satır sonu (yeni satır) kullanma.
- Format: {"supplierLeadDays": {"min": 0, "max": 0}, "domesticDays": {"min": 0, "max": 0}, "totalDays": {"min": 0, "max": 0}, "riskFactors": [{"risk": "...", "source": "gozlemlenen veya tahmini"}], "tips": ["...", "..."], "summary": "1-2 cümlelik genel özet"}`;

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