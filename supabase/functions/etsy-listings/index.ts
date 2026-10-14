// =========================================================
// Etsy ilanları (geçici iskelet: anahtar teşhisi). Ayrıntılı ilan gönderme bu dosyada genişletilecek.
// Sistem (CRON_SECRET): { action: "ping" } -> Etsy anahtarının hangi biçimde kabul edildiğini durum kodlarıyla döndürür (değer döndürmez)
// =========================================================
import { ETSY_CLIENT_ID } from "../_shared/etsy.ts";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const b = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(b?.cronSecret || "").trim() !== CRON_SECRET.trim()) return json({ error: "unauthorized" }, 401);
  if (b.action === "ping") {
    const raw = Deno.env.get("ETSY_SHARED_SECRET") ?? "";
    const trimmed = raw.trim();
    const variants: Record<string, string> = { keystring: ETSY_CLIENT_ID, "keystring:secret": `${ETSY_CLIENT_ID}:${raw}`, "keystring:secret(trim)": `${ETSY_CLIENT_ID}:${trimmed}` };
    const out: Record<string, unknown> = { secretLength: raw.length, secretHasWhitespace: raw !== trimmed, secretLooksLikeKeyPair: raw.includes(":") };
    for (const [k, v] of Object.entries(variants)) {
      const r = await fetch("https://api.etsy.com/v3/application/openapi-ping", { headers: { "x-api-key": v } });
      out[k] = { status: r.status, body: (await r.text()).slice(0, 160) };
    }
    return json(out);
  }
  return json({ error: "Geçersiz işlem" }, 400);
});
