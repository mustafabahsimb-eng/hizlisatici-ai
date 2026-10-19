// =========================================================
// Amazon Selling Partner API (SP-API) - ortak yardımcılar
// Kaynak: developer-docs.amazon/sp-api (uç noktalar, pazar kimlikleri, website authorization workflow)
// - İstekler yalnız LWA erişim anahtarıyla (x-amz-access-token); AWS imzası gerekmez.
// - Sandbox: aynı istek, sandbox.sellingpartnerapi-<bölge>.amazon.com (statik örnek cevaplar; 5 istek/sn).
// Seltigo'nun uygulama bilgileri (secrets): AMAZON_APP_ID, AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET
//   AMAZON_APP_DRAFT=true  -> yayınlanmamış (taslak) uygulama: yetki adresine version=beta eklenir
//   AMAZON_LIVE=true       -> canlı uç noktalar; yoksa SANDBOX (varsayılan, güvenli)
// Satıcının yenileme anahtarı (refresh_token) store_connections + Vault'ta durur.
// =========================================================
import { SIM_LATENCY_MS, simulate } from "./amazon-sim.ts";

export type Region = "na" | "eu" | "fe";
export type AmazonMarket = { code: string; id: string; country: string; region: Region; sellerCentral: string; domain: string; currency: string; locale: string };

// marketplaces.code -> Amazon pazar bilgisi (pazar kimlikleri resmi listeden)
export const AMAZON_MARKETS: AmazonMarket[] = [
  { code: "amazon_tr", id: "A33AVAJ2PDY3EV", country: "TR", region: "eu", sellerCentral: "https://sellercentral.amazon.com.tr", domain: "www.amazon.com.tr", currency: "TRY", locale: "tr_TR" },
  { code: "amazon_de", id: "A1PA6795UKMFR9", country: "DE", region: "eu", sellerCentral: "https://sellercentral-europe.amazon.com", domain: "www.amazon.de", currency: "EUR", locale: "de_DE" },
  { code: "amazon_uk", id: "A1F83G8C2ARO7P", country: "GB", region: "eu", sellerCentral: "https://sellercentral-europe.amazon.com", domain: "www.amazon.co.uk", currency: "GBP", locale: "en_GB" },
  { code: "amazon_fr", id: "A13V1IB3VIYZZH", country: "FR", region: "eu", sellerCentral: "https://sellercentral-europe.amazon.com", domain: "www.amazon.fr", currency: "EUR", locale: "fr_FR" },
  { code: "amazon_it", id: "APJ6JRA9NG5V4", country: "IT", region: "eu", sellerCentral: "https://sellercentral-europe.amazon.com", domain: "www.amazon.it", currency: "EUR", locale: "it_IT" },
  { code: "amazon_es", id: "A1RKKUPIHCS9HS", country: "ES", region: "eu", sellerCentral: "https://sellercentral-europe.amazon.com", domain: "www.amazon.es", currency: "EUR", locale: "es_ES" },
  { code: "amazon_nl", id: "A1805IZSGTT6HS", country: "NL", region: "eu", sellerCentral: "https://sellercentral.amazon.nl", domain: "www.amazon.nl", currency: "EUR", locale: "nl_NL" },
  { code: "amazon_se", id: "A2NODRKZP88ZB9", country: "SE", region: "eu", sellerCentral: "https://sellercentral.amazon.se", domain: "www.amazon.se", currency: "SEK", locale: "sv_SE" },
  { code: "amazon_pl", id: "A1C3SOZRARQ6R3", country: "PL", region: "eu", sellerCentral: "https://sellercentral.amazon.pl", domain: "www.amazon.pl", currency: "PLN", locale: "pl_PL" },
  { code: "amazon_be", id: "AMEN7PMS3EDWL", country: "BE", region: "eu", sellerCentral: "https://sellercentral.amazon.com.be", domain: "www.amazon.com.be", currency: "EUR", locale: "fr_BE" },
  { code: "amazon_ie", id: "A28R8C7NBKEWEA", country: "IE", region: "eu", sellerCentral: "https://sellercentral.amazon.ie", domain: "www.amazon.ie", currency: "EUR", locale: "en_IE" },
  { code: "amazon_ae", id: "A2VIGQ35RCS4UG", country: "AE", region: "eu", sellerCentral: "https://sellercentral.amazon.ae", domain: "www.amazon.ae", currency: "AED", locale: "en_AE" },
  { code: "amazon_sa", id: "A17E79C6D8DWNP", country: "SA", region: "eu", sellerCentral: "https://sellercentral.amazon.sa", domain: "www.amazon.sa", currency: "SAR", locale: "en_AE" },
  { code: "amazon_eg", id: "ARBP9OOSHTCHU", country: "EG", region: "eu", sellerCentral: "https://sellercentral.amazon.eg", domain: "www.amazon.eg", currency: "EGP", locale: "en_AE" },
  { code: "amazon_in", id: "A21TJRUUN4KGV", country: "IN", region: "eu", sellerCentral: "https://sellercentral.amazon.in", domain: "www.amazon.in", currency: "INR", locale: "en_IN" },
  { code: "amazon_za", id: "AE08WJ6YKNBMC", country: "ZA", region: "eu", sellerCentral: "https://sellercentral.amazon.co.za", domain: "www.amazon.co.za", currency: "ZAR", locale: "en_ZA" },
  { code: "amazon_us", id: "ATVPDKIKX0DER", country: "US", region: "na", sellerCentral: "https://sellercentral.amazon.com", domain: "www.amazon.com", currency: "USD", locale: "en_US" },
  { code: "amazon_ca", id: "A2EUQ1WTGCTBG2", country: "CA", region: "na", sellerCentral: "https://sellercentral.amazon.ca", domain: "www.amazon.ca", currency: "CAD", locale: "en_CA" },
  { code: "amazon_mx", id: "A1AM78C64UM0Y8", country: "MX", region: "na", sellerCentral: "https://sellercentral.amazon.com.mx", domain: "www.amazon.com.mx", currency: "MXN", locale: "es_MX" },
  { code: "amazon_br", id: "A2Q3Y263D00KWC", country: "BR", region: "na", sellerCentral: "https://sellercentral.amazon.com.br", domain: "www.amazon.com.br", currency: "BRL", locale: "pt_BR" },
  { code: "amazon_jp", id: "A1VC38T7YXB528", country: "JP", region: "fe", sellerCentral: "https://sellercentral.amazon.co.jp", domain: "www.amazon.co.jp", currency: "JPY", locale: "ja_JP" },
  { code: "amazon_au", id: "A39IBJ37TRP1C6", country: "AU", region: "fe", sellerCentral: "https://sellercentral.amazon.com.au", domain: "www.amazon.com.au", currency: "AUD", locale: "en_AU" },
  { code: "amazon_sg", id: "A19VAU5U5O7RUS", country: "SG", region: "fe", sellerCentral: "https://sellercentral.amazon.sg", domain: "www.amazon.sg", currency: "SGD", locale: "en_SG" },
];
export const marketByCode = (code: string) => AMAZON_MARKETS.find((m) => m.code === code) || null;
export const marketById = (id: string) => AMAZON_MARKETS.find((m) => m.id === id) || null;

// Bağlanma bölgesi -> yetki verilen Seller Central (Türkiye ayrı Seller Central; teknik olarak AB bölgesi)
export const CONNECT_REGIONS: Record<string, { region: Region; sellerCentral: string }> = {
  tr: { region: "eu", sellerCentral: "https://sellercentral.amazon.com.tr" },
  eu: { region: "eu", sellerCentral: "https://sellercentral-europe.amazon.com" },
  na: { region: "na", sellerCentral: "https://sellercentral.amazon.com" },
  fe: { region: "fe", sellerCentral: "https://sellercentral.amazon.co.jp" },
};

const env = (k: string) => Deno.env.get(k) ?? "";
export const amazonConfigured = () => !!(env("AMAZON_APP_ID") && env("AMAZON_LWA_CLIENT_ID") && env("AMAZON_LWA_CLIENT_SECRET"));
export const amazonLive = () => env("AMAZON_LIVE") === "true";
export const REDIRECT_URI = "https://mustafabahsimb-eng.github.io/hizlisatici-ai/amazon-callback.html";

export function endpoint(region: Region, sandbox = !amazonLive()): string {
  return `https://${sandbox ? "sandbox." : ""}sellingpartnerapi-${region}.amazon.com`;
}

export function consentUrl(sellerCentral: string, state: string): string {
  const q = new URLSearchParams({ application_id: env("AMAZON_APP_ID"), state, redirect_uri: REDIRECT_URI });
  if (env("AMAZON_APP_DRAFT") !== "false") q.set("version", "beta"); // taslak uygulama (yayın onayına kadar)
  return `${sellerCentral}/apps/authorize/consent?${q}`;
}

// ---------- Login with Amazon (LWA) ----------
async function lwa(params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams({ ...params, client_id: env("AMAZON_LWA_CLIENT_ID"), client_secret: env("AMAZON_LWA_CLIENT_SECRET") });
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body, signal: AbortSignal.timeout(20000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("Amazon giriş anahtarı alınamadı: " + String(d.error_description || d.error || r.status).slice(0, 200));
  return d;
}
// Yetki kodu (5 dk geçerli) -> erişim + yenileme anahtarı
export const exchangeCode = (code: string) => lwa({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });

// Erişim anahtarı 1 saat geçerli; fonksiyon örneği içinde önbellekte tutulur
const tokenCache = new Map<string, { token: string; exp: number }>();
export async function accessToken(refreshToken: string): Promise<string> {
  const c = tokenCache.get(refreshToken);
  if (c && c.exp > Date.now() + 60_000) return c.token;
  const d = await lwa({ grant_type: "refresh_token", refresh_token: refreshToken });
  tokenCache.set(refreshToken, { token: d.access_token, exp: Date.now() + Number(d.expires_in || 3600) * 1000 });
  return d.access_token;
}

// ---------- SP-API çağrısı ----------
export class SpApiError extends Error {
  status: number; body: any;
  constructor(status: number, body: any) {
    const m = body?.errors?.[0];
    super(`Amazon ${status}: ${m ? `${m.code} ${m.message}` : JSON.stringify(body).slice(0, 200)}`);
    this.status = status; this.body = body;
  }
}
// simulate: yalnız test kullanıcısının sandbox bağlantısı (amazon-sim.ts); giriş anahtarı yine gerçek Amazon'dan alınır
export type Ctx = { region: Region; refreshToken: string; sandbox?: boolean; rdt?: string; simulate?: boolean };

export async function sp(ctx: Ctx, method: string, path: string, opts: { query?: Record<string, string | string[] | undefined>; body?: unknown } = {}): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v == null) continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  if (ctx.simulate) {
    await accessToken(ctx.refreshToken); // gerçek LWA
    await new Promise((r) => setTimeout(r, SIM_LATENCY_MS));
    const r = simulate(method.toUpperCase(), path, q, opts.body ?? null);
    if (r.status >= 400) throw new SpApiError(r.status, r.data);
    return r.data;
  }
  const url = endpoint(ctx.region, ctx.sandbox ?? !amazonLive()) + path + (q.toString() ? "?" + q : "");
  for (let attempt = 0; ; attempt++) {
    const token = ctx.rdt || await accessToken(ctx.refreshToken);
    const r = await fetch(url, {
      method,
      headers: { "x-amz-access-token": token, "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Seltigo/1.0 (Language=TypeScript)" },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 204) return {};
    const d = await r.json().catch(() => ({}));
    if (r.ok) return d;
    // Kota (429) ve geçici sunucu hataları: artan bekleme ile 4 kez dene
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt + Math.random() * 300));
      continue;
    }
    throw new SpApiError(r.status, d);
  }
}

// Kişisel veri (alıcı adı / adres) için kısıtlı veri anahtarı (RDT). Uygulamada PII yetkisi yoksa null döner.
export async function restrictedToken(ctx: Ctx, resources: { method: string; path: string; dataElements?: string[] }[]): Promise<string | null> {
  try {
    const d = await sp(ctx, "POST", "/tokens/2021-03-01/restrictedDataToken", { body: { restrictedResources: resources } });
    return d.restrictedDataToken || null;
  } catch (_) {
    return null;
  }
}

// ---------- Yardımcılar ----------
export const money = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
// Amazon SKU: en fazla 40 karakter; satıcının ürün numarasından türetilir (aynı ürün hep aynı SKU)
export function makeSku(productId: number | string, suffix = ""): string {
  return ("SLT-" + productId + (suffix ? "-" + suffix : "")).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
}
// GTIN türü (Amazon external_product_id tipi)
export function gtinType(code: string): "ean" | "upc" | "gtin" | "isbn" | null {
  const c = String(code || "").replace(/\D/g, "");
  if (!c) return null;
  if (c.length === 12) return "upc";
  if (c.length === 13) return c.startsWith("978") || c.startsWith("979") ? "isbn" : "ean";
  if (c.length === 14) return "gtin";
  if (c.length === 8) return "ean";
  return null;
}
export function validGtin(code: string): boolean {
  const c = String(code || "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(c.length)) return false;
  const digits = c.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
