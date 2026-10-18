// =========================================================
// Trendruum bağlantı doğrulama (store-connect çağırır; giriş yapmış kullanıcı gerekir)
// Girdi: { sellerId, apiKey (= Client ID), apiSecret (= Client Secret) }
// Çıktı: { connected: true } | { connected: false, error } | { connected: false, pending: true, error } (entegrasyon kapalı: TRENDRUUM_ENABLED yok)
// =========================================================
import { verifyTrendruum } from "../_shared/trendruum.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// GÜVENLİK: sadece giriş yapmış kullanıcılar (store-connect kullanıcının oturum anahtarını iletir)
async function isLoggedIn(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await isLoggedIn(req))) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
  try {
    const { sellerId, apiKey, apiSecret } = await req.json();
    if (!apiKey || !apiSecret) return json({ error: "Client ID ve Client Secret gerekli." }, 400);
    return json(await verifyTrendruum({ creds: { clientId: String(apiKey).trim(), clientSecret: String(apiSecret).trim(), sellerId: sellerId || null } }));
  } catch (e) {
    return json({ connected: false, error: String((e as Error).message).slice(0, 200) }, 500);
  }
});
