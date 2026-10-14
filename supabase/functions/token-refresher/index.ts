// =========================================================
// Seltigo - token-refresher (OAuth anahtarlarını süresi dolmadan yeniler)
// Zamanlanmış görevle 3 saatte bir çalışır:
//   - AliExpress: sitenin arama hesabı (platform_tokens) + satıcı hesapları
//     (supplier_connections). Anahtar 24 saat, yenileme anahtarı 48 saat geçerli:
//     12 saatten az kaldıysa yenilenir.
//   - Instagram (Instagram girişi): 60 günlük anahtar, 10 günden az kaldıysa yenilenir.
//   - Meta (Facebook/WhatsApp): kullanıcı anahtarı sunucuda yenilenemez; bitiş tarihi
//     öğrenilir, 7 günden az kaldıysa satıcıya "yeniden bağla" uyarısı için işaretlenir.
//   - Etsy / eBay / Wix (store_connections): yenileme anahtarı canlı tutulur.
// Yenilenemeyen bağlantı durum alanına yazılır; panel bunu Türkçe uyarı olarak gösterir.
// Güvenlik: CRON_SECRET (gövdede cronSecret).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

import { ETSY_CLIENT_ID, etsyApiKey } from "../_shared/etsy.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const AE_APP_KEY = Deno.env.get("ALIEXPRESS_APP_KEY") ?? "";
const AE_APP_SECRET = Deno.env.get("ALIEXPRESS_APP_SECRET") ?? "";
const FB_APP_ID = "1650835089949068";
const FB_APP_SECRET = Deno.env.get("FACEBOOK_CLIENT_SECRET") ?? "";
const WIX_CLIENT_ID = "b6cd9721-a09f-4257-b18a-c6d3654aa038";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let FORCE = false; // test için: süresine bakmadan yenile (sadece gizli anahtarla)
const realMsLeft = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() - Date.now() : -Infinity);
const msLeft = (iso: string | null | undefined) => (FORCE ? 0.5 : (iso ? new Date(iso).getTime() - Date.now() : -Infinity));
const short = (v: unknown) => String(v ?? "").slice(0, 300);

// ---------------------------------------------------------
// AliExpress
// ---------------------------------------------------------
async function aeSign(pathname: string, params: Record<string, string>): Promise<string> {
  const base = pathname + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(AE_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// AliExpress süreleri: saniye (expires_in) ya da milisaniye zaman damgası (expire_time)
function aeIso(expiresIn: unknown, expireTime: unknown, fallbackSec: number): string {
  const t = Number(expireTime);
  if (Number.isFinite(t) && t > 1e12) return new Date(t).toISOString();
  const s = Number(expiresIn);
  return new Date(Date.now() + (Number.isFinite(s) && s > 0 ? s : fallbackSec) * 1000).toISOString();
}

async function aeRefresh(refreshToken: string) {
  const params: Record<string, string> = {
    app_key: AE_APP_KEY, refresh_token: refreshToken, sign_method: "sha256", timestamp: Date.now().toString(),
  };
  const sign = await aeSign("/auth/token/refresh", params);
  const r = await fetch("https://api-sg.aliexpress.com/rest/auth/token/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, sign }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error(short(d.message || d.error_msg || d.code || "AliExpress yenileme reddetti"));
  return {
    access_token: String(d.access_token),
    refresh_token: String(d.refresh_token || refreshToken),
    expires_at: aeIso(d.expires_in, d.expire_time, 86400),
    refresh_expires_at: aeIso(d.refresh_expires_in, d.refresh_token_valid_time, 2 * 86400),
  };
}

async function refreshPlatformAliExpress(out: Record<string, string>) {
  const { data: p } = await db.from("platform_tokens").select("*").eq("platform", "aliexpress").maybeSingle();
  if (!p) return;
  if (msLeft(p.expires_at) > 12 * HOUR && p.status === "ok") { out["site:aliexpress"] = "gerek yok"; return; }
  if (!p.refresh_token) {
    await db.from("platform_tokens").update({ status: "error", last_error: "Yenileme anahtarı yok" }).eq("platform", "aliexpress");
    out["site:aliexpress"] = "yenileme anahtarı yok";
    return;
  }
  try {
    const t = await aeRefresh(p.refresh_token);
    // Yenileme anahtarının da sonu yaklaşıyorsa (test uygulamasında uzamıyor) yeniden izin gerekir
    const ending = realMsLeft(t.refresh_expires_at) <= DAY;
    await db.from("platform_tokens").update({
      access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at,
      refresh_expires_at: t.refresh_expires_at,
      status: ending ? "expiring" : "ok",
      last_error: ending ? "Sitenin AliExpress izni " + t.refresh_expires_at.slice(0, 16).replace("T", " ") + " (UTC) tarihinde bitiyor; Hesaplarım'dan AliExpress'i yeniden bağla." : null,
      refreshed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("platform", "aliexpress");
    out["site:aliexpress"] = "yenilendi" + (ending ? " (izin yakında bitiyor)" : "");
  } catch (e) {
    // Süresi dolmadıysa bir sonraki çalışmada tekrar dener; dolduysa hata olarak işaretler
    const expired = msLeft(p.expires_at) <= 0;
    await db.from("platform_tokens").update({
      status: expired ? "error" : "ok", last_error: short((e as Error).message),
    }).eq("platform", "aliexpress");
    out["site:aliexpress"] = "hata: " + short((e as Error).message);
  }
}

async function refreshSupplierAliExpress(out: Record<string, string>) {
  const { data: conns } = await db.from("supplier_connections").select("id, user_id, status").eq("supplier", "aliexpress").eq("status", "connected");
  for (const c of conns || []) {
    const { data: cred } = await db.rpc("supplier_connection_get_credentials", { p_connection_id: c.id });
    if (!cred?.access_token) continue;
    if (msLeft(cred.expires_at) > 12 * HOUR) { out["aliexpress:" + c.id] = "gerek yok"; continue; }
    try {
      if (!cred.refresh_token) throw new Error("Yenileme anahtarı yok");
      const t = await aeRefresh(cred.refresh_token);
      await db.rpc("supplier_connection_set_credentials", { p_connection_id: c.id, p_credentials: { ...cred, ...t } });
      const ending = realMsLeft(t.refresh_expires_at) <= DAY;
      await db.from("supplier_connections").update({
        token_expires_at: t.expires_at, refresh_expires_at: t.refresh_expires_at,
        status: "connected",
        last_error: ending ? "AliExpress izni yakında bitiyor; Hesaplarım'dan yeniden bağla." : null,
        updated_at: new Date().toISOString(),
      }).eq("id", c.id);
      out["aliexpress:" + c.id] = "yenilendi" + (ending ? " (izin yakında bitiyor)" : "");
    } catch (e) {
      const expired = msLeft(cred.expires_at) <= 0;
      await db.from("supplier_connections").update({
        status: expired ? "expired" : "connected", last_error: short((e as Error).message), updated_at: new Date().toISOString(),
      }).eq("id", c.id);
      out["aliexpress:" + c.id] = "hata: " + short((e as Error).message);
    }
  }
}

// ---------------------------------------------------------
// Instagram (Instagram girişi ile bağlanan hesaplar)
// ---------------------------------------------------------
async function refreshInstagram(out: Record<string, string>) {
  const { data: chans } = await db.from("social_channels")
    .select("id, token_expires_at, updated_at").eq("platform", "instagram").eq("active", true);
  for (const c of chans || []) {
    const left = msLeft(c.token_expires_at);
    if (left > 10 * DAY) {
      // Yenilemeye gerek yok ama Meta anahtarı iptal etmiş olabilir: hafif bir geçerlilik kontrolü
      try {
        const { data: tok } = await db.rpc("social_channel_get_token", { p_channel_id: c.id });
        const r = await fetch(`https://graph.instagram.com/me?fields=id&access_token=${encodeURIComponent(tok || "")}`);
        const j = await r.json().catch(() => ({}));
        if (j?.error) {
          await db.from("social_channels").update({ token_status: "expired", token_error: short(j.error.message) }).eq("id", c.id);
          out["instagram:" + c.id] = "geçersiz: " + short(j.error.message);
        } else {
          await db.from("social_channels").update({ token_status: "ok", token_error: null }).eq("id", c.id);
          out["instagram:" + c.id] = "geçerli";
        }
      } catch (e) {
        out["instagram:" + c.id] = "kontrol edilemedi: " + short((e as Error).message);
      }
      continue;
    }
    try {
      if (left <= 0) throw new Error("Anahtarın süresi dolmuş");
      const { data: tok } = await db.rpc("social_channel_get_token", { p_channel_id: c.id });
      if (!tok) throw new Error("Anahtar bulunamadı");
      const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tok)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.access_token) throw new Error(short(j?.error?.message || "Instagram yenileme reddetti"));
      await db.rpc("social_channel_set_token", { p_channel_id: c.id, p_token: j.access_token });
      await db.from("social_channels").update({
        token_expires_at: new Date(Date.now() + (Number(j.expires_in) || 5184000) * 1000).toISOString(),
        token_status: "ok", token_error: null, updated_at: new Date().toISOString(),
      }).eq("id", c.id);
      out["instagram:" + c.id] = "yenilendi";
    } catch (e) {
      // Meta oturumu geçersiz kıldıysa (şifre değişikliği, güvenlik) anahtar artık çalışmaz
      const msg = (e as Error).message;
      const invalid = left <= 0 || /validating access token|session has been invalidated|expired|invalid/i.test(msg);
      await db.from("social_channels").update({
        token_status: invalid ? "expired" : "expiring", token_error: short(msg),
      }).eq("id", c.id);
      out["instagram:" + c.id] = "hata: " + short((e as Error).message);
    }
  }
}

// ---------------------------------------------------------
// Meta (Facebook sayfası / WhatsApp): sunucuda yenilenemez -> bitiş tarihini öğren, uyar
// ---------------------------------------------------------
async function checkMeta(out: Record<string, string>) {
  if (!FB_APP_SECRET) return;
  const { data: chans } = await db.from("social_channels")
    .select("id, platform, access_token, token_expires_at").in("platform", ["facebook", "whatsapp"]).eq("active", true);
  for (const c of chans || []) {
    try {
      let exp = c.token_expires_at as string | null;
      // Her çalışmada geçerlilik kontrolü (Meta anahtarı iptal etmiş olabilir); bitiş yoksa öğren
      if (c.access_token) {
        const r = await fetch(`https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(c.access_token)}&access_token=${encodeURIComponent(FB_APP_ID + "|" + FB_APP_SECRET)}`);
        const d = await r.json().catch(() => ({}));
        if (d?.data?.is_valid === false) {
          await db.from("social_channels").update({ token_status: "expired", token_error: short(d?.data?.error?.message || "Meta bağlantısı geçersiz") }).eq("id", c.id);
          out[c.platform + ":" + c.id] = "geçersiz";
          continue;
        }
        const ts = Number(d?.data?.data_access_expires_at || 0) > 0 && Number(d?.data?.expires_at || 0) === 0
          ? Number(d.data.data_access_expires_at) : Number(d?.data?.expires_at || 0);
        if (ts > 0) {
          exp = new Date(ts * 1000).toISOString();
          await db.from("social_channels").update({ token_expires_at: exp }).eq("id", c.id);
        }
      }
      const left = realMsLeft(exp);
      const status = !exp ? "ok" : left <= 0 ? "expired" : left <= 7 * DAY ? "expiring" : "ok";
      await db.from("social_channels").update({
        token_status: status,
        token_error: status === "ok" ? null : "Meta bağlantısının süresi " + (left <= 0 ? "doldu" : "yakında doluyor"),
      }).eq("id", c.id);
      out[c.platform + ":" + c.id] = status + (exp ? " (" + exp.slice(0, 10) + ")" : "");
    } catch (e) {
      out[c.platform + ":" + c.id] = "kontrol edilemedi: " + short((e as Error).message);
    }
  }
}

// ---------------------------------------------------------
// Etsy / eBay / Wix (store_connections): yenileme anahtarını canlı tut
// ---------------------------------------------------------
async function refreshStoreOAuth(out: Record<string, string>) {
  const { data: conns } = await db.from("store_connections")
    .select("id, marketplace_code, status, token_expires_at")
    .is("deleted_at", null).eq("status", "connected")
    .or("marketplace_code.eq.etsy,marketplace_code.eq.wix,marketplace_code.like.ebay_%");
  for (const c of conns || []) {
    if (msLeft(c.token_expires_at) > 6 * HOUR) { out[c.marketplace_code + ":" + c.id] = "gerek yok"; continue; }
    const { data: cred } = await db.rpc("store_connection_get_credentials", { p_connection_id: c.id });
    try {
      if (!cred?.refresh_token) throw new Error("Yenileme anahtarı yok");
      let r: Response;
      if (c.marketplace_code === "etsy") {
        r = await fetch("https://api.etsy.com/v3/public/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "x-api-key": etsyApiKey() },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: ETSY_CLIENT_ID, refresh_token: cred.refresh_token }).toString(),
        });
      } else if (c.marketplace_code === "wix") {
        r = await fetch("https://www.wix.com/oauth/access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: WIX_CLIENT_ID, client_secret: Deno.env.get("WIX_CLIENT_SECRET") ?? "", refresh_token: cred.refresh_token }),
        });
      } else {
        const basic = btoa(`${Deno.env.get("EBAY_CLIENT_ID") ?? ""}:${Deno.env.get("EBAY_CLIENT_SECRET") ?? ""}`);
        r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cred.refresh_token }).toString(),
        });
      }
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.access_token) throw new Error(short(d?.error_description || d?.error || d?.message || `HTTP ${r.status}`));
      const expiresAt = new Date(Date.now() + (Number(d.expires_in) || 3600) * 1000).toISOString();
      await db.rpc("store_connection_set_credentials", {
        p_connection_id: c.id,
        p_credentials: { ...cred, access_token: d.access_token, refresh_token: d.refresh_token || cred.refresh_token, expires_at: expiresAt },
      });
      await db.from("store_connections").update({ token_expires_at: expiresAt, last_error: null, last_verified_at: new Date().toISOString() }).eq("id", c.id);
      out[c.marketplace_code + ":" + c.id] = "yenilendi";
    } catch (e) {
      await db.from("store_connections").update({ status: "expired", last_error: short((e as Error).message) }).eq("id", c.id);
      out[c.marketplace_code + ":" + c.id] = "hata: " + short((e as Error).message);
    }
  }
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(body?.cronSecret || "").trim() !== CRON_SECRET.trim()) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  FORCE = body?.force === true;
  const out: Record<string, string> = {};
  const steps: [string, (o: Record<string, string>) => Promise<void>][] = [
    ["site AliExpress", refreshPlatformAliExpress],
    ["satıcı AliExpress", refreshSupplierAliExpress],
    ["Instagram", refreshInstagram],
    ["Meta", checkMeta],
    ["Etsy/eBay/Wix", refreshStoreOAuth],
  ];
  for (const [name, fn] of steps) {
    try { await fn(out); } catch (e) { out[name] = "adım hatası: " + short((e as Error).message); }
  }
  return json({ ok: true, results: out });
});
