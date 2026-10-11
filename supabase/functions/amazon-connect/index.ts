// =========================================================
// Amazon mağaza bağlantısı (SP-API "website authorization workflow")
// Satıcı (oturum, gövdede userAccessToken):
//   { action: "start", region: "tr" | "eu" | "na" | "fe" } -> Seller Central onay adresi (state 10 dk, tek kullanımlık)
//   { action: "callback", code, state, sellingPartnerId }  -> anahtar değişimi (kod 5 dk geçerli), pazarlar, store_connections + Vault
//   { action: "status" } -> Amazon uygulaması hazır mı, canlı mı sandbox mı
// Sistem (CRON_SECRET):
//   { action: "selftest" } -> Amazon'un statik sandbox'ında uçtan uca deneme (AMAZON_SANDBOX_REFRESH_TOKEN gerekir)
// Uygulama tanımlı değilse (secrets yok) "notReady" döner; bağlantı düğmesi "yakında" der. Varsayılan SANDBOX.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AMAZON_MARKETS, amazonConfigured, amazonLive, CONNECT_REGIONS, consentUrl, exchangeCode, marketById, sp, type Ctx,
} from "../_shared/amazon.ts";
import { buyAmazonLabel, shipFromAddress, shipmentRequest } from "../_shared/amazon-shipping.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);

function randomState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function saveConnection(userId: string, code: string, sellerId: string, env: "live" | "sandbox", credentials: Record<string, unknown>, storeName?: string) {
  const { data: mk } = await db.from("marketplaces").select("name").eq("code", code).maybeSingle();
  const { data: existing } = await db.from("store_connections").select("id, settings").eq("user_id", userId).eq("marketplace_code", code)
    .eq("environment", env).eq("external_seller_id", sellerId).is("deleted_at", null).maybeSingle();
  const fields = {
    label: (mk?.name || code) + (storeName ? " · " + storeName : ""), status: "connected", last_verified_at: new Date().toISOString(), last_error: null,
    token_expires_at: null, // Amazon yenileme anahtarı süresiz (satıcı yetkiyi geri alana / 365 günlük yenilemeye kadar)
  };
  let id: string;
  if (existing) {
    await db.from("store_connections").update(fields).eq("id", existing.id);
    id = existing.id;
  } else {
    const { data, error } = await db.from("store_connections").insert({
      user_id: userId, marketplace_code: code, environment: env, external_seller_id: sellerId, ...fields,
      settings: { dry_run: env !== "live", authorized_at: new Date().toISOString() },
    }).select("id").single();
    if (error) throw error;
    id = data.id;
  }
  const { error: vErr } = await db.rpc("store_connection_set_credentials", { p_connection_id: id, p_credentials: credentials });
  if (vErr) throw vErr;
  return id;
}

async function callback(userId: string, b: any) {
  const state = String(b.state || "");
  const { data: st } = await db.from("amazon_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st || st.user_id !== userId || st.used_at || Date.now() - new Date(st.created_at).getTime() > 10 * 60_000) {
    return { ok: false, error: "Bağlantı isteği geçersiz ya da süresi doldu. Lütfen Hesaplarım sayfasından yeniden dene." };
  }
  await db.from("amazon_oauth_states").update({ used_at: new Date().toISOString() }).eq("state", state);
  const sellerId = String(b.sellingPartnerId || "").trim();
  if (!b.code || !sellerId) return { ok: false, error: "Amazon onay bilgisi eksik geldi." };
  const tok = await exchangeCode(String(b.code));
  const reg = CONNECT_REGIONS[st.connect_region];
  const env: "live" | "sandbox" = amazonLive() ? "live" : "sandbox";
  const ctx: Ctx = { region: reg.region, refreshToken: tok.refresh_token };
  // Satıcının hangi Amazon pazarlarında satış yaptığı
  let codes: { code: string; storeName?: string }[] = [];
  try {
    const d = await sp(ctx, "GET", "/sellers/v1/marketplaceParticipations");
    for (const p of d?.payload || []) {
      const m = marketById(p?.marketplace?.id);
      if (!m || p?.participation?.isParticipating === false) continue;
      if (st.connect_region === "tr" ? m.code !== "amazon_tr" : m.region !== reg.region || (st.connect_region === "eu" && m.code === "amazon_tr")) continue;
      codes.push({ code: m.code, storeName: p.storeName });
    }
  } catch (_) { /* aşağıdaki varsayılan */ }
  if (!codes.length) codes = [{ code: st.connect_region === "tr" ? "amazon_tr" : st.connect_region === "na" ? "amazon_us" : st.connect_region === "fe" ? "amazon_jp" : "amazon_de" }];
  const credentials = { refresh_token: tok.refresh_token, region: reg.region, seller_id: sellerId, connect_region: st.connect_region };
  const ids: string[] = [];
  for (const c of codes) ids.push(await saveConnection(userId, c.code, sellerId, env, credentials, c.storeName));
  return { ok: true, environment: env, marketplaces: codes.map((c) => c.code), connections: ids.length };
}

// Amazon'un statik sandbox örnekleriyle uçtan uca deneme (istek değerleri Amazon modelindeki örneklerle birebir aynı olmalı)
async function selftest() {
  const rt = Deno.env.get("AMAZON_SANDBOX_REFRESH_TOKEN") || "";
  if (!amazonConfigured() || !rt) return { ok: false, notReady: true, need: ["AMAZON_APP_ID", "AMAZON_LWA_CLIENT_ID", "AMAZON_LWA_CLIENT_SECRET", "AMAZON_SANDBOX_REFRESH_TOKEN"] };
  const ctx: Ctx = { region: "na", refreshToken: rt, sandbox: true };
  const steps: Record<string, unknown> = {};
  const t0 = Date.now();
  const run = async (name: string, f: () => Promise<any>, ok: (d: any) => boolean) => {
    try { const d = await f(); steps[name] = ok(d) ? "geçti" : "beklenmeyen cevap: " + short(JSON.stringify(d), 200); } catch (e) { steps[name] = "hata: " + short((e as Error).message); }
  };
  await run("pazarlar", () => sp(ctx, "GET", "/sellers/v1/marketplaceParticipations"), (d) => !!d?.payload?.[0]?.marketplace?.id);
  await run("katalog arama", () => sp(ctx, "GET", "/catalog/2022-04-01/items", { query: { keywords: ["samsung", "tv"], marketplaceIds: ["ATVPDKIKX0DER"],
    includedData: ["classifications", "dimensions", "identifiers", "images", "productTypes", "relationships", "salesRanks", "summaries", "vendorDetails"] } }), (d) => !!d?.items?.[0]?.asin);
  await run("ilan prova (VALIDATION_PREVIEW)", () => sp(ctx, "PUT", "/listings/2021-08-01/items/AXXXXXXXXXXXXX/VALIDATION_VALID", {
    query: { marketplaceIds: ["ATVPDKIKX0DER"], includedData: ["identifiers", "issues"], mode: "VALIDATION_PREVIEW" },
    body: { productType: "PRODUCT", requirements: "LISTING", attributes: {} } }), (d) => d?.status === "VALID" || d?.status === "ACCEPTED");
  await run("siparişler", () => sp(ctx, "GET", "/orders/v0/orders", { query: { CreatedAfter: "TEST_CASE_200", MarketplaceIds: ["ATVPDKIKX0DER"] } }), (d) => Array.isArray(d?.payload?.Orders));
  await run("sipariş kalemleri", () => sp(ctx, "GET", "/orders/v0/orders/TEST_CASE_200/orderItems"), (d) => Array.isArray(d?.payload?.OrderItems));
  await run("etiket (Buy Shipping)", async () => {
    const us = marketById("ATVPDKIKX0DER")!;
    const from = shipFromAddress({ DefaultShipFromLocationAddress: { Name: "John Doe", AddressLine1: "300 Turnbull Ave", City: "Detroit", StateOrRegion: "MI", PostalCode: "48123", CountryCode: "US", Phone: "7132341234" } }, { email: "jdoeasdfllkj@yahoo.com" })!;
    return await buyAmazonLabel(ctx, shipmentRequest({ amazonOrderId: "903-5563053-5647845", orderItemId: "52986411826454", quantity: 1, shipFrom: from, market: us,
      dims: { length: 10.25, width: 10.25, height: 10.25 }, weight: 10.25 }));
  }, (d) => !!d?.trackingId);
  const ms = Date.now() - t0;
  return { ok: Object.values(steps).every((s) => s === "geçti"), steps, ms };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "selftest") return json(await selftest());
      return json({ error: "Geçersiz işlem" }, 400);
    }
    const token = String(b?.userAccessToken || "").trim();
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);

    if (b.action === "status") {
      return json({ ok: true, configured: amazonConfigured(), live: amazonLive(), markets: AMAZON_MARKETS.map((m) => m.code) });
    }
    if (b.action === "start") {
      const region = String(b.region || "");
      const reg = CONNECT_REGIONS[region];
      if (!reg) return json({ ok: false, error: "Geçersiz bölge" }, 400);
      if (!amazonConfigured()) return json({ ok: false, notReady: true, error: "Amazon bağlantısı çok yakında açılacak." });
      const state = randomState();
      await db.from("amazon_oauth_states").delete().lt("created_at", new Date(Date.now() - 86400_000).toISOString());
      const { error } = await db.from("amazon_oauth_states").insert({ state, user_id: userId, connect_region: region });
      if (error) throw error;
      return json({ ok: true, url: consentUrl(reg.sellerCentral, state) });
    }
    if (b.action === "callback") return json(await callback(userId, b));
    return json({ error: "Geçersiz işlem" }, 400);
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
