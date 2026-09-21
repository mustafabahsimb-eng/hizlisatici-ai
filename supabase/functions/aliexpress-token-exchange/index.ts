// Supabase Edge Function: aliexpress-token-exchange
// Tek seferlik kurulum fonksiyonu: AliExpress OAuth "authorize" adimindan
// donen "code" degerini access_token/refresh_token'a cevirir ve
// platform_tokens tablosuna (site sahibinin demo hesabi) kaydeder.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_KEY = Deno.env.get("ALIEXPRESS_APP_KEY") || "";
const APP_SECRET = Deno.env.get("ALIEXPRESS_APP_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN_URL = "https://api-sg.aliexpress.com/rest/auth/token/create";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function signParams(secret: string, pathname: string, params: Record<string, string>): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const joined = sortedKeys.map((k) => k + params[k]).join("");
  const base = pathname + joined;
  return await hmacSha256Hex(secret, base);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

    if (url.searchParams.get("debug") === "1") {
      const mask = (s: string) =>
        s.length === 0
          ? "(BOS - env var okunamiyor!)"
          : `uzunluk=${s.length}, baslangic="${s.slice(0, 2)}", bitis="${s.slice(-2)}", basinda/sonunda bosluk var mi=${s !== s.trim()}`;
      return new Response(
        JSON.stringify({
          app_key: mask(APP_KEY),
          app_secret: mask(APP_SECRET),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return new Response(JSON.stringify({ error: "code parametresi gerekli (?code=...)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const pathname = "/auth/token/create";

    const params: Record<string, string> = {
      app_key: APP_KEY,
      code,
      sign_method: "sha256",
      timestamp: Date.now().toString(),
    };

    const sign = await signParams(APP_SECRET, pathname, params);

    const body = new URLSearchParams({ ...params, sign });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await res.json();

    if (!data.access_token) {
      return new Response(JSON.stringify({ error: "Token alinamadi", raw: data }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const expiresInSec = Number(data.expires_in) || 7 * 24 * 60 * 60;
    const expiresAtIso = new Date(Date.now() + expiresInSec * 1000).toISOString();

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error: dbError } = await supabase.from("platform_tokens").upsert(
      {
        platform: "aliexpress",
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAtIso,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "platform" }
    );

    if (dbError) {
      return new Response(JSON.stringify({ error: "DB kayit hatasi: " + dbError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});