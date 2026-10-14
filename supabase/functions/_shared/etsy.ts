// =========================================================
// Etsy Open API v3 — ortak modül
// - x-api-key: "<keystring>:<shared secret>" (9 Şubat 2026'dan beri zorunlu; secret: ETSY_SHARED_SECRET)
// - OAuth 2.0 (PKCE) erişim anahtarı 1 saat; yenileme anahtarı 90 gün. Süresi yaklaşınca burada yenilenir (token-refresher de 3 saatte bir).
// - Kota: saniyede ~10 istek; 429'da artan beklemeyle tekrar.
// Kaynak: developer.etsy.com (Authentication, Listing, ListingImage, ListingFile, SellerTaxonomy, Shop) ve resmi OpenAPI tanımı.
// =========================================================
// Uygulama anahtarı (keystring; herkese açık, OAuth adresinde de görünür). Değişirse secret ETSY_KEYSTRING ile güncellenir.
export const ETSY_CLIENT_ID = Deno.env.get("ETSY_KEYSTRING") || "1z497h37rk069va5r0xvxqw3";
export const ETSY_REDIRECT = "https://mustafabahsimb-eng.github.io/hizlisatici-ai/etsy-callback.html";
export const ETSY_SCOPES = "listings_r listings_w listings_d shops_r shops_w transactions_r transactions_w email_r";
const API = "https://api.etsy.com/v3/application";

export const etsyApiKey = () => {
  const secret = Deno.env.get("ETSY_SHARED_SECRET") ?? "";
  return secret ? `${ETSY_CLIENT_ID}:${secret}` : ETSY_CLIENT_ID;
};

export class EtsyError extends Error {
  status: number; body: any;
  constructor(status: number, body: any) {
    super(`Etsy ${status}: ${typeof body === "string" ? body.slice(0, 200) : (body?.error || body?.error_description || JSON.stringify(body).slice(0, 200))}`);
    this.status = status; this.body = body;
  }
}

export type EtsyCtx = { token: string; fetch?: typeof fetch };

// JSON / form / çok parçalı (dosya) istek
export async function etsy(ctx: EtsyCtx, method: string, path: string, opts: { form?: Record<string, unknown>; multipart?: FormData; json?: unknown; query?: Record<string, string> } = {}): Promise<any> {
  const f = ctx.fetch || fetch;
  const q = opts.query ? "?" + new URLSearchParams(opts.query) : "";
  for (let i = 0; ; i++) {
    const headers: Record<string, string> = { "x-api-key": etsyApiKey(), Authorization: `Bearer ${ctx.token}`, Accept: "application/json" };
    let body: BodyInit | undefined;
    if (opts.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) p.set(k, v.join(","));
        else p.set(k, String(v));
      }
      body = p.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["Content-Type"] = "application/json";
    } else if (opts.multipart) body = opts.multipart;
    const r = await f(`${API}${path}${q}`, { method, headers, body, signal: AbortSignal.timeout(120000) });
    if (r.status === 204) return {};
    const text = await r.text();
    let d: any = text;
    try { d = text ? JSON.parse(text) : {}; } catch { /* düz metin */ }
    if (r.ok) return d;
    if ((r.status === 429 || r.status >= 500) && i < 4) { await new Promise((res) => setTimeout(res, 1000 * 2 ** i + Math.random() * 300)); continue; }
    throw new EtsyError(r.status, d);
  }
}

// Kasadaki anahtar; süresi 5 dk içinde dolacaksa yenilenir ve kasaya yazılır
export async function etsyToken(db: any, connectionId: string, f: typeof fetch = fetch): Promise<{ token: string; cred: any }> {
  const { data: cred } = await db.rpc("store_connection_get_credentials", { p_connection_id: connectionId });
  if (!cred?.access_token) throw new Error("Etsy bağlantı bilgisi yok");
  const exp = cred.expires_at ? new Date(cred.expires_at).getTime() : 0;
  if (exp && exp > Date.now() + 5 * 60_000) return { token: cred.access_token, cred };
  if (!cred.refresh_token) return { token: cred.access_token, cred };
  const r = await f("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "x-api-key": etsyApiKey() },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: ETSY_CLIENT_ID, refresh_token: cred.refresh_token }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d?.access_token) {
    await db.from("store_connections").update({ status: "expired", last_error: "Etsy anahtarı yenilenemedi: " + String(d?.error_description || d?.error || r.status).slice(0, 150) }).eq("id", connectionId);
    throw new Error("Etsy anahtarı yenilenemedi");
  }
  const expiresAt = new Date(Date.now() + (Number(d.expires_in) || 3600) * 1000).toISOString();
  const next = { ...cred, access_token: d.access_token, refresh_token: d.refresh_token || cred.refresh_token, expires_at: expiresAt };
  await db.rpc("store_connection_set_credentials", { p_connection_id: connectionId, p_credentials: next });
  await db.from("store_connections").update({ token_expires_at: expiresAt, last_error: null, last_verified_at: new Date().toISOString() }).eq("id", connectionId);
  return { token: d.access_token, cred: next };
}

// Anahtarın sahibi ve mağazası (getMe + getShopByOwnerUserId)
export async function etsyShop(ctx: EtsyCtx): Promise<{ userId: string; shopId: string | null; shopName: string | null }> {
  const me = await etsy(ctx, "GET", "/users/me");
  const userId = String(me.user_id);
  let shopId: string | null = me.shop_id ? String(me.shop_id) : null, shopName: string | null = null;
  try {
    const shop = await etsy(ctx, "GET", `/users/${userId}/shops`);
    shopId = String(shop.shop_id || shopId || "") || null;
    shopName = shop.shop_name || null;
  } catch (e) { if (!(e instanceof EtsyError && e.status === 404)) throw e; }
  return { userId, shopId, shopName };
}

// Satıcı kategori ağacında ada göre düğüm (ör. "Digital Prints"); sonuç veritabanında önbelleğe alınır
export function findTaxonomy(nodes: any[], name: string, parentHint?: string): { id: number; path: string } | null {
  const want = name.toLowerCase();
  const stack: { n: any; path: string[] }[] = nodes.map((n) => ({ n, path: [n.name] }));
  const hits: { id: number; path: string }[] = [];
  while (stack.length) {
    const { n, path } = stack.shift()!;
    if (String(n.name).toLowerCase() === want) hits.push({ id: Number(n.id), path: path.join(" > ") });
    for (const c of n.children || []) stack.push({ n: c, path: [...path, c.name] });
  }
  if (!hits.length) return null;
  return (parentHint && hits.find((h) => h.path.toLowerCase().includes(parentHint.toLowerCase()))) || hits[0];
}
export async function etsyTaxonomyId(db: any, ctx: EtsyCtx, name = "Digital Prints", parentHint = "Prints"): Promise<number> {
  const key = `etsy_taxonomy:${name}`;
  const { data: c } = await db.from("app_cache").select("value, updated_at").eq("key", key).maybeSingle();
  if (c?.value?.id && Date.now() - new Date(c.updated_at).getTime() < 30 * 86400_000) return Number(c.value.id);
  const d = await etsy(ctx, "GET", "/seller-taxonomy/nodes");
  const hit = findTaxonomy(d.results || [], name, parentHint);
  if (!hit) throw new Error(`Etsy kategorisi bulunamadı: ${name}`);
  await db.from("app_cache").upsert({ key, value: hit, updated_at: new Date().toISOString() });
  return hit.id;
}

// Etsy etiket kuralları: en fazla 13 etiket, her biri en fazla 20 karakter, yalnız harf/rakam/boşluk/-/'/™/©/®
export function cleanTags(tags: unknown[]): string[] {
  const out: string[] = [];
  for (const t of tags || []) {
    const s = String(t || "").replace(/[^\p{L}\p{Nd}\s\-'™©®]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 20).trim();
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= 13) break;
  }
  return out;
}
// Başlık: en fazla 140 karakter; Etsy %, :, & karakterlerini en fazla bir kez kabul eder
export function cleanTitle(t: string): string {
  let s = String(t || "").replace(/\s+/g, " ").trim();
  for (const ch of ["%", ":", "&"]) { let seen = false; s = s.split("").filter((c) => (c !== ch ? true : (seen ? false : (seen = true)))).join(""); }
  return s.replace(/\s+/g, " ").slice(0, 140).trim();
}
