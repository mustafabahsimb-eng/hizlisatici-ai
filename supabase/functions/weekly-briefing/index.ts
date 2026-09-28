// Supabase Edge Function: weekly-briefing
// Kullanıcının tüm ürünlerine bakıp en kârlı/en düşük marjlı ürünleri hesaplar
// ve ürün kategorilerine göre kısa bir "trend özeti" üretir.
// language: 'tr' (varsayılan) | 'en' -> özet ve hata mesajları bu dilde döner.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MSG = {
  tr: {
    needSession: "Oturum bilgisi gerekli",
    productsFail: "Ürünler alınamadı: ",
    noProducts: "Henüz ürün eklenmemiş",
    noSummary: "Trend özeti için yeterli ürün bilgisi bulunamadı.",
  },
  en: {
    needSession: "Session information is required",
    productsFail: "Could not load products: ",
    noProducts: "No products added yet",
    noSummary: "Not enough product information to generate a trend summary.",
  },
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

const INTERNATIONAL_PLATFORMS = ['Etsy', 'Amazon (Global)', 'Amazon Global', 'eBay', 'Facebook Marketplace', 'TikTok Shop', 'Shopify', 'WooCommerce', 'Wix'];
function currencySymbolFor(platform: string) {
  return INTERNATIONAL_PLATFORMS.includes(platform) ? '$' : '₺';
}

const hsHandler = (async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let lang: "tr" | "en" = "tr";

  try {
    const body = await req.json().catch(() => ({}));
    const userAccessToken = body?.userAccessToken;
    lang = body?.language === "en" ? "en" : "tr";
    const m = MSG[lang];

    if (!userAccessToken) {
      return json({ error: m.needSession }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });

    const { data: allProducts, error: productsErr } = await supabase
      .from("products")
      .select("*");

    if (productsErr) return json({ error: m.productsFail + productsErr.message }, 500);

    // Silinmiş veya başka ürünle birleştirilmiş ürünleri hesaba katma
    const products = (allProducts || []).filter((p: any) => !p.deleted_at && !p.merged_into);

    if (products.length === 0) {
      return json({ error: m.noProducts }, 400);
    }

    const { data: rates } = await supabase.from("shipping_rates").select("*");

    function getShippingCost(weightKg: number | null) {
      if (!weightKg || !rates || rates.length === 0) return 0;
      const matches = rates
        .filter((r: any) => r.min_weight_kg <= weightKg && r.max_weight_kg >= weightKg)
        .sort((a: any, b: any) => a.price - b.price);
      return matches.length > 0 ? matches[0].price : 0;
    }

    const computed = products
      .map((p: any) => {
        const supplierPrice = p.supplier_price || 0;
        const salePrice = p.sale_price || 0;
        const commissionRate = p.commission_rate || 0;
        const symbol = currencySymbolFor(p.platform);
        if (salePrice <= 0) return null;
        const shippingCost = getShippingCost(p.weight_kg);
        const netProfit = salePrice - supplierPrice - shippingCost - salePrice * (commissionRate / 100);
        const marginPct = (netProfit / salePrice) * 100;
        return { id: p.id, name: p.name, platform: p.platform, category: p.category, netProfit, marginPct, symbol };
      })
      .filter((x: any) => x !== null);

    const topProducts = [...computed].sort((a: any, b: any) => b.netProfit - a.netProfit).slice(0, 3);
    const lowProducts = [...computed].sort((a: any, b: any) => a.marginPct - b.marginPct).slice(0, 3);

    const categories = Array.from(new Set(products.map((p: any) => p.category).filter(Boolean))) as string[];
    const productNames = Array.from(new Set(products.map((p: any) => p.name).filter(Boolean))) as string[];

    // Kategori bilgisi boşsa ürün isimlerine düşüyoruz, o da yoksa özet üretmiyoruz
    const topics = categories.length > 0 ? categories : productNames.slice(0, 8);
    const topicsAreCategories = categories.length > 0;

    let trendSummary = m.noSummary;

    if (topics.length > 0) {
      const topicLabel = topicsAreCategories ? "ürün kategorileri" : "ürünleri (kategori bilgisi girilmediği için ürün isimlerine bakılıyor)";
      const outLang = lang === "en" ? "İngilizce (English)" : "Türkçe";
      const systemPrompt = `Sen bir e-ticaret/dropshipping trend analistisin. Bir satıcının ${topicLabel} şunlar: ${topics.join(", ")}.

ÖNEMLİ - HIZ KURALI: En fazla 2 web araması yap, sonra doğrudan yanıtı yaz.

Görevin: Bunlarla ilgili bu haftaki/bu dönemki genel talep trendini (yükselen/düşen ürün tipi, mevsimsel fırsat, dikkat edilmesi gereken bir gelişme varsa) 2-3 cümlelik ${outLang}, somut ve eyleme dönük bir özet olarak yaz.

DİL KURALI: "summary" alanını MUTLAKA ${outLang} yaz.

Yanıtın SADECE tek satırlık, geçerli bir JSON nesnesi olsun. JSON dışında hiçbir metin, açıklama veya markdown ekleme. Metin alanında satır sonu kullanma.
Format: {"summary": "..."}`;

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
          messages: [{ role: "user", content: `${topicsAreCategories ? "Kategoriler" : "Ürünler"}: ${topics.join(", ")}. Özeti ${outLang} yaz.` }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        }),
      });

      const aiData = await response.json();
      if (response.ok) {
        const textBlocks = (aiData.content || [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text);
        const fullText = textBlocks.join("\n");
        const parsed = extractJson(fullText);
        if (parsed && parsed.summary) {
          trendSummary = parsed.summary;
        }
      }
    }

    return json({
      topProducts,
      lowProducts,
      trendSummary,
      categoriesAnalyzed: topics,
      language: lang,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});


// =========================================================
// GÜVENLİK: sadece giriş yapmış kullanıcılar bu fonksiyonu çalıştırabilir
// (sayfalar app.js sayesinde kullanıcının oturum anahtarını gönderir)
// =========================================================
async function hsIsLoggedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.split(".").length !== 3) return false;
  try {
    const r = await fetch((Deno.env.get("SUPABASE_URL") ?? "") + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch (_e) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "OPTIONS" && !(await hsIsLoggedIn(req))) {
    return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
  }
  return hsHandler(req);
});