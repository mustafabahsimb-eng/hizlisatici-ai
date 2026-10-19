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
import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
import {
  AMAZON_MARKETS, amazonConfigured, amazonLive, CONNECT_REGIONS, consentUrl, exchangeCode, marketByCode, marketById, sp, type Ctx,
} from "../_shared/amazon.ts";
import { buyAmazonLabel, shipFromAddress, shipmentRequest } from "../_shared/amazon-shipping.ts";
import { ORDERS_PATH } from "../_shared/amazon-orders.ts";
import { prepareImages, storageUploader } from "../_shared/amazon-images.ts";
import { once } from "../_shared/once.ts";
import { AI_MODELS, aiText } from "../_shared/amazon-content.ts";

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

// Test kullanıcısına Amazon sandbox bağlantısı (satıcı hesabı olmadan "ürün ekle -> Amazon'a gönder" ölçümü için).
// Yalnız sistem çağrısı ve yalnız *@seltigo.test hesapları. Amazon cevapları benzetimden (settings.simulate), giriş anahtarı gerçek.
async function sandboxConnect(email: string, b: any) {
  if (!/@seltigo\.test$/i.test(email)) return { ok: false, error: "Yalnız test hesapları" };
  const rt = Deno.env.get("AMAZON_SANDBOX_REFRESH_TOKEN") || "";
  if (!rt) return { ok: false, error: "AMAZON_SANDBOX_REFRESH_TOKEN yok" };
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = (list?.users || []).find((u: any) => String(u.email).toLowerCase() === email.toLowerCase());
  if (!user) return { ok: false, error: "Kullanıcı yok" };
  if (b.remove) {
    const { data: rm } = await db.from("store_connections").update({ deleted_at: new Date().toISOString(), status: "disconnected" })
      .eq("user_id", user.id).like("marketplace_code", "amazon_%").eq("environment", "sandbox").is("deleted_at", null).select("id");
    return { ok: true, removed: (rm || []).length };
  }
  const codes: string[] = Array.isArray(b.markets) && b.markets.length ? b.markets.map(String) : ["amazon_tr", "amazon_de", "amazon_uk", "amazon_fr", "amazon_us"];
  const ids: string[] = [];
  for (const code of codes) {
    const m = marketByCode(code);
    if (!m) continue;
    const id = await saveConnection(user.id, code, "A1SELTIGOSANDBOX", "sandbox", { refresh_token: rt, region: m.region, seller_id: "A1SELTIGOSANDBOX", connect_region: m.code === "amazon_tr" ? "tr" : m.region }, "Sandbox");
    await db.from("store_connections").update({ settings: { dry_run: false, simulate: true, authorized_at: new Date().toISOString() } }).eq("id", id);
    ids.push(id);
  }
  return { ok: true, connections: ids.length, markets: codes };
}

// Amazon'un statik sandbox örnekleriyle uçtan uca deneme (istek değerleri Amazon modelindeki örneklerle birebir aynı olmalı)
// tokenSecret: hangi yenileme anahtarı denenecek (yalnız bu iki secret adı); live: canlı uçta yalnız OKUMA (satıcının pazarları) — hiçbir şey yazılmaz
const TOKEN_SECRETS = ["AMAZON_SANDBOX_REFRESH_TOKEN", "AMAZON_SANDBOX_REFRESH_TOKEN_NEW"];
async function selftest(b: any = {}) {
  const secretName = TOKEN_SECRETS.includes(b?.tokenSecret) ? b.tokenSecret : TOKEN_SECRETS[0];
  const rt = Deno.env.get(secretName) || "";
  // Sandbox isteği için LWA istemcisi + yenileme anahtarı yeter (AMAZON_APP_ID yalnız satıcı onay sayfası için)
  const need = ["AMAZON_LWA_CLIENT_ID", "AMAZON_LWA_CLIENT_SECRET", secretName].filter((k) => !Deno.env.get(k));
  if (need.length) return { ok: false, notReady: true, need };
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
  // Orders API v2026-01-01: Amazon'un sandbox örneği Japonya pazarında (Uzak Doğu bölgesi)
  await run("siparişler (v2026-01-01)", () => sp({ ...ctx, region: "fe" }, "GET", ORDERS_PATH, { query: { createdAfter: "2024-12-25T00:00:00Z", marketplaceIds: ["A1VC38T7YXB528"],
    includedData: ["BUYER", "RECIPIENT", "PROCEEDS", "EXPENSE", "PROMOTION", "CANCELLATION", "FULFILLMENT", "PACKAGES"] } }), (d) => !!d?.orders?.[0]?.orderItems?.length);
  await run("kategori onayı (Listings Restrictions)", () => sp(ctx, "GET", "/listings/2021-08-01/restrictions", {
    query: { asin: "B0000ASIN1", sellerId: "AXXXXXXXXXXXXX", marketplaceIds: ["ATVPDKIKX0DER"], conditionType: "used_acceptable" } }), (d) => Array.isArray(d?.restrictions));
  await run("Amazon kesintisi (Product Fees)", () => sp(ctx, "POST", "/products/fees/v0/listings/UmaS1/feesEstimate", { body: { FeesEstimateRequest: {
    MarketplaceId: "ATVPDKIKX0DER", IsAmazonFulfilled: false, PriceToEstimateFees: { ListingPrice: { CurrencyCode: "USD", Amount: 10 }, Shipping: { CurrencyCode: "USD", Amount: 10 },
      Points: { PointsNumber: 0, PointsMonetaryValue: { CurrencyCode: "USD", Amount: 0 } } }, Identifier: "UmaS1" } } }),
    (d) => d?.payload?.FeesEstimateResult?.Status === "Success" && Number(d.payload.FeesEstimateResult.FeesEstimate?.TotalFeesEstimate?.Amount) > 0);
  await run("etiket (Buy Shipping)", async () => {
    const us = marketById("ATVPDKIKX0DER")!;
    const from = shipFromAddress({ DefaultShipFromLocationAddress: { Name: "John Doe", AddressLine1: "300 Turnbull Ave", City: "Detroit", StateOrRegion: "MI", PostalCode: "48123", CountryCode: "US", Phone: "7132341234" } }, { email: "jdoeasdfllkj@yahoo.com" })!;
    return await buyAmazonLabel(ctx, shipmentRequest({ amazonOrderId: "903-5563053-5647845", orderItemId: "52986411826454", quantity: 1, shipFrom: from, market: us,
      dims: { length: 10.25, width: 10.25, height: 10.25 }, weight: 10.25 }));
  }, (d) => !!d?.trackingId);
  const ms = Date.now() - t0;
  // Canlı uçta salt okuma: anahtar hangi satıcı hesabına ve hangi pazarlara ait (yazma yok)
  let liveAccount: unknown = undefined;
  if (b?.live === true) {
    try {
      const d = await sp({ region: b.region || "eu", refreshToken: rt, sandbox: false }, "GET", "/sellers/v1/marketplaceParticipations");
      liveAccount = (d?.payload || []).map((x: any) => ({ id: x.marketplace?.id, country: x.marketplace?.countryCode, name: x.marketplace?.name,
        participating: x.participation?.isParticipating, suspended: x.participation?.hasSuspendedListings, store: x.storeName }));
    } catch (e) { liveAccount = { error: short((e as Error).message, 300) }; }
  }
  return { ok: Object.values(steps).every((s) => s === "geçti"), steps, ms, tokenSecret: secretName, appIdSet: !!Deno.env.get("AMAZON_APP_ID"), ...(liveAccount !== undefined ? { liveAccount } : {}) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "selftest") return json(await selftest(b));
      if (b.action === "sandbox_connect" && b.email) return json(await sandboxConnect(String(b.email), b));
      // Teşhis: AI modellerinin cevap kodu (anahtar ya da içerik dönmez)
      if (b.action === "ai_ping") {
        const out: Record<string, unknown> = {};
        for (const model of AI_MODELS) {
          const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "hi" }] }) }).catch((e) => ({ status: 0, text: async () => String(e) } as any));
          out[model] = { status: r.status, body: String(await r.text()).slice(0, 160) };
        }
        out.aiText = await aiText({ content: "Say OK", maxTokens: 5 });
        return json({ ok: true, aiPing: out });
      }
      // Ana görsel düzeltme ayrı çağrıda (kendi işlemci süresiyle); aynı ürünün tüm Amazon pazarları tek sonucu paylaşır
      if (b.action === "prepare_images" && Array.isArray(b.urls)) {
        const urls = b.urls.map(String).slice(0, 9), prefix = String(b.pathPrefix || "amazon/x");
        return json(await once(db, "amzimg:" + prefix + ":" + urls.slice(0, 5).join("|"), () => prepareImages(urls, { upload: storageUploader(db), pathPrefix: prefix })));
      }
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
      if (!(await featureEnabled(userId, "amazon"))) return json({ ok: false, error: FEATURE_OFF_MSG, feature: "amazon" });
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
