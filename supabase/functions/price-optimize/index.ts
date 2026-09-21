// Supabase Edge Function: price-optimize
// Bir ürünün mevcut fiyatını, marjını ve rakip fiyat aralığını değerlendirip
// gerekçeli bir "önerilen satış fiyatı" üretir.

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

const INTERNATIONAL_PLATFORMS = ['Etsy', 'Amazon (Global)', 'eBay', 'Facebook Marketplace', 'TikTok Shop', 'Shopify', 'WooCommerce', 'Wix'];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { productId, userAccessToken } = await req.json().catch(() => ({}));
    if (!productId || !userAccessToken) {
      return json({ error: "productId ve oturum bilgisi gerekli" }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });

    const { data: product, error: productErr } = await supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .single();

    if (productErr || !product) return json({ error: "Ürün bulunamadı" }, 404);

    const supplierPrice = product.supplier_price || 0;
    const salePrice = product.sale_price || 0;
    const commissionRate = product.commission_rate || 0;
    const currency = INTERNATIONAL_PLATFORMS.includes(product.platform) ? "USD ($)" : "TRY (₺)";

    let shippingCost = 0;
    if (product.weight_kg) {
      const { data: rates } = await supabase.from("shipping_rates").select("*");
      const matches = (rates || [])
        .filter((r: any) => r.min_weight_kg <= product.weight_kg && r.max_weight_kg >= product.weight_kg)
        .sort((a: any, b: any) => a.price - b.price);
      shippingCost = matches.length > 0 ? matches[0].price : 0;
    }

    const currentMarginPct = salePrice > 0
      ? ((salePrice - supplierPrice - shippingCost - salePrice * (commissionRate / 100)) / salePrice) * 100
      : null;

    const systemPrompt = `Sen bir e-ticaret/dropshipping fiyatlandırma uzmanısın. Aşağıdaki ürün için gerekçeli bir "önerilen satış fiyatı" belirle.

Ürün: ${product.name}
Platform: ${product.platform || "belirtilmemiş"}
Kategori: ${product.category || "belirtilmemiş"}
Para birimi: ${currency}
Tedarikçi maliyeti: ${supplierPrice}
Tahmini kargo maliyeti: ${shippingCost}
Platform komisyon oranı: %${commissionRate}
Mevcut satış fiyatı: ${salePrice > 0 ? salePrice : "girilmemiş"}
${currentMarginPct !== null ? `Mevcut net kâr marjı: %${currentMarginPct.toFixed(1)}` : ""}

ÖNEMLİ - HIZ KURALI: En fazla 2 web araması yap (rakip/piyasa fiyatlarını görmek için), sonra doğrudan yanıtı yaz.

Görevin:
1. Bu ürün için rakip/piyasa fiyat aralığını web'den kısaca araştır.
2. Kârlılık (maliyet+kargo+komisyon sonrası en az %25-30 net marj hedefle) ile rekabetçilik arasında dengeli, gerekçeli bir "önerilen satış fiyatı" belirle (sadece sayı, ${currency} cinsinden).
3. Bu fiyatın neden uygun olduğunu 1-2 cümleyle Türkçe açıkla.

Yanıtın SADECE tek satırlık, geçerli bir JSON nesnesi olsun. JSON dışında hiçbir metin, açıklama veya markdown ekleme. Metin alanında satır sonu kullanma.
Format: {"suggestedPrice": 0, "competitorRangeNote": "...", "reasoning": "..."}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: `Ürün: ${product.name}` }],
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

    const suggestedPrice = Number(parsed.suggestedPrice) || 0;
    const projectedMarginPct = suggestedPrice > 0
      ? ((suggestedPrice - supplierPrice - shippingCost - suggestedPrice * (commissionRate / 100)) / suggestedPrice) * 100
      : null;

    const result = {
      suggestedPrice,
      currentPrice: salePrice || null,
      currentMarginPct,
      projectedMarginPct,
      competitorRangeNote: parsed.competitorRangeNote || "",
      reasoning: parsed.reasoning || "",
    };

    await supabase
      .from("products")
      .update({
        suggested_price: suggestedPrice,
        suggested_price_reasoning: JSON.stringify(result),
        suggested_price_updated_at: new Date().toISOString(),
      })
      .eq("id", productId);

    return json(result);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});