// =========================================================
// Ücretli olabilecek özellikler: tek yerden aç / kapa (feature_flags + feature_enabled RPC)
// Kullanım: if (!(await featureEnabled(userId, "multi_channel"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "multi_channel" };
// Kayıtsız anahtar = açık. Hata olursa açık sayılır (satıcı yanlışlıkla kilitlenmesin).
// Anahtar listesi ve açıklamaları: supabase/migrations/20261013_feature_flags.sql (feature_flags tablosu).
// =========================================================
const cache = new Map<string, { v: boolean; t: number }>();
const URL_ = Deno.env.get("SUPABASE_URL") ?? "";
const KEY_ = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export const FEATURE_OFF_MSG = "Bu özellik paketinde kapalı. / This feature is not included in your plan.";

export async function featureEnabled(userId: string | null | undefined, key: string): Promise<boolean> {
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return true;
  const k = userId + ":" + key;
  const c = cache.get(k);
  if (c && Date.now() - c.t < 60_000) return c.v;
  try {
    const r = await fetch(`${URL_}/rest/v1/rpc/feature_enabled`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: KEY_, Authorization: `Bearer ${KEY_}` },
      body: JSON.stringify({ p_user: userId, p_key: key }), signal: AbortSignal.timeout(8000),
    });
    const d = r.ok ? await r.json() : true;
    const v = d !== false;
    cache.set(k, { v, t: Date.now() });
    return v;
  } catch {
    return true;
  }
}

// Oturum anahtarından kullanıcı kimliği (Authorization: Bearer <JWT> ya da gövdedeki userAccessToken)
export async function userIdFromToken(token: string | null | undefined): Promise<string | null> {
  const t = String(token || "").replace(/^Bearer\s+/i, "").trim();
  if (!t || t.split(".").length !== 3) return null;
  try {
    const r = await fetch(`${URL_}/auth/v1/user`, { headers: { Authorization: "Bearer " + t, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id || null;
  } catch { return null; }
}
