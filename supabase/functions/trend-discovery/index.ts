// Supabase Edge Function: trend-discovery
// Claude'a gerçek zamanlı web araması yaptırıp Türkiye e-ticaretinde
// (ve istenirse uluslararası) şu an trend olan ürün fikirlerini döndürür.
// Her ürün fikri için Pexels'ten gerçek bir stok fotoğraf çeker.
// language: 'tr' (varsayılan) | 'en' -> ürün adı ve gerekçe bu dilde yazılır.
// category ve demandLevel HER ZAMAN sabit Türkçe değerlerle döner (sayfa bunları kendi diline çevirir).

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const PEXELS_API_KEY = Deno.env.get("PEXELS_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MSG = {
  tr: {
    apiError: "Anthropic API hatası",
    badFormat: "Model beklenen formatta yanıt vermedi",
    parseError: "JSON ayrıştırma hatası",
    empty: "AI bu taramada ürün fikri üretemedi, lütfen tekrar dene",
  },
  en: {
    apiError: "Anthropic API error",
    badFormat: "The model did not respond in the expected format",
    parseError: "JSON parse error",
    empty: "AI could not generate product ideas this time, please try again",
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const hsHandler = (async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let lang: "tr" | "en" = "tr";

  try {
    const body = await req.json().catch(() => ({}));
    const scope = body?.scope || "turkiye";
    lang = body?.language === "en" ? "en" : "tr";
    const isGlobal = scope === "global";
    const m = MSG[lang];

    const outLangName = lang === "en" ? "İngilizce (English)" : "Türkçe";

    const systemPrompt = `Sen bir e-ticaret trend analistisin. Web araması kullanarak ${
      isGlobal ? "hem Türkiye hem de uluslararası (AliExpress, Amazon, TikTok Shop, Etsy vb.)" : "Türkiye (Trendyol, Hepsiburada, N11 vb.)"
    } pazaryerlerinde ŞU AN trend olan / talebi hızla artan somut ürün fikirlerini buluyorsun.

Web aramalarını kullanarak güncel haberler, sosyal medya/viral ürün haberleri, mevsimsel talep sinyalleri ve e-ticaret sektör analizlerini tara. Kesin, tek bir haber kaynağıyla %100 doğrulanmış olmasa bile, aramalarında gördüğün sinyallere (mevsim, sosyal medya trendleri, sektör haberleri, genel talep kalıpları) dayanarak profesyonel bir tahmin yap. Tamamen alakasız veya rastgele ürün uydurma ama arama sonuçlarını yorumlayarak makul ürün fikirleri üretmekten çekinme.

Her ürün için ayrıca kısa, İngilizce bir görsel arama terimi üret (imageSearchQuery) - bu terim bir stok fotoğraf sitesinde bu ürüne benzer gerçek bir fotoğraf bulmak için kullanılacak. Örnek: "wireless earbuds", "robot vacuum cleaner", "cellulite cream bottle", "oversized t-shirt".

ÇOK ÖNEMLİ KURAL: Cevabında TAM OLARAK 25 (yirmi beş) ürün fikri olmalı. "En az" değil, TAM 25 - daha az verme, "yeterince bulamadım" diye erken durma. Farklı kategori ve alt-niş kombinasyonlarıyla (örn. aynı elektronik kategorisinde birden fazla farklı ürün tipi) listeyi 25'e tamamla. Emin olmadığın fikirler için demandLevel'i "Yükselişte" olarak işaretle ve reason alanında bunun bir tahmin olduğunu belirt. Aynı ürünü tekrar etme.

DİL KURALI: "productIdea" ve "reason" alanlarını ${outLangName} yaz. "category" ve "demandLevel" alanları ise dil ne olursa olsun AŞAĞIDAKİ SABİT TÜRKÇE DEĞERLERDEN biri olmalı (çevirme, aynen yaz). "imageSearchQuery" her zaman İngilizce.

Cevabını SADECE aşağıdaki JSON formatında ver, başka hiçbir metin ekleme:

{
  "trends": [
    {
      "productIdea": "kısa ürün adı (${outLangName})",
      "category": "Elektronik | Giyim | Ev & Yaşam | Kozmetik & Kişisel Bakım | Anne & Bebek | Spor & Outdoor | Aksesuar | Diğer kategorilerden biri",
      "reason": "neden trend olduğuna dair 1-2 cümlelik somut gerekçe, kaynağa dayalı (${outLangName})",
      "suggestedPlatforms": ["Trendyol", "Hepsiburada"],
      "demandLevel": "Yüksek | Orta | Yükselişte",
      "imageSearchQuery": "kısa İngilizce görsel arama terimi"
    }
  ]
}

TAM OLARAK 25 ürün fikri ver.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 10000,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Bugünün tarihine göre ${
              isGlobal ? "Türkiye ve uluslararası" : "Türkiye"
            } e-ticaret pazarında trend olan ürünleri araştır ve JSON formatında listele. TAM OLARAK 25 ürün fikri ver, daha az verme. productIdea ve reason alanlarını ${outLangName} yaz.`,
          },
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 10,
          },
        ],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return jsonResponse({ error: data.error.message || m.apiError }, 500);
    }

    // content dizisinde birden fazla "text" bloğu olabilir (arama adımları arasında);
    // hepsini birleştirip içinden JSON'u ayıklıyoruz.
    const textParts = (data.content || [])
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");

    const jsonMatch = textParts.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return jsonResponse({ error: m.badFormat, raw: textParts }, 500);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (_e) {
      return jsonResponse({ error: m.parseError, raw: textParts }, 500);
    }

    if (!parsed.trends || parsed.trends.length === 0) {
      return jsonResponse({ error: m.empty, raw: textParts }, 500);
    }

    // Her ürün fikri için Pexels'ten gerçek bir fotoğraf ara ve imageUrl olarak ekle.
    // Görsel bulunamazsa veya Pexels anahtarı yoksa sessizce geç (arayüzde ikon fallback var).
    if (PEXELS_API_KEY) {
      await Promise.all(
        parsed.trends.map(async (t: any) => {
          try {
            const query = t.imageSearchQuery || t.productIdea || "";
            if (!query) return;
            const pexelsRes = await fetch(
              `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`,
              { headers: { Authorization: PEXELS_API_KEY } }
            );
            if (!pexelsRes.ok) return;
            const pexelsData = await pexelsRes.json();
            const photo = pexelsData?.photos?.[0];
            if (photo?.src?.medium) {
              t.imageUrl = photo.src.medium;
            }
          } catch (_e) {
            // görsel bulunamazsa sessizce geç
          }
        })
      );
    }

    parsed.language = lang;
    return jsonResponse(parsed);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
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
    return jsonResponse({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
  }
  return hsHandler(req);
});