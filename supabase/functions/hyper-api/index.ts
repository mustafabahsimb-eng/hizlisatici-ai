// HizliSatici AI - Urun icerik uretimi

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { productName, platform, extraInfo } = await req.json();

    if (!productName) {
      return new Response(
        JSON.stringify({ error: "Urun adi gerekli" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const prompt = "Sen bir e-ticaret urun icerik ve SEO uzmanisin. Asagidaki urun icin " + (platform || "genel e-ticaret") + " platformuna uygun, SEO dostu icerik ve anahtar kelime analizi uret.\n\n" +
      "Urun adi: " + productName + "\n" +
      (extraInfo ? "Ek bilgi: " + extraInfo + "\n" : "") +
      "\nAyrica urunun hangi kategoriye ait oldugunu tahmin et. SADECE su kategorilerden birini sec: Elektronik, Cep Telefonu, Giyim, Ayakkabi ve Canta, Aksesuar, Kozmetik ve Kisisel Bakim, Ev ve Yasam, Mobilya, Anne ve Bebek, Spor ve Outdoor, Kitap ve Kirtasiye, Diger.\n" +
      "\nAyrica urunun tahmini paketlenmis kargo agirligini (kg) tahmin et - genel/tipik bir urun icin ortalama agirlik olsun.\n\n" +
      "Su formatta, SADECE JSON dondur (baska hicbir aciklama ekleme):\n" +
      "{\n" +
      '  "title": "SEO uyumlu, dikkat cekici urun basligi (max 80 karakter)",\n' +
      '  "description": "3-4 cumlelik urun aciklamasi",\n' +
      '  "tags": ["etiket1", "etiket2", "etiket3", "etiket4", "etiket5"],\n' +
      '  "category": "yukaridaki listeden bir kategori",\n' +
      '  "estimatedWeightKg": 0.5,\n' +
      '  "keywords": [\n' +
      '    {"term": "anahtar kelime 1", "reason": "kisa gerekce"},\n' +
      '    {"term": "anahtar kelime 2", "reason": "kisa gerekce"},\n' +
      '    {"term": "anahtar kelime 3", "reason": "kisa gerekce"}\n' +
      '  ]\n' +
      "}";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const textContent = data.content?.[0]?.text || "{}";

    const cleaned = textContent.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Icerik uretilemedi, tekrar dene." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});