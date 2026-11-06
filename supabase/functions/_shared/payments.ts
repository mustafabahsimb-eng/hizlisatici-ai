// =========================================================
// Seltigo mağaza ödemeleri: iyzico (Checkout Form, IYZWSv2 imzası) ve PayTR (iFrame API). Varsayılan SANDBOX.
// Satıcının anahtarları Vault'ta (store_payment_providers.secret_id):
//   iyzico: { api_key, secret_key }            sandbox: https://sandbox-api.iyzipay.com  canlı: https://api.iyzipay.com
//   paytr : { merchant_id, merchant_key, merchant_salt }  (test_mode=1 sandbox)
// Canlıya geçiş: store_payment_providers.environment = 'live' (şirket kurulunca; PAYMENTS_LIVE=true olmadan canlı istek atılmaz).
// =========================================================
const enc = new TextEncoder();
async function hmac(key: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const livePaymentsAllowed = () => Deno.env.get("PAYMENTS_LIVE") === "true";

// ---------- iyzico ----------
export function iyzicoBase(env: string) { return env === "live" && livePaymentsAllowed() ? "https://api.iyzipay.com" : "https://sandbox-api.iyzipay.com"; }
// IYZWSv2: Authorization = "IYZWSv2 " + base64("apiKey:<k>&randomKey:<r>&signature:<hex(HMAC_SHA256(secret, r + uriPath + body))>")
export async function iyzicoAuth(apiKey: string, secret: string, uriPath: string, body: string, randomKey?: string) {
  const rnd = randomKey || (Date.now().toString() + Math.floor(Math.random() * 1e9));
  const sig = hex(await hmac(secret, rnd + uriPath + body));
  return { authorization: "IYZWSv2 " + btoa(`apiKey:${apiKey}&randomKey:${rnd}&signature:${sig}`), randomKey: rnd };
}
async function iyzicoPost(creds: any, env: string, path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const a = await iyzicoAuth(String(creds.api_key), String(creds.secret_key), path, body);
  const r = await fetch(iyzicoBase(env) + path, {
    method: "POST", body, signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: a.authorization, "x-iyzi-rnd": a.randomKey },
  });
  return await r.json().catch(() => ({ status: "failure", errorMessage: "HTTP " + r.status }));
}
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
export async function iyzicoInit(creds: any, env: string, c: any, callbackUrl: string, ip: string) {
  const [first, ...rest] = String(c.name || "Müşteri").trim().split(/\s+/);
  const addr = c.address || {};
  // Sepet kalemleri toplamı = price (iyzico şartı); indirim + kargo kalemlere dağıtılır
  const goods = (c.items || []).map((l: any) => ({ id: String(l.product_id) + (l.variant_id ? "-" + l.variant_id.slice(0, 8) : ""), name: String(l.name).slice(0, 100), category1: "Genel", itemType: "PHYSICAL", raw: l.unit_price * l.qty }));
  const sum = goods.reduce((s: number, g: any) => s + g.raw, 0);
  const target = Number(c.total);
  let acc = 0;
  const basketItems = goods.map((g: any, i: number) => {
    const p = i === goods.length - 1 ? Math.round((target - acc) * 100) / 100 : Math.round((g.raw / sum) * target * 100) / 100;
    acc += p;
    return { id: g.id, name: g.name, category1: g.category1, itemType: g.itemType, price: money(p) };
  }).filter((x: any) => Number(x.price) > 0);
  const req = {
    locale: "tr", conversationId: c.id, price: money(target), paidPrice: money(target), currency: c.currency === "TRY" ? "TRY" : c.currency,
    basketId: c.id, paymentGroup: "PRODUCT", callbackUrl, enabledInstallments: [1, 2, 3, 6, 9],
    buyer: {
      id: c.customer_id || c.id, name: first || "Müşteri", surname: rest.join(" ") || "-", gsmNumber: c.phone || "", email: c.email || "musteri@seltigo.local",
      identityNumber: "11111111111", registrationAddress: addr.text || "-", ip: ip || "85.34.78.112", city: addr.city || "Istanbul", country: "Turkey", zipCode: addr.zip || "",
    },
    shippingAddress: { contactName: c.name, city: addr.city || "Istanbul", country: "Turkey", address: addr.text || "-", zipCode: addr.zip || "" },
    billingAddress: { contactName: c.name, city: addr.city || "Istanbul", country: "Turkey", address: addr.text || "-", zipCode: addr.zip || "" },
    basketItems,
  };
  const d = await iyzicoPost(creds, env, "/payment/iyzipos/checkoutform/initialize/auth/ecom", req);
  if (d.status !== "success") return { ok: false, error: d.errorMessage || "iyzico ödeme formu açılamadı", raw: d };
  return { ok: true, token: d.token, url: d.paymentPageUrl, html: d.checkoutFormContent, raw: { token: d.token } };
}
export async function iyzicoRetrieve(creds: any, env: string, token: string, conversationId: string) {
  const d = await iyzicoPost(creds, env, "/payment/iyzipos/checkoutform/auth/ecom/detail", { locale: "tr", conversationId, token });
  return { ok: d.status === "success" && d.paymentStatus === "SUCCESS", paid: Number(d.paidPrice) || 0, basketId: d.basketId, paymentId: d.paymentId, raw: { status: d.status, paymentStatus: d.paymentStatus, errorMessage: d.errorMessage, paymentId: d.paymentId } };
}

// ---------- PayTR ----------
export async function paytrToken(creds: any, f: Record<string, string>) {
  const s = f.merchant_id + f.user_ip + f.merchant_oid + f.email + f.payment_amount + f.user_basket + f.no_installment + f.max_installment + f.currency + f.test_mode;
  return b64(await hmac(String(creds.merchant_key), s + String(creds.merchant_salt)));
}
export async function paytrInit(creds: any, env: string, c: any, okUrl: string, failUrl: string, ip: string) {
  const basket = btoa(unescape(encodeURIComponent(JSON.stringify((c.items || []).map((l: any) => [String(l.name).slice(0, 100), money(l.unit_price), l.qty])))));
  const f: Record<string, string> = {
    merchant_id: String(creds.merchant_id), user_ip: ip || "85.34.78.112", merchant_oid: String(c.id).replace(/-/g, ""), email: c.email || "musteri@seltigo.local",
    payment_amount: String(Math.round(Number(c.total) * 100)), user_basket: basket, no_installment: "0", max_installment: "0",
    currency: c.currency === "TRY" ? "TL" : c.currency, test_mode: env === "live" && livePaymentsAllowed() ? "0" : "1",
  };
  const form = new URLSearchParams({
    ...f, paytr_token: await paytrToken(creds, f), debug_on: env === "live" ? "0" : "1", lang: "tr",
    user_name: String(c.name || "").slice(0, 60), user_address: String(c.address?.text || "-").slice(0, 400), user_phone: String(c.phone || "").slice(0, 20),
    merchant_ok_url: okUrl, merchant_fail_url: failUrl, timeout_limit: "30",
  });
  const r = await fetch("https://www.paytr.com/odeme/api/get-token", { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => ({ status: "failed", reason: "HTTP " + r.status }));
  if (d.status !== "success") return { ok: false, error: d.reason || "PayTR ödeme sayfası açılamadı", raw: d };
  return { ok: true, token: d.token, url: `https://www.paytr.com/odeme/guvenli/${d.token}`, raw: { token: d.token } };
}
// Bildirim (callback) doğrulaması: hash = base64(HMAC_SHA256(merchant_key, merchant_oid + merchant_salt + status + total_amount))
export async function paytrVerify(creds: any, p: Record<string, string>) {
  const want = b64(await hmac(String(creds.merchant_key), String(p.merchant_oid) + String(creds.merchant_salt) + String(p.status) + String(p.total_amount)));
  return want === String(p.hash || "");
}
