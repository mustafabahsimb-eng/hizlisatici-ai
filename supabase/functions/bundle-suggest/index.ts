// Supabase Edge Function: bundle-suggest
// Satıcının ürünlerine bakıp birlikte satılabilecek paket (set) önerileri üretir.

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
  const text = fullText.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(text); } catch { /* devam */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userAccessToken, language } = await req.json().catch(() => ({}));
    if (!userAccessToken) return json({ error: "Oturum bilgisi gerekli" }, 400);
    const lang = language === "en" ? "en" : "tr";

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser(userAccessToken);
    if (userErr || !userData?.user) return json({ error: "Oturum geçersiz" }, 401);

    const { data: rows, error } = await supabase
      .from("products")
      .select("*")
      .eq("user_id", userData.user.id)
      .is("deleted_at", null)
      .is("merged_into", null)
      .order("created_at", { ascending: false })
      .limit(80);
    if (error) throw error;

    const products = (rows || []).filter((p: any) => !p.is_bundle);
    if (products.length < 2) {
      return json({ suggestions: [], message: lang === "en" ? "Add at least 2 products first." : "Önce en az 2 ürün ekle." });
    }

    // Ürünleri numarayla veriyoruz; AI kimlik uydurmasın
    const list = products.map((p: any, i: number) => {
      const name = (p.generated_title || p.name || "").slice(0, 90);
      const price = Number(p.sale_price) > 0 ? ` | ${p.sale_price} ${p.cost_currency || "TRY"}` : "";
      const catVal = p.category || p.category_key || p.product_type || "";
      const cat = catVal ? ` | ${catVal}` : "";
      return `${i + 1}. ${name}${price}${cat}`;
    }).join("\n");

    const langRule = lang === "en"
      ? "Write the bundle names and reasons in English."
      : "Paket adlarını ve gerekçeleri Türkçe yaz.";

    const systemPrompt = `Sen bir e-ticaret satış uzmanısın. Satıcının ürün listesine bakıp birlikte satıldığında daha çok satacak PAKET (set) önerileri hazırla.

Kurallar:
- En fazla 4 öneri ver. Her pakette 2-4 ürün olsun.
- Sadece listedeki ürünleri kullan, numaralarıyla belirt.
- Mantıklı eşleştir: birbirini tamamlayan ürünler (ör. iç mekan + dış mekan kamera, ürün + aksesuarı, farklı boy/renk ikilisi, hediye seti).
- Aynı ürünü iki kez kullanma (aynı paket içinde).
- Her öneri için kısa, satışa uygun bir paket adı ve 1 cümlelik gerekçe yaz.
- Önerilen indirim oranı 5, 10 veya 15 olsun.
- ${langRule}

Yanıtın SADECE geçerli bir JSON olsun, başka hiçbir metin ekleme:
{"suggestions":[{"name":"...","items":[1,2],"reason":"...","discount":10}]}`;

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
        messages: [{ role: "user", content: "Ürün listesi:\n" + list }],
      }),
    });

    const aiData = await response.json();
    if (!response.ok) {
      return json({ error: "AI hatası: " + JSON.stringify(aiData).slice(0, 300) }, 500);
    }

    const fullText = (aiData.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    const parsed = extractJson(fullText);
    if (!parsed || !Array.isArray(parsed.suggestions)) {
      return json({ error: "AI yanıtı okunamadı", raw: fullText.slice(0, 500) }, 500);
    }

    const suggestions = parsed.suggestions
      .map((s: any) => {
        const nums: number[] = Array.from(new Set((Array.isArray(s.items) ? s.items : [])
          .map((n: any) => parseInt(n, 10))
          .filter((n: number) => n >= 1 && n <= products.length)));
        const picked = nums.map((n) => products[n - 1]);
        const discount = [5, 10, 15].includes(Number(s.discount)) ? Number(s.discount) : 10;
        return {
          name: String(s.name || "").slice(0, 120),
          reason: String(s.reason || "").slice(0, 300),
          discount,
          product_ids: picked.map((p: any) => p.id),
          product_names: picked.map((p: any) => p.generated_title || p.name || ""),
        };
      })
      .filter((s: any) => s.product_ids.length >= 2)
      .slice(0, 4);

    return json({ suggestions });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});