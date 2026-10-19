// =========================================================
// "Link ver, mağazan hazır": satıcının site adresi -> tüm ürünler -> Seltigo mağazası hazır -> diğer kanallara gönder
// Satıcı (oturum, gövdede userAccessToken):
//   { action: "start", siteUrl, consent? }   -> mağaza (yoksa) açılır, "Web sitem" kaydedilir, iş arka planda başlar -> { jobId, storeSlug }
//   { action: "distribute", jobId, channels } -> çekilen ürünler seçilen kanallara (pazaryeri bağlantıları -> ilan + senkron kuyruğu,
//                                                 "instagram" -> paylaşım kuyruğu, aralıklı). WhatsApp kataloğunu sayfa social-catalog ile gönderir.
//   { action: "channels" }                    -> gönderilebilecek bağlı kanallar
// Sistem (CRON_SECRET): { action: "continue", jobId } -> işe devam (zaman sınırı dolunca fonksiyon kendini yeniden çağırır)
// İlerleme: site_import_jobs (panel okur). Ürün okuma product-import, kayıt product-ingest (Kendi stoğum, mağazada yayında).
// HIZ: ürün sayfaları 6'şar paralel okunur, 20'şer kaydedilir; ilan önce açılır, eksik görseller arka planda tamamlanır.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { channelIdsFromDefaults, connectedChannels, distributeProducts } from "../_shared/distribute.ts";

import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);

const MAX_PRODUCTS = 1000;
const TIME_BUDGET_MS = 110_000;
const PARALLEL = 6;
const SAVE_BATCH = 20;

async function fn(name: string, userId: string, payload: Record<string, unknown>, timeout = 60000): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ ...payload, cronSecret: CRON_SECRET, userId }), signal: AbortSignal.timeout(timeout),
  });
  return await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}
function background(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p.catch((e) => console.error("site-store", String(e))));
}
// İşe kendi kendine devam (yeni istek = yeni zaman sınırı)
function continueLater(jobId: string) {
  background(fetch(`${SUPABASE_URL}/functions/v1/site-store`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ action: "continue", jobId, cronSecret: CRON_SECRET }),
  }).then((r) => r.body?.cancel()));
}

function normalizeUrl(raw: string): URL | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) return null;
    return u;
  } catch { return null; }
}
function slugify(text: string) {
  const m: Record<string, string> = { "ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u", "Ç": "c", "Ğ": "g", "İ": "i", "Ö": "o", "Ş": "s", "Ü": "u" };
  return text.split("").map((c) => m[c] || c).join("").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "magazam";
}
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

// Site adı ve logosu (mağaza adı / logo boşsa)
async function siteInfo(u: URL): Promise<{ name: string; logo: string | null }> {
  try {
    const r = await fetch(u.origin + "/", { headers: { "User-Agent": "Mozilla/5.0 (compatible; SeltigoBot/1.0)" }, signal: AbortSignal.timeout(12000) });
    const html = (await r.text()).slice(0, 400_000);
    const meta = (p: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)`, "i"))?.[1]
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, "i"))?.[1];
    const title = meta("og:site_name") || html.match(/<title[^>]*>([^<]{1,120})/i)?.[1] || "";
    const name = decode(title).split(/\s[|\-–—]\s/)[0].trim() || u.hostname.replace(/^www\./, "");
    const icon = html.match(/<link[^>]+rel=["'](?:apple-touch-icon|icon|shortcut icon)["'][^>]+href=["']([^"']+)/i)?.[1] || meta("og:image") || null;
    const logo = icon ? new URL(decode(icon), u.origin).href : null;
    return { name: name.slice(0, 60), logo: logo && /^https:\/\//.test(logo) ? logo : null };
  } catch {
    return { name: u.hostname.replace(/^www\./, ""), logo: null };
  }
}

async function ensureStore(userId: string, u: URL) {
  const { data: st } = await db.from("store_settings").select("id, store_slug, store_name, business_logo_url").eq("user_id", userId).maybeSingle();
  if (st) {
    await db.from("store_settings").update({ website_url: u.origin, updated_at: new Date().toISOString() }).eq("id", st.id);
    return st.store_slug;
  }
  const info = await siteInfo(u);
  let slug = slugify(info.name);
  const { data: taken } = await db.from("store_settings").select("id").eq("store_slug", slug).maybeSingle();
  if (taken) slug = `${slug}-${Math.floor(1000 + Math.random() * 9000)}`;
  const { error } = await db.from("store_settings").insert({ user_id: userId, store_slug: slug, store_name: info.name, business_logo_url: info.logo, website_url: u.origin });
  if (error) throw error;
  return slug;
}

// ---------------- İşin gövdesi ----------------
async function run(jobId: string) {
  const started = Date.now();
  const { data: job } = await db.from("site_import_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job || job.status === "done" || job.status === "error") return;
  const save = (f: Record<string, unknown>) => db.from("site_import_jobs").update({ ...f, updated_at: new Date().toISOString() }).eq("id", jobId);
  await save({ status: "running" });
  let links: string[] = Array.isArray(job.links) ? job.links : [];
  let next: string | null = job.next_page;
  let total = job.total, done = job.done, failed = job.failed;
  const ids: number[] = [...(job.product_ids || [])];
  const userId = job.user_id;
  const known = new Set<string>();
  // Daha önce eklenmiş sayfalar (aynı ürün iki kez eklenmesin)
  const { data: ex } = await db.from("products").select("source_url").eq("user_id", userId).not("source_url", "is", null).is("deleted_at", null).limit(5000);
  (ex || []).forEach((p: any) => known.add(String(p.source_url)));

  const pending: any[] = [];
  const flush = async () => {
    while (pending.length) {
      const chunk = pending.splice(0, SAVE_BATCH);
      const r = await fn("product-ingest", userId, { items: chunk, sourceUrl: job.site_url, via: "site", publish: true, aeSource: "own", consent: true, imageTerms: true }, 120000);
      if (r?.ok) { (r.products || []).forEach((p: any) => ids.push(Number(p.id))); done += (r.products || []).length; failed += chunk.length - (r.products || []).length; }
      else failed += chunk.length;
      await save({ done, failed, product_ids: ids });
    }
  };

  try {
    // 1) Keşif: ilk istek siteyi okur (Shopify / WooCommerce beslemesi, site haritası, liste sayfası ya da tek ürün)
    if (!links.length && (next || done + failed === 0)) {
      while (Date.now() - started < TIME_BUDGET_MS && ids.length + pending.length < MAX_PRODUCTS) {
        const r = await fn("product-import", userId, { url: next || job.site_url, language: "tr" }, 90000);
        if (r?.error && !r?.kind) throw new Error(r.error);
        if (r.kind === "feed") {
          const items = (r.items || []).filter((i: any) => i?.name && !known.has(String(i.url || "")));
          pending.push(...items.slice(0, MAX_PRODUCTS - ids.length - pending.length));
          total += items.length;
          next = r.next_page || null;
          await save({ total, next_page: next });
          await flush();
          if (!next) break;
        } else if (r.kind === "category") {
          const fresh = (r.links || []).filter((l: string) => !known.has(l) && !links.includes(l));
          links.push(...fresh);
          total += fresh.length;
          next = r.next_page || null;
          await save({ total, links, next_page: next });
          if (!next || links.length >= MAX_PRODUCTS) break;
        } else if (r.kind === "product" && r.item) {
          if (!known.has(String(r.item.url || ""))) { pending.push(r.item); total += 1; }
          next = null;
          await save({ total, next_page: null });
          await flush();
          break;
        } else break;
      }
      links = links.slice(0, MAX_PRODUCTS);
      if (next && Date.now() - started >= TIME_BUDGET_MS) { await save({ links, next_page: next, total, done, failed, product_ids: ids }); continueLater(jobId); return; }
      next = null;
      await save({ links, next_page: null });
    }

    // 2) Ürün sayfaları: paralel oku, toplu kaydet
    while (links.length && Date.now() - started < TIME_BUDGET_MS) {
      const batch = links.splice(0, PARALLEL);
      const results = await Promise.all(batch.map((l) => fn("product-import", userId, { url: l, language: "tr" }, 60000).catch(() => null)));
      results.forEach((r) => { if (r?.kind === "product" && r.item?.name) pending.push(r.item); else failed++; });
      if (pending.length >= SAVE_BATCH || !links.length) await flush();
      await save({ links, failed });
    }
    await flush();
    if (links.length) { await save({ links, done, failed, product_ids: ids }); continueLater(jobId); return; }
    await save({ status: "done", links: [], done, failed, total: Math.max(total, done + failed), product_ids: ids, finished_at: new Date().toISOString() });
    if (ids.length) await db.rpc("assistant_enqueue", { p_user: userId, p_kind: "site_import", p_payload: { count: ids.length, site: job.site_url, slug: job.store_slug }, p_dedupe: "site:" + jobId });
  } catch (e) {
    await flush().catch(() => null);
    await save({ status: ids.length ? "done" : "error", error: short((e as Error).message), done, failed, product_ids: ids, finished_at: new Date().toISOString() });
  }
}

// ---------------- Diğer kanallara gönder ----------------
async function distribute(userId: string, b: any) {
  if (!(await featureEnabled(userId, "multi_channel"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "multi_channel" };
  const { data: job } = await db.from("site_import_jobs").select("id, product_ids, status").eq("id", String(b.jobId || "")).eq("user_id", userId).maybeSingle();
  if (!job) return { ok: false, error: "İş bulunamadı" };
  const want: string[] = Array.isArray(b.channels) ? b.channels.map(String) : [];
  const out = await distributeProducts(db, userId, (job.product_ids || []).map(Number), want);
  if (!Object.keys(out).length && !want.length) return { ok: false, error: "Gönderilecek ürün yok" };
  await db.from("site_import_jobs").update({ distributed: { ...out, at: new Date().toISOString() } }).eq("id", job.id);
  return { ok: true, result: out, whatsappCatalog: false };
}

// Panelden eklenen ürünleri satıcının kanallarına gönder (linkten / dosyadan yükleme "Gönderilecek kanallar").
// channels: "mp:<bağlantı>" kimlikleri; yoksa defaults (asistan ayarındaki varsayılan kanal adları: amazon, trendyol ...) bağlı kanallara çevrilir.
async function sendProducts(userId: string, b: any) {
  if (!(await featureEnabled(userId, "multi_channel"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "multi_channel" };
  const ids = (Array.isArray(b.productIds) ? b.productIds : []).map(Number).filter((n: number) => n > 0).slice(0, 500);
  if (!ids.length) return { ok: false, error: "Gönderilecek ürün yok" };
  let want: string[] = Array.isArray(b.channels) ? b.channels.map(String) : [];
  if (!want.length && Array.isArray(b.defaults)) want = channelIdsFromDefaults(await connectedChannels(db, userId), b.defaults.map(String)).ids;
  if (!want.length) return { ok: true, result: {}, note: "Kanal seçilmedi" };
  return { ok: true, result: await distributeProducts(db, userId, ids, want) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "continue" && b.jobId) { background(run(String(b.jobId))); return json({ ok: true }); }
      if (b.action === "start" && b.userId) return json(await start(String(b.userId), b));
      if (b.action === "distribute" && b.userId) return json(await distribute(String(b.userId), b));
      return json({ error: "Geçersiz işlem" }, 400);
    }
    const token = String(b?.userAccessToken || "").trim();
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    if (b.action === "start") return json(await start(userId, b));
    if (b.action === "distribute") return json(await distribute(userId, b));
    if (b.action === "channels") return json({ ok: true, ...(await connectedChannels(db, userId)) });
    if (b.action === "send_products") return json(await sendProducts(userId, b));
    return json({ error: "Geçersiz işlem" }, 400);
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});

async function start(userId: string, b: any) {
  if (!(await featureEnabled(userId, "site_import"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "site_import" };
  const u = normalizeUrl(b.siteUrl);
  if (!u) return { ok: false, error: "Geçerli bir web sitesi adresi yaz (ör. www.siten.com)." };
  // Görsel kullanım onayı (ilk kullanım): daha önce verilmediyse bu istekte verilmeli
  const { data: prof } = await db.from("user_profiles").select("image_terms_accepted_at").eq("user_id", userId).maybeSingle();
  if (!prof?.image_terms_accepted_at && b.consent !== true) return { ok: false, needConsent: true, error: "Görsel kullanım onayı gerekli" };
  const { data: running } = await db.from("site_import_jobs").select("id").eq("user_id", userId).in("status", ["queued", "running"])
    .gt("updated_at", new Date(Date.now() - 10 * 60_000).toISOString()).maybeSingle();
  if (running) return { ok: true, jobId: running.id, already: true };
  const slug = await ensureStore(userId, u);
  const { data: job, error } = await db.from("site_import_jobs").insert({ user_id: userId, site_url: u.href, store_slug: slug }).select("id").single();
  if (error) throw error;
  background(run(job.id));
  return { ok: true, jobId: job.id, storeSlug: slug };
}
