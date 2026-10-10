const REGIONS: Record<string, string> = {
  eu: "https://sandbox.sellingpartnerapi-eu.amazon.com",
  na: "https://sandbox.sellingpartnerapi-na.amazon.com",
  fe: "https://sandbox.sellingpartnerapi-fe.amazon.com",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status: s,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

const hsHandler = (async () => {
  const clientId = Deno.env.get("AMAZON_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("AMAZON_LWA_CLIENT_SECRET");
  const refreshToken = Deno.env.get("AMAZON_SANDBOX_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    return json({ ok: false, step: "secrets", error: "Amazon anahtarlarından biri eksik" }, 500);
  }

  // 1) Amazon'dan erişim izni (access token) al
  const tokRes = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const tok = await tokRes.json();
  if (!tokRes.ok || !tok.access_token) {
    return json({ ok: false, step: "lwa_token", error: tok.error_description || tok.error || tok }, 400);
  }

  // 2) Sandbox'a test isteği: satıcının pazaryerleri
  const results: Record<string, unknown> = {};
  for (const [region, base] of Object.entries(REGIONS)) {
    try {
      const r = await fetch(`${base}/sellers/v1/marketplaceParticipations`, {
        headers: { "x-amz-access-token": tok.access_token, "Content-Type": "application/json" },
      });
      const body = await r.json().catch(() => ({}));
      results[region] = {
        status: r.status,
        marketplaces: Array.isArray(body?.payload)
          ? body.payload.map((p: any) => `${p?.marketplace?.name ?? "?"} (${p?.marketplace?.countryCode ?? "?"})`)
          : undefined,
        error: body?.errors?.[0]?.message,
      };
      if (r.ok) break; // bir bölge çalıştıysa yeter
    } catch (e) {
      results[region] = { error: String(e) };
    }
  }

  const anyOk = Object.values(results).some((x: any) => x?.status === 200);
  return json({ ok: anyOk, step: "sandbox_call", results });
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
  if (!(await hsIsLoggedIn(req))) {
    return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
  }
  return hsHandler();
});
