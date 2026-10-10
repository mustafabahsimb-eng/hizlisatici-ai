// =========================================================
// HızlıSatıcı AI - image-proxy (Sosyal medyada paylaş)
// Tedarikçi sitelerindeki ürün resimlerini tarayıcıya güvenli şekilde getirir.
// (Tarayıcı başka sitelerin resimlerini doğrudan dosya olarak alamıyor; paylaşım için bu gerekli.)
// Sadece giriş yapmış kullanıcılar kullanabilir. Sadece resim dosyası döner.
// POST { url }  ->  resim dosyasının kendisi (image/jpeg, image/png, image/webp ...)
// =========================================================
const MAX_BYTES = 10_000_000; // 10 MB

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

// Sadece herkese açık web adresleri (iç ağ / IP adresi / Supabase yok)
function isSafeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && !["80", "443", "8080"].includes(u.port)) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  if (h.startsWith("[") || h.includes(":")) return null;
  if (h.endsWith("supabase.co") || h.endsWith("supabase.in")) return null;
  return u;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await hsIsLoggedIn(req))) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);

  const body = await req.json().catch(() => ({}));
  const u = isSafeUrl(String(body?.url || "").trim());
  if (!u) return json({ error: "Geçersiz resim adresi. / Invalid image address." }, 400);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
        "Referer": u.origin + "/",
      },
    });
    if (!isSafeUrl(r.url || u.toString())) return json({ error: "Yönlendirme engellendi. / Redirect blocked." }, 400);
    if (!r.ok) { await r.body?.cancel(); return json({ error: "Resim alınamadı (" + r.status + "). / Could not get the image." }, 422); }
    const type = (r.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    if (!type.startsWith("image/") || type.includes("svg")) {
      await r.body?.cancel();
      return json({ error: "Bu adres bir resim değil. / This address is not an image." }, 415);
    }
    const len = Number(r.headers.get("content-length") || 0);
    if (len > MAX_BYTES) { await r.body?.cancel(); return json({ error: "Resim çok büyük. / Image is too large." }, 413); }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) return json({ error: "Resim çok büyük. / Image is too large." }, 413);
    return new Response(buf, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": type, "Cache-Control": "private, max-age=3600" },
    });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    return json({ error: msg.includes("abort") ? "Site çok geç cevap verdi. / The site took too long." : "Resim alınamadı. / Could not get the image." }, 502);
  } finally {
    clearTimeout(timer);
  }
});