// =========================================================
// Seltigo - store-admin: satıcının mağaza ayarları (oturum, gövdede userAccessToken)
//   { action: "settings" }                                  -> tema, SEO, kargo, ödeme, alan adları, ödeme hesapları, kuponlar
//   { action: "save", theme?, seo?, shipping_options?, checkout? }   (doğrulanır; tema okunabilirlik kontrolünden geçer)
//   { action: "design", prompt?, preset? }                  -> yapay zekâ ile tema (kaydedilmez; önizleme), hazır tema
//   { action: "payment_set", provider: iyzico|paytr, keys, environment? }  -> anahtarlar Vault'a, bağlantı denenir
//   { action: "payment_remove", provider }
//   { action: "domain_add", hostname } | { action: "domain_check", id } | { action: "domain_remove", id }
// Sistem (CRON_SECRET): { action: "domain_tick" } -> bekleyen alan adlarını denetle (10 dk)
// Kendi alan adı: Cloudflare for SaaS (CF_API_TOKEN + CF_ZONE_ID + STORE_EDGE_HOST secrets). Secret yoksa kayıt alınır,
// DNS kaydı gösterilir; servis açılınca domain_tick bekleyenleri otomatik bağlar. Domain Connect destekleyen DNS
// sağlayıcılarında tek tıkla bağlama bağlantısı (DOMAIN_CONNECT_PROVIDER_ID + DOMAIN_CONNECT_SERVICE_ID şablonu yayınlanınca).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
import { aiDesign, PRESETS, ruleDesign, sanitizeTheme } from "../_shared/store-theme.ts";
import { iyzicoAuth, iyzicoBase, paytrToken } from "../_shared/payments.ts";
import { dohQuery } from "../_shared/site-guard.ts";
import { DEFAULT_SHIPPING } from "../_shared/store-cart.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const env = (k: string) => Deno.env.get(k) ?? "";
const db = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (v: unknown, n: number) => String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const now = () => new Date().toISOString();

async function store(userId: string) {
  const { data } = await db.from("store_settings").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

// ---------- Ayarlar ----------
function cleanShipping(list: any): any[] {
  if (!Array.isArray(list)) return DEFAULT_SHIPPING;
  const out = list.slice(0, 6).map((s: any, i: number) => ({
    id: clean(s.id, 30).replace(/[^a-z0-9_-]/gi, "") || "k" + (i + 1), name: clean(s.name, 60) || "Kargo",
    price: Math.max(0, Math.round((Number(s.price) || 0) * 100) / 100), free_over: Number(s.free_over) > 0 ? Math.round(Number(s.free_over) * 100) / 100 : null, days: clean(s.days, 40),
  }));
  return out.length ? out : DEFAULT_SHIPPING;
}
function ibanOk(iban: string) {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^TR\d{24}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const d of r) m = (m * 10 + Number(d)) % 97;
  return m === 1;
}
async function save(userId: string, b: any) {
  const st = await store(userId);
  if (!st) return { ok: false, error: "Önce mağazanı kur" };
  const patch: any = { updated_at: now() };
  if (b.theme !== undefined) patch.theme = sanitizeTheme(b.theme, st.store_name);
  if (b.seo !== undefined) patch.seo = { title: clean(b.seo?.title, 70), description: clean(b.seo?.description, 160), keywords: clean(b.seo?.keywords, 200), og_image: /^https:\/\//.test(String(b.seo?.og_image || "")) ? String(b.seo.og_image).slice(0, 500) : "" };
  if (b.shipping_options !== undefined) patch.shipping_options = cleanShipping(b.shipping_options);
  if (b.checkout !== undefined) {
    const methods = (Array.isArray(b.checkout?.methods) ? b.checkout.methods : ["cod"]).filter((m: string) => ["cod", "bank_transfer", "iyzico", "paytr"].includes(m));
    const iban = String(b.checkout?.iban || "").replace(/\s+/g, "").toUpperCase();
    if (methods.includes("bank_transfer") && !ibanOk(iban)) return { ok: false, error: "IBAN geçersiz (TR ile başlayan 26 karakter)" };
    patch.checkout = { methods: methods.length ? methods : ["cod"], iban: iban || null, account_name: clean(b.checkout?.account_name, 80) || null, cod_fee: Math.max(0, Number(b.checkout?.cod_fee) || 0) };
  }
  const { data, error } = await db.from("store_settings").update(patch).eq("id", st.id).select("theme, seo, shipping_options, checkout").single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, ...data };
}
async function settings(userId: string) {
  const st = await store(userId);
  if (!st) return { ok: true, store: null };
  const [{ data: prov }, { data: doms }, { data: coupons }, { count: redirects }] = await Promise.all([
    db.from("store_payment_providers").select("provider, environment, enabled, verified_at, last_error").eq("user_id", userId),
    db.from("store_domains").select("*").eq("user_id", userId).neq("status", "removed").order("created_at", { ascending: false }),
    db.from("store_coupons").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    db.from("store_redirects").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);
  return {
    ok: true, store: { slug: st.store_slug, name: st.store_name, theme: sanitizeTheme(st.theme, st.store_name), seo: st.seo || {}, shipping_options: st.shipping_options?.length ? st.shipping_options : DEFAULT_SHIPPING, checkout: st.checkout || { methods: ["cod"] }, custom_domain: st.custom_domain },
    presets: Object.keys(PRESETS), providers: prov || [], domains: (doms || []).map((d: any) => ({ ...d, connect_url: connectUrl(d, d.hostname) })), coupons: coupons || [], redirects: redirects || 0,
    payment_notify_url: `${SUPABASE_URL}/functions/v1/store-checkout?provider=paytr`, edge: { configured: !!(env("CF_API_TOKEN") && env("CF_ZONE_ID") && env("STORE_EDGE_HOST")), host: env("STORE_EDGE_HOST") || null },
    features: {
      store_checkout: await featureEnabled(userId, "store_checkout"), store_payments: await featureEnabled(userId, "store_payments"),
      custom_domain: await featureEnabled(userId, "custom_domain"), store_ai_design: await featureEnabled(userId, "store_ai_design"), store_migrate: await featureEnabled(userId, "store_migrate"),
    },
  };
}
async function design(userId: string, b: any) {
  const st = await store(userId);
  if (!st) return { ok: false, error: "Önce mağazanı kur" };
  if (b.preset && PRESETS[b.preset]) return { ok: true, theme: sanitizeTheme({ ...PRESETS[b.preset], preset: b.preset, hero: st.theme?.hero || { title: st.store_name } }, st.store_name) };
  const { data: prods } = await db.from("products").select("name").eq("user_id", userId).is("deleted_at", null).order("id", { ascending: false }).limit(15);
  const sample = (prods || []).map((p: any) => String(p.name).slice(0, 60));
  const prompt = clean(b.prompt, 300);
  if (!(await featureEnabled(userId, "store_ai_design"))) return { ok: true, theme: ruleDesign(prompt, st.store_name, sample), note: FEATURE_OFF_MSG };
  const { data: quota } = await db.rpc("ai_quota_ok", { p_user: userId });
  if (quota === false) return { ok: true, theme: ruleDesign(prompt, st.store_name, sample), note: "Yapay zekâ kotan doldu; kurallı tasarım yapıldı." };
  const theme = await aiDesign(prompt, st.store_name, sample);
  if (theme.ai?.model && theme.ai.model !== "kurallı") await db.from("ai_usage_log").insert({ user_id: userId, fn: "store-admin:design", units: 1, ref: st.store_slug });
  return { ok: true, theme };
}

// ---------- Ödeme hesapları ----------
async function paymentSet(userId: string, b: any) {
  if (!(await featureEnabled(userId, "store_payments"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "store_payments" };
  const provider = b.provider === "paytr" ? "paytr" : b.provider === "iyzico" ? "iyzico" : null;
  if (!provider) return { ok: false, error: "Geçersiz ödeme sağlayıcısı" };
  const environment = b.environment === "live" ? "live" : "sandbox";
  const k = b.keys || {};
  const keys = provider === "iyzico" ? { api_key: clean(k.api_key, 120), secret_key: clean(k.secret_key, 120) } : { merchant_id: clean(k.merchant_id, 40), merchant_key: clean(k.merchant_key, 80), merchant_salt: clean(k.merchant_salt, 80) };
  if (Object.values(keys).some((v) => !v)) return { ok: false, error: "Tüm anahtar alanlarını doldur" };
  const test = await testKeys(provider, environment, keys);
  const { data: ex } = await db.from("store_payment_providers").select("secret_id").eq("user_id", userId).eq("provider", provider).maybeSingle();
  const { data: sid, error } = await db.rpc("seltigo_secret_set", { p_id: ex?.secret_id || null, p_name: "pay_" + provider, p_value: keys });
  if (error) return { ok: false, error: error.message };
  await db.from("store_payment_providers").upsert({ user_id: userId, provider, environment, secret_id: sid, enabled: test.ok, verified_at: test.ok ? now() : null, last_error: test.ok ? null : test.error, updated_at: now() });
  return { ok: test.ok, error: test.ok ? undefined : test.error, environment };
}
async function testKeys(provider: string, environment: string, k: any): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === "iyzico") {
      // Anahtar denemesi: BIN sorgusu (imzalı istek; anahtar yanlışsa iyzico reddeder)
      const path = "/payment/bin/check", body = JSON.stringify({ locale: "tr", conversationId: "seltigo-test", binNumber: "554960" });
      const a = await iyzicoAuth(k.api_key, k.secret_key, path, body);
      const r = await fetch(iyzicoBase(environment) + path, { method: "POST", body, headers: { "Content-Type": "application/json", Authorization: a.authorization, "x-iyzi-rnd": a.randomKey }, signal: AbortSignal.timeout(20000) });
      const d = await r.json().catch(() => ({}));
      return d.status === "success" ? { ok: true } : { ok: false, error: "iyzico anahtarları reddetti: " + clean(d.errorMessage || r.status, 120) };
    }
    // PayTR: en küçük token isteği; anahtar yanlışsa "paytr_token" hatası döner
    const f: Record<string, string> = { merchant_id: k.merchant_id, user_ip: "85.34.78.112", merchant_oid: "SELTIGOTEST" + Date.now(), email: "test@seltigo.local", payment_amount: "100",
      user_basket: btoa(JSON.stringify([["Deneme", "1.00", 1]])), no_installment: "1", max_installment: "0", currency: "TL", test_mode: "1" };
    const form = new URLSearchParams({ ...f, paytr_token: await paytrToken(k, f), debug_on: "1", user_name: "Deneme", user_address: "Deneme", user_phone: "05000000000",
      merchant_ok_url: "https://mustafabahsimb-eng.github.io/hizlisatici-ai/", merchant_fail_url: "https://mustafabahsimb-eng.github.io/hizlisatici-ai/", timeout_limit: "30", lang: "tr" });
    const r = await fetch("https://www.paytr.com/odeme/api/get-token", { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    return d.status === "success" ? { ok: true } : { ok: false, error: "PayTR anahtarları reddetti: " + clean(d.reason || r.status, 160) };
  } catch (e) { return { ok: false, error: "Bağlantı denenemedi: " + clean((e as Error).message, 120) }; }
}

// ---------- Kendi alan adı ----------
const TR_SUFFIX = /\.(com|net|org|gen|web|biz|info|av|k12|tv|bel|pol|edu|gov|name|tel)\.tr$/i;
function apexOf(host: string) { const p = host.split("."); return p.slice(TR_SUFFIX.test(host) ? -3 : -2).join("."); }
// Seltigo'nun kendi sunucu adresleri (Pages, Supabase, mağaza sunucusu) bağlanamaz
function hostOk(h: string) {
  const edge = env("STORE_EDGE_HOST").toLowerCase();
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(h) && !/(\.github\.io|\.supabase\.co)$/i.test(h) && !(edge && (h === edge || h.endsWith("." + apexOf(edge))));
}
async function cf(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${env("CF_API_TOKEN")}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000) });
  return await r.json().catch(() => ({ success: false, errors: [{ message: "HTTP " + r.status }] }));
}
const edgeOn = () => !!(env("CF_API_TOKEN") && env("CF_ZONE_ID") && env("STORE_EDGE_HOST"));
async function domainConnect(apex: string) {
  const txt = (await dohQuery(`_domainconnect.${apex}`, "TXT"))[0];
  if (!txt) return null;
  try {
    const r = await fetch(`https://${txt.replace(/\/+$/, "")}/v2/${apex}/settings`, { signal: AbortSignal.timeout(10000) });
    const s = await r.json();
    if (!s?.urlSyncUX) return null;
    return { provider_id: s.providerId, provider_name: s.providerDisplayName || s.providerName, url_sync_ux: s.urlSyncUX };
  } catch { return null; }
}
function connectUrl(d: any, host: string) {
  const pid = env("DOMAIN_CONNECT_PROVIDER_ID"), sid = env("DOMAIN_CONNECT_SERVICE_ID");
  if (!d?.domain_connect?.url_sync_ux || !pid || !sid || !env("STORE_EDGE_HOST")) return null;
  const apex = apexOf(host), sub = host.slice(0, host.length - apex.length).replace(/\.$/, "");
  return `${d.domain_connect.url_sync_ux}/v2/domainTemplates/providers/${pid}/services/${sid}/apply?domain=${apex}&host=${encodeURIComponent(sub)}&target=${encodeURIComponent(env("STORE_EDGE_HOST"))}`;
}
async function cfCreate(d: any) {
  const r = await cf(`/zones/${env("CF_ZONE_ID")}/custom_hostnames`, { method: "POST", body: JSON.stringify({ hostname: d.hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } }) });
  if (!r.success) return { error: clean(r.errors?.[0]?.message || "Cloudflare hatası", 200) };
  return { id: r.result.id, ownership: r.result.ownership_verification || null };
}
function records(d: any, ownership: any = null) {
  const target = env("STORE_EDGE_HOST") || "(Seltigo mağaza sunucusu açılınca burada görünecek)";
  const apex = apexOf(d.hostname);
  const out: any[] = [{ type: "CNAME", name: d.hostname === apex ? "@" : d.hostname.slice(0, -apex.length - 1), value: target }];
  if (ownership?.name) out.push({ type: ownership.type?.toUpperCase() || "TXT", name: ownership.name, value: ownership.value });
  return out;
}
async function domainAdd(userId: string, b: any) {
  if (!(await featureEnabled(userId, "custom_domain"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "custom_domain" };
  const st = await store(userId);
  if (!st) return { ok: false, error: "Önce mağazanı kur" };
  let host = clean(b.hostname, 253).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!hostOk(host)) return { ok: false, error: "Geçerli bir alan adı yaz (ör. www.markam.com)" };
  const apex = apexOf(host);
  let note = "";
  // Kök alan adı (markam.com): CNAME çoğu sağlayıcıda kökte olmaz -> www kullanılır, kök www'ye yönlendirilir
  if (host === apex) { host = "www." + host; note = `Kök alan adı (${apex}) yerine ${host} bağlanır; ${apex} adresini DNS sağlayıcında ${host} adresine yönlendir (çoğu sağlayıcıda "yönlendirme / forwarding").`; }
  const { data: taken } = await db.from("store_domains").select("id, user_id").ilike("hostname", host).neq("status", "removed").maybeSingle();
  if (taken && taken.user_id !== userId) return { ok: false, error: "Bu alan adı başka bir mağazaya bağlı" };
  if (taken) return { ok: true, domain: taken, already: true };
  const ns = await dohQuery(apex, "NS");
  const dc = await domainConnect(apex);
  const ins: any = { user_id: userId, store_slug: st.store_slug, hostname: host, status: "pending_dns", provider: ns[0] ? ns[0].replace(/\.$/, "").split(".").slice(-2).join(".") : null, domain_connect: dc, method: dc ? "domain_connect" : "manual", error: note || null };
  if (edgeOn()) {
    const c = await cfCreate(ins);
    if (c.error) return { ok: false, error: c.error };
    ins.cf_hostname_id = c.id;
    ins.records = records(ins, c.ownership);
  } else ins.records = records(ins);
  const { data, error } = await db.from("store_domains").insert(ins).select("*").single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, domain: data, connect_url: connectUrl(data, host), edge_ready: edgeOn(), note };
}
async function domainCheck(d: any) {
  const patch: any = { last_check_at: now() };
  if (!edgeOn()) { patch.error = "Seltigo mağaza sunucusu henüz açılmadı; açılınca bu alan adı otomatik bağlanacak."; await db.from("store_domains").update(patch).eq("id", d.id); return { ...d, ...patch }; }
  if (!d.cf_hostname_id) {
    const c = await cfCreate(d);
    if (c.error) { patch.error = c.error; await db.from("store_domains").update(patch).eq("id", d.id); return { ...d, ...patch }; }
    patch.cf_hostname_id = c.id; patch.records = records(d, c.ownership); d.cf_hostname_id = c.id;
  }
  const cname = await dohQuery(d.hostname, "CNAME");
  const pointed = cname.some((x) => x.replace(/\.$/, "").toLowerCase() === env("STORE_EDGE_HOST").toLowerCase());
  const r = await cf(`/zones/${env("CF_ZONE_ID")}/custom_hostnames/${d.cf_hostname_id}`);
  const res = r.result || {};
  patch.ssl_status = res.ssl?.status || null;
  if (res.status === "active" && res.ssl?.status === "active") {
    Object.assign(patch, { status: "active", verified_at: d.verified_at || now(), error: null });
    await db.from("store_settings").update({ custom_domain: d.hostname }).eq("user_id", d.user_id);
  } else {
    patch.status = pointed ? "verifying" : "pending_dns";
    patch.error = pointed ? `DNS doğru; SSL sertifikası hazırlanıyor (${res.ssl?.status || "bekliyor"}).` : `DNS kaydı henüz görünmüyor: ${d.hostname} için CNAME → ${env("STORE_EDGE_HOST")}`;
  }
  await db.from("store_domains").update(patch).eq("id", d.id);
  return { ...d, ...patch };
}
async function domainTick() {
  const { data } = await db.from("store_domains").select("*").in("status", ["pending_dns", "verifying"]).lt("created_at", now()).order("last_check_at", { ascending: true, nullsFirst: true }).limit(30);
  const out = [];
  for (const d of data || []) out.push({ host: d.hostname, status: (await domainCheck(d)).status });
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "domain_tick") return json({ ok: true, checked: await domainTick() });
      return json({ error: "Geçersiz işlem" }, 400);
    }
    const token = String(b?.userAccessToken || "").trim();
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    switch (b.action) {
      case "settings": return json(await settings(userId));
      case "save": return json(await save(userId, b));
      case "design": return json(await design(userId, b));
      case "payment_set": return json(await paymentSet(userId, b));
      case "payment_remove":
        await db.from("store_payment_providers").update({ enabled: false, updated_at: now() }).eq("user_id", userId).eq("provider", String(b.provider));
        return json({ ok: true });
      case "domain_add": return json(await domainAdd(userId, b));
      case "domain_check": {
        const { data: d } = await db.from("store_domains").select("*").eq("id", String(b.id || "")).eq("user_id", userId).maybeSingle();
        if (!d) return json({ ok: false, error: "Alan adı bulunamadı" });
        const r = await domainCheck(d);
        return json({ ok: true, domain: r, connect_url: connectUrl(r, r.hostname) });
      }
      case "domain_remove": {
        const { data: d } = await db.from("store_domains").select("*").eq("id", String(b.id || "")).eq("user_id", userId).maybeSingle();
        if (!d) return json({ ok: false, error: "Alan adı bulunamadı" });
        if (d.cf_hostname_id && edgeOn()) await cf(`/zones/${env("CF_ZONE_ID")}/custom_hostnames/${d.cf_hostname_id}`, { method: "DELETE" });
        await db.from("store_domains").update({ status: "removed" }).eq("id", d.id);
        await db.from("store_settings").update({ custom_domain: null }).eq("user_id", userId).eq("custom_domain", d.hostname);
        return json({ ok: true });
      }
      default: return json({ ok: false, error: "Geçersiz işlem" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: clean((e as Error).message, 300) }, 500);
  }
});
