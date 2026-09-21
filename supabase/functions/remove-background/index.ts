// Supabase Edge Function: remove-background
// Ürün görselinin arka planını remove.bg API'si ile temizler.
// Girdi: { imageBase64: "data:image/...;base64,...." } veya { imageUrl: "https://..." }
// Çıktı: { imageBase64: "data:image/png;base64,...." } (arka planı temizlenmiş PNG)

const REMOVEBG_API_KEY = Deno.env.get("REMOVEBG_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!REMOVEBG_API_KEY) {
      return new Response(
        JSON.stringify({ error: "REMOVEBG_API_KEY tanımlı değil. Supabase Secrets'a eklemen gerekiyor." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { imageBase64, imageUrl } = await req.json().catch(() => ({}));
    if (!imageBase64 && !imageUrl) {
      return new Response(JSON.stringify({ error: "Görsel gerekli (imageBase64 veya imageUrl)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const form = new FormData();
    form.append("size", "auto");

    if (imageBase64) {
      // "data:image/png;base64,XXXX" formatındaki ön eki temizle
      const commaIdx = imageBase64.indexOf(",");
      const rawBase64 = commaIdx !== -1 ? imageBase64.slice(commaIdx + 1) : imageBase64;
      const binary = Uint8Array.from(atob(rawBase64), (c) => c.charCodeAt(0));
      form.append("image_file", new Blob([binary]), "image.png");
    } else {
      form.append("image_url", imageUrl);
    }

    const rbRes = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": REMOVEBG_API_KEY },
      body: form,
    });

    if (!rbRes.ok) {
      const errText = await rbRes.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: "remove.bg hatası (" + rbRes.status + "): " + errText.slice(0, 300) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resultBuffer = await rbRes.arrayBuffer();
    const resultBytes = new Uint8Array(resultBuffer);
    let binaryStr = "";
    for (let i = 0; i < resultBytes.length; i++) {
      binaryStr += String.fromCharCode(resultBytes[i]);
    }
    const resultBase64 = "data:image/png;base64," + btoa(binaryStr);

    return new Response(JSON.stringify({ imageBase64: resultBase64 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});