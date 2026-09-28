// =========================================================
// HızlıSatıcı AI - image-text-detect (Görsel Stüdyosu: resimdeki yazıları bul)
// Görseldeki yazıları, konumlarını (0-1 oranında), renklerini ve kalınlıklarını döndürür.
// Sadece giriş yapmış kullanıcılar kullanabilir.
// POST { imageBase64: "data:image/jpeg;base64,...", language }
// =========================================================
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MAX_BASE64_LEN = 6_000_000; // ~4.5 MB

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

function extractJson(text: string): any {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function clamp01(n: unknown) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await hsIsLoggedIn(req))) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const en = String(body?.language || "").toLowerCase().startsWith("en");
    const dataUrl = String(body?.imageBase64 || "");
    const m = dataUrl.match(/^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/);
    if (!m) return json({ error: en ? "Image is required." : "Görsel gerekli." }, 400);
    if (m[3].length > MAX_BASE64_LEN) return json({ error: en ? "Image is too large." : "Görsel çok büyük." }, 413);

    const system = `You are a precise OCR and layout engine for product images.
Find every piece of visible text in the image (words, prices, labels, slogans). Group words that belong to the same line into one block.
For each block return:
- text: the exact text as written (keep original language and capitalization)
- x, y, w, h: the tight bounding box of the text as FRACTIONS of the image width/height (0 to 1). x,y = top-left corner.
- color: the text color as hex (e.g. "#ffffff")
- bold: true if the font looks bold/heavy
Ignore text that is part of tiny logos smaller than 1% of the image height.
Answer ONLY with JSON: {"blocks":[{"text":"...","x":0.1,"y":0.1,"w":0.3,"h":0.05,"color":"#000000","bold":true}]}
If there is no text, answer {"blocks":[]}.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2500,
        system,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: m[1], data: m[3] } },
            { type: "text", text: "Find all text blocks in this image and return the JSON." },
          ],
        }],
      }),
    });
    const d = await r.json();
    if (!r.ok) {
      console.error(d);
      return json({ error: (en ? "AI error: " : "AI hatası: ") + String(d?.error?.message || r.status).slice(0, 200) }, 502);
    }
    const text = (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const parsed = extractJson(text);
    const blocks = (Array.isArray(parsed?.blocks) ? parsed.blocks : [])
      .map((b: any) => ({
        text: String(b?.text || "").slice(0, 300),
        x: clamp01(b?.x), y: clamp01(b?.y), w: clamp01(b?.w), h: clamp01(b?.h),
        color: /^#[0-9a-f]{6}$/i.test(String(b?.color || "")) ? String(b.color) : "#000000",
        bold: b?.bold === true,
      }))
      .filter((b: any) => b.text.trim() && b.w > 0.005 && b.h > 0.005)
      .slice(0, 40);

    return json({ blocks });
  } catch (err) {
    console.error(err);
    return json({ error: "Sunucu hatası / Server error" }, 500);
  }
});