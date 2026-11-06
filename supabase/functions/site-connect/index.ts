// =========================================================
// Seltigo - site-connect: satıcının KENDİ sitesini bağlama (altyapısı ne olursa olsun)
// Satıcı (oturum, gövdede userAccessToken):
//   { action: "detect", url, purpose? }        -> altyapı tespiti + ürün akışı keşfi + bağlantı kaydı (doğrulama kodu)
//   { action: "verify", id, method? }          -> sahiplik doğrulaması (meta / dns / file); doğrulanmadan aktarım başlamaz
//   { action: "import", id }                   -> aktarım (kuyrukta parça parça); { action: "sync_now", id } aynı (eşitleme)
//   { action: "set", id, feed_url?, auto_sync?, sync_hours?, webhook_url?, webhook_events? }
//   { action: "status" , id? }                 -> bağlantılar + son işler (ilerleme çubuğu)
//   { action: "api_key", id }                  -> "Seltigo bağlantı kodu" API anahtarı (yalnız bir kez gösterilir; yenisi eskisini geçersiz kılar)
//   { action: "webhook_secret", id }           -> webhook imza anahtarı (bir kez gösterilir)
//   { action: "webhook_test", id }             -> siteye deneme olayı (ping)
//   { action: "delete", id }                   -> bağlantıyı kaldır (ürünler kalır, eşitleme durur)
// Sistem (CRON_SECRET):
//   { action: "run", jobId }                   -> sync-worker'dan gelen parça (discover / page / items / pages / finish)
//   { action: "tick" }                         -> zamanı gelen bağlantılarda eşitleme başlat (pg_cron, 10 dk)
//   { action: "webhooks" }                     -> bekleyen webhook olaylarını gönder (pg_cron, 1 dk)
// Okuma yolu (en iyiden): 1) resmi API (Hesaplarım'da bağlı Shopify / WooCommerce / Wix), 2) ürün akışı (Google Merchant /
//   XML / CSV), 3) tarama: site haritası -> ürün sayfaları (product-import: schema.org JSON-LD, OpenGraph, mikroveri,
//   gerekirse yapay zekâ). robots.txt'e uyulur, istekler aralıklı (aynı siteye eşzamanlı tek parça), iç ağa istek yok.
// Kayıt: product-ingest (dedupe: barkod > kaynak linki > SKU; Kendi Mağazam'da yayında; perakende fiyat = sitedeki fiyat).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
import {
  allowedByRobots, assertPublicHost, detectPlatform, feedCandidates, hmacHex, looksLikeProductFeed, normalizeSite,
  PLATFORM_INFO, randomToken, robotsFor, safeFetch, sha256Hex, verifyOwnership, VERIFY_FILE, VERIFY_META, VERIFY_TXT_PREFIX,
} from "../_shared/site-guard.ts";
import { csvItems, parseCsv, shopifyAdminPage, wixStoresPage, wooRestPage } from "../_shared/site-platforms.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SITE = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";
const MAX_PRODUCTS = 5000;
const ITEMS_PER_CHUNK = 25;     // akış / API öğeleri bir parçada kaydedilir
const LINKS_PER_CHUNK = 8;      // taranan sayfalar bir parçada (aralıklı okunur)
const CHUNK_SPACING_S = 12;     // aynı siteye parçalar arası (eşzamanlı istek yok)

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const now = () => new Date().toISOString();

async function fn(name: string, userId: string, payload: Record<string, unknown>, timeout = 90000): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ ...payload, cronSecret: CRON_SECRET, userId }), signal: AbortSignal.timeout(timeout),
  });
  return await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}
function background(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  const q = p.catch((e) => console.error("site-connect", String(e)));
  if (rt?.waitUntil) rt.waitUntil(q);
}
async function enqueue(userId: string, payloads: Record<string, unknown>[], spacingS = 0, priority = 5) {
  if (!payloads.length) return;
  const t = Date.now();
  const { error } = await db.from("sync_jobs").insert(payloads.map((p, i) => ({
    user_id: userId, job_type: "site_connect", payload: p, status: "queued", priority, max_attempts: 3,
    run_after: new Date(t + i * spacingS * 1000).toISOString(),
  })));
  if (error) throw new Error("Kuyruk: " + error.message);
  background(fetch(`${SUPABASE_URL}/functions/v1/sync-worker`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ cronSecret: CRON_SECRET, chained: true }),
  }).then((r) => r.body?.cancel()));
}
const getConn = async (id: string, userId?: string) => {
  let q = db.from("site_connections").select("*").eq("id", id).is("deleted_at", null);
  if (userId) q = q.eq("user_id", userId);
  return (await q.maybeSingle()).data;
};
const publicConn = (c: any) => {
  const { api_key_hash: _h, webhook_secret_id: _w, ...rest } = c || {};
  return { ...rest, has_api_key: !!c?.api_key_hash, has_webhook_secret: !!c?.webhook_secret_id };
};
function verifyHelp(c: any) {
  const base = c.origin + c.scope_path;
  return {
    meta: `<meta name="${VERIFY_META}" content="${c.verify_token}">`,
    meta_where: base,
    dns: c.scope_path === "/" ? { type: "TXT", name: `_seltigo.${c.host}`, value: VERIFY_TXT_PREFIX + c.verify_token, alt: { name: c.host, value: VERIFY_TXT_PREFIX + c.verify_token } } : null,
    file: { url: base + VERIFY_FILE, content: c.verify_token },
  };
}

// ---------- Tespit ----------
async function detect(userId: string, b: any) {
  if (!(await featureEnabled(userId, "site_connect"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "site_connect" };
  const ref = normalizeSite(b.url);
  if (!ref) return { ok: false, error: "Geçerli bir web sitesi adresi yaz (ör. www.siten.com)." };
  const { data: lim } = await db.rpc("rate_hit", { p_key: "sitec:d:" + userId, p_limit: 30, p_window_seconds: 3600 });
  if (lim === false) return { ok: false, error: "Çok sık denedin; biraz sonra tekrar dene." };
  try { await assertPublicHost(new URL(ref.url).hostname); } catch (e) { return { ok: false, error: (e as Error).message }; }
  let home;
  try { home = await safeFetch(ref.origin + ref.scopePath, { maxBytes: 2_000_000, noPace: true }); }
  catch (e) { return { ok: false, error: "Site açılamadı: " + (e as Error).message }; }
  if (home.status >= 400) return { ok: false, error: `Site açılamadı (HTTP ${home.status}).` };
  const { platform, evidence } = detectPlatform(home.text, home.headers);
  const robots = await robotsFor(ref.origin);
  const blocked = !robotsAllowsRoot(robots.rules, ref.scopePath);

  // Ürün akışı (ilk bulunan; en fazla 6 aday hızlıca denenir)
  let feed: string | null = null;
  if (b.feed_url) feed = await checkFeed(String(b.feed_url));
  if (!feed) {
    for (const f of feedCandidates(home.text, ref.origin, platform, home.url).slice(0, 6)) {
      feed = await checkFeed(f, 400_000).catch(() => null);
      if (feed) break;
    }
  }
  // Hesaplarım'da bağlı resmi API (aynı site)
  const { data: conns } = await db.from("store_connections").select("id, marketplace_code, external_seller_id, status, settings")
    .eq("user_id", userId).in("marketplace_code", ["shopify", "woocommerce", "wix"]).is("deleted_at", null);
  const api = (conns || []).find((c: any) => c.marketplace_code === platform && c.status !== "error" &&
    (platform === "wix" || String(c.external_seller_id || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").startsWith(ref.host) ||
      (platform === "shopify" && /myshopify\.com$/.test(String(c.external_seller_id)))));
  const method = api ? "api" : feed ? "feed" : "crawl";

  const { data: ex } = await db.from("site_connections").select("*").eq("user_id", userId).eq("host", ref.host).eq("scope_path", ref.scopePath).is("deleted_at", null).maybeSingle();
  const fields = {
    url: ref.url, origin: ref.origin, platform, platform_evidence: evidence, method, feed_url: feed, store_connection_id: api?.id || null,
    purpose: b.purpose === "migrate" ? "migrate" : (ex?.purpose || "connect"), updated_at: now(),
  };
  let conn;
  if (ex) conn = (await db.from("site_connections").update(fields).eq("id", ex.id).select("*").single()).data;
  else {
    const ins = await db.from("site_connections").insert({ user_id: userId, host: ref.host, scope_path: ref.scopePath, verify_token: "slt-" + randomToken(12), ...fields }).select("*").single();
    if (ins.error) return { ok: false, error: ins.error.message };
    conn = ins.data;
  }
  return {
    ok: true, connection: publicConn(conn), platform: { code: platform, ...PLATFORM_INFO[platform], evidence },
    method, feed, api_connection: api ? { id: api.id, marketplace: api.marketplace_code } : null,
    robots: { blocked, crawl_delay: robots.delay, sitemaps: robots.sitemaps.slice(0, 5) },
    verify: verifyHelp(conn), verified: !!conn.verified_at,
  };
}
function robotsAllowsRoot(rules: { allow: boolean; path: string }[], scope: string) {
  return !rules.some((r) => !r.allow && (r.path === "/" || r.path === scope)) || rules.some((r) => r.allow && r.path.length > 1);
}
async function checkFeed(raw: string, maxBytes = 2_000_000): Promise<string | null> {
  const ref = normalizeSite(raw);
  if (!ref) return null;
  try {
    const r = await safeFetch(ref.url, { accept: "application/xml,text/xml,text/csv,text/plain,*/*", maxBytes, timeout: 15000, noPace: true });
    return r.status === 200 && looksLikeProductFeed(r.text) ? r.url : null;
  } catch { return null; }
}

// ---------- Doğrulama ----------
async function verify(userId: string, b: any) {
  const c = await getConn(String(b.id || ""), userId);
  if (!c) return { ok: false, error: "Bağlantı bulunamadı" };
  if (c.verified_at) return { ok: true, verified: true, method: c.verify_method, connection: publicConn(c) };
  const { data: lim } = await db.rpc("rate_hit", { p_key: "sitec:v:" + c.id, p_limit: 30, p_window_seconds: 3600 });
  if (lim === false) return { ok: false, error: "Çok sık denedin; birkaç dakika sonra tekrar dene." };
  const only = ["meta", "dns", "file"].includes(b.method) ? b.method : undefined;
  const r = await verifyOwnership({ url: c.url, origin: c.origin, host: c.host, scopePath: c.scope_path }, c.verify_token, only);
  const patch: any = { verify_checked_at: now(), verify_error: r.ok ? null : short(r.detail, 400), updated_at: now() };
  if (r.ok) Object.assign(patch, { verified_at: now(), verify_method: r.method, status: "verified" });
  const { data } = await db.from("site_connections").update(patch).eq("id", c.id).select("*").single();
  return { ok: r.ok, verified: r.ok, method: r.method, detail: r.detail, connection: publicConn(data), verify: verifyHelp(c) };
}

// ---------- Aktarım / eşitleme başlat ----------
async function startRun(c: any, kind: "import" | "sync") {
  const { data: running } = await db.from("site_sync_runs").select("id").eq("connection_id", c.id).in("status", ["queued", "discover", "running"])
    .gt("created_at", new Date(Date.now() - 6 * 3600_000).toISOString()).maybeSingle();
  if (running) return { ok: true, runId: running.id, already: true };
  const { data: run, error } = await db.from("site_sync_runs").insert({ connection_id: c.id, user_id: c.user_id, kind, status: "queued", source: c.method || "crawl" }).select("id").single();
  if (error) throw error;
  await db.from("site_connections").update({ status: "importing", updated_at: now() }).eq("id", c.id);
  await enqueue(c.user_id, [{ connectionId: c.id, runId: run.id, step: "discover" }], 0, 4);
  return { ok: true, runId: run.id };
}
async function startImport(userId: string, b: any) {
  if (!(await featureEnabled(userId, "site_connect"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "site_connect" };
  const c = await getConn(String(b.id || ""), userId);
  if (!c) return { ok: false, error: "Bağlantı bulunamadı" };
  if (!c.verified_at) return { ok: false, needVerify: true, error: "Önce sitenin sana ait olduğunu doğrula (meta etiketi, DNS kaydı ya da dosya)." };
  if (c.purpose === "migrate" && !(await featureEnabled(userId, "store_migrate"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "store_migrate" };
  const { data: prof } = await db.from("user_profiles").select("image_terms_accepted_at").eq("user_id", userId).maybeSingle();
  if (!prof?.image_terms_accepted_at) {
    if (b.consent !== true) return { ok: false, needConsent: true, error: "Görsel kullanım onayı gerekli" };
    await db.from("user_profiles").update({ image_terms_accepted_at: now() }).eq("user_id", userId);
  }
  // Mağaza yoksa açılır (ürünler Kendi Mağazam'da yayında olacak)
  await ensureStore(userId, c);
  return await startRun(c, b.action === "sync_now" ? "sync" : "import");
}
function slugify(text: string) {
  const m: Record<string, string> = { "ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u", "Ç": "c", "Ğ": "g", "İ": "i", "Ö": "o", "Ş": "s", "Ü": "u" };
  return text.split("").map((ch) => m[ch] || ch).join("").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "magazam";
}
async function ensureStore(userId: string, c: any) {
  const { data: st } = await db.from("store_settings").select("id, store_slug, website_url").eq("user_id", userId).maybeSingle();
  if (st) {
    if (!st.website_url && c.purpose === "connect") await db.from("store_settings").update({ website_url: c.origin }).eq("id", st.id);
    return st.store_slug;
  }
  let slug = slugify(c.host.split(".")[0]);
  const { data: taken } = await db.from("store_settings").select("id").eq("store_slug", slug).maybeSingle();
  if (taken) slug = `${slug}-${Math.floor(1000 + Math.random() * 9000)}`;
  await db.from("store_settings").insert({ user_id: userId, store_slug: slug, store_name: c.host, website_url: c.purpose === "connect" ? c.origin : null });
  return slug;
}

// ---------- Parçalar ----------
async function runJob(jobId: string) {
  const { data: job } = await db.from("sync_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job || job.job_type !== "site_connect" || job.status !== "running") return;
  const p = job.payload || {};
  try {
    const c = await getConn(String(p.connectionId || ""));
    const { data: run } = await db.from("site_sync_runs").select("*").eq("id", String(p.runId || "")).maybeSingle();
    if (!c || !run || run.status === "cancelled") { await db.rpc("complete_sync_job", { p_job_id: jobId, p_result: { skipped: true } }); return; }
    if (p.step === "discover") await discover(c, run);
    else if (p.step === "page") await apiPage(c, run, p.cursor ?? null);
    else if (p.step === "items") await saveItems(c, run, p.items || []);
    else if (p.step === "pages") await crawlPages(c, run, (p.links || []).map(String));
    await db.rpc("complete_sync_job", { p_job_id: jobId, p_result: { ok: true, step: p.step } });
  } catch (e) {
    const msg = short((e as Error).message || e, 400);
    console.error("site-connect job", p.step, msg);
    await db.rpc("fail_sync_job", { p_job_id: jobId, p_error: msg });
    if (job.attempts >= job.max_attempts && p.runId) {
      if (p.step === "discover" || p.step === "page") {
        await db.from("site_sync_runs").update({ status: "error", error: msg, finished_at: now() }).eq("id", p.runId);
        await db.from("site_connections").update({ status: "error", stats: { last_error: msg }, updated_at: now() }).eq("id", p.connectionId);
      } else {
        const n = p.step === "items" ? (p.items || []).length : (p.links || []).length;
        await db.rpc("site_run_bump", { p_id: p.runId, p_failed: n, p_chunks_done: 1 });
        await maybeFinish(String(p.connectionId), String(p.runId));
      }
    }
  }
}

async function discover(c: any, run: any) {
  await db.from("site_sync_runs").update({ status: "discover", started_at: now() }).eq("id", run.id);
  // 1) Resmi API: sayfa sayfa (her sayfa kendi parçasında, sonrakini kendisi kuyruğa koyar)
  if (c.method === "api" && c.store_connection_id) {
    await db.from("site_sync_runs").update({ status: "running", source: "api", chunks: 1 }).eq("id", run.id);
    await enqueue(c.user_id, [{ connectionId: c.id, runId: run.id, step: "page", cursor: null }], 0, 4);
    return;
  }
  // 2) Ürün akışı (XML: product-import okur; CSV: burada)
  if (c.feed_url) {
    let items: any[] = [];
    try {
      const head = await safeFetch(c.feed_url, { accept: "application/xml,text/csv,text/plain,*/*", maxBytes: 40_000_000, timeout: 60000 });
      if (head.status !== 200) throw new Error("Ürün akışı açılamadı (HTTP " + head.status + ")");
      if (/^\s*</.test(head.text)) {
        const r = await fn("product-import", c.user_id, { url: c.feed_url, language: "tr" }, 120000);
        if (r?.kind !== "feed") throw new Error(r?.error || "Akış okunamadı");
        items = r.items || [];
      } else items = csvItems(parseCsv(head.text), c.origin);
    } catch (e) {
      if (c.method === "feed") throw e;
    }
    if (items.length) {
      items = items.slice(0, MAX_PRODUCTS).map((i: any) => retail(i));
      const chunks: any[] = [];
      for (let i = 0; i < items.length; i += ITEMS_PER_CHUNK) chunks.push({ connectionId: c.id, runId: run.id, step: "items", items: items.slice(i, i + ITEMS_PER_CHUNK) });
      await db.from("site_sync_runs").update({ status: "running", source: "feed", total: items.length, chunks: chunks.length }).eq("id", run.id);
      await enqueue(c.user_id, chunks, 1, 5);
      return;
    }
  }
  // 3) Tarama: product-import siteyi okur (Shopify / WooCommerce herkese açık liste, site haritası, liste sayfaları)
  const links: string[] = [];
  const feedItems: any[] = [];
  let next: string | null = c.origin + c.scope_path;
  let guard = 0;
  while (next && guard++ < 40 && links.length + feedItems.length < MAX_PRODUCTS) {
    const r = await fn("product-import", c.user_id, { url: next, language: "tr" }, 90000);
    if (r?.kind === "feed") { feedItems.push(...(r.items || [])); next = r.next_page || null; }
    else if (r?.kind === "category") { links.push(...(r.links || [])); next = r.next_page || null; }
    else if (r?.kind === "product" && r.item) { feedItems.push(r.item); next = null; }
    else { if (!links.length && !feedItems.length) throw new Error(r?.error || "Sitede ürün bulunamadı"); next = null; }
  }
  // Kapsam dışı ve robots.txt'in yasakladığı sayfalar okunmaz
  const inScope = (u: string) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") === c.host && x.pathname.startsWith(c.scope_path); } catch { return false; } };
  const uniq = [...new Set(links.filter(inScope))];
  const allowed: string[] = [];
  let skipped = 0;
  for (const l of uniq) (await allowedByRobots(l)) ? allowed.push(l) : skipped++;
  const items = feedItems.slice(0, MAX_PRODUCTS).map(retail);
  const pageLinks = allowed.slice(0, Math.max(0, MAX_PRODUCTS - items.length));
  const chunks: any[] = [];
  for (let i = 0; i < items.length; i += ITEMS_PER_CHUNK) chunks.push({ connectionId: c.id, runId: run.id, step: "items", items: items.slice(i, i + ITEMS_PER_CHUNK) });
  const pageChunks: any[] = [];
  for (let i = 0; i < pageLinks.length; i += LINKS_PER_CHUNK) pageChunks.push({ connectionId: c.id, runId: run.id, step: "pages", links: pageLinks.slice(i, i + LINKS_PER_CHUNK) });
  await db.from("site_sync_runs").update({ status: "running", source: "crawl", total: items.length + pageLinks.length, chunks: chunks.length + pageChunks.length, skipped_robots: skipped }).eq("id", run.id);
  if (!chunks.length && !pageChunks.length) { await maybeFinish(c.id, run.id); return; }
  await enqueue(c.user_id, chunks, 1, 5);
  await enqueue(c.user_id, pageChunks, CHUNK_SPACING_S, 6);
}
// Sitedeki fiyat perakende fiyattır (satış fiyatı); maliyet bilinmiyor
function retail(i: any) {
  const sale = Number(i.sale_price) > 0 ? Number(i.sale_price) : Number(i.price) > 0 ? Number(i.price) : null;
  return { ...i, sale_price: sale, price: null, variants: (i.variants || []).map((v: any) => ({ ...v, price: null })) };
}

async function apiPage(c: any, run: any, cursor: string | null) {
  const { data: creds } = await db.rpc("store_connection_get_credentials", { p_connection_id: c.store_connection_id });
  if (!creds) throw new Error("Resmi bağlantının anahtarı bulunamadı (Hesaplarım'dan yeniden bağla)");
  const { data: sc } = await db.from("store_connections").select("marketplace_code, external_seller_id").eq("id", c.store_connection_id).single();
  const cr = { ...creds, public_domain: new URL(c.origin).hostname, site_url: c.origin };
  const page = sc.marketplace_code === "shopify" ? await shopifyAdminPage(cr, cursor)
    : sc.marketplace_code === "woocommerce" ? await wooRestPage({ sellerId: sc.external_seller_id || c.origin, ...cr }, cursor)
    : await wixStoresPage(cr, cursor);
  const items = page.items.map(retail);
  const chunks: any[] = [];
  for (let i = 0; i < items.length; i += ITEMS_PER_CHUNK) chunks.push({ connectionId: c.id, runId: run.id, step: "items", items: items.slice(i, i + ITEMS_PER_CHUNK) });
  const more = page.next && run.total + items.length < MAX_PRODUCTS;
  // Bu sayfa parçası biter; yerine kayıt parçaları (+ varsa sonraki sayfa) eklenir
  await db.rpc("site_run_bump", { p_id: run.id, p_total: items.length, p_chunks: chunks.length + (more ? 1 : 0), p_chunks_done: 1 });
  await enqueue(c.user_id, chunks, 0, 5);
  if (more) await enqueue(c.user_id, [{ connectionId: c.id, runId: run.id, step: "page", cursor: page.next }], 2, 4);
  if (!chunks.length && !more) await maybeFinish(c.id, run.id);
}

async function crawlPages(c: any, run: any, links: string[]) {
  const items: any[] = [];
  let failed = 0, skipped = 0;
  for (const l of links) {
    if (!(await allowedByRobots(l))) { skipped++; continue; }
    const r = await fn("product-import", c.user_id, { url: l, language: "tr" }, 60000).catch(() => null);
    if (r?.kind === "product" && r.item?.name) items.push(retail({ ...r.item, url: r.item.url || l }));
    else failed++;
    await new Promise((res) => setTimeout(res, 700)); // aynı siteye aralıklı
  }
  await saveItems(c, run, items, { failed, skipped, countChunk: true });
}

// Değişmeyen ürün yeniden yazılmaz (özet), değişen / yeni ürün product-ingest ile kaydedilir
const itemHash = (i: any) => sha256Hex(JSON.stringify([i.name, i.sale_price, i.stock, (i.variants || []).map((v: any) => [v.sku, v.stock, v.price]), (i.images || []).slice(0, 3)]));
async function saveItems(c: any, run: any, items: any[], extra: { failed?: number; skipped?: number; countChunk?: boolean } = {}) {
  items = items.filter((i) => i?.name && (i.url || i.sku || i.source_item_id));
  for (const i of items) if (!i.url) i.url = `${c.origin}/#${encodeURIComponent(i.sku || i.source_item_id)}`;
  const urls = items.map((i) => String(i.url));
  const { data: maps } = urls.length ? await db.from("site_product_map").select("id, url, hash, product_id").eq("connection_id", c.id).in("url", urls) : { data: [] };
  const mapBy = new Map((maps || []).map((m: any) => [m.url, m]));
  const hashes = await Promise.all(items.map(itemHash));
  const todo: any[] = [], todoHash: string[] = [];
  let unchanged = 0;
  items.forEach((it, k) => {
    const m: any = mapBy.get(String(it.url));
    if (m?.product_id && m.hash === hashes[k]) { unchanged++; return; }
    todo.push({ ...it, existing_id: m?.product_id || null });
    todoHash.push(hashes[k]);
  });
  let created = 0, updated = 0, failed = extra.failed || 0;
  if (todo.length) {
    const r = await fn("product-ingest", c.user_id, {
      items: todo, sourceUrl: c.origin, via: "site-connect:" + (run.source || c.method), publish: true, dedupe: true,
      aeSource: "own", consent: true, imageTerms: true, sync: false,
    }, 140000);
    if (!r?.ok) { failed += todo.length; }
    else {
      const prods: any[] = r.products || [];
      const rows: any[] = [];
      todo.forEach((it, k) => {
        const p = prods[k];
        if (!p) { failed++; return; }
        p.action === "updated" ? updated++ : created++;
        rows.push({ connection_id: c.id, user_id: c.user_id, product_id: p.id, url: String(it.url), external_id: it.source_item_id || null, sku: it.sku || null, category: it.category || null, hash: todoHash[k], seen_at: now(), removed_at: null });
      });
      if (rows.length) await db.from("site_product_map").upsert(rows, { onConflict: "connection_id,url" });
    }
  }
  // Değişmeyenler: görüldü işareti (silinen ürün tespiti için)
  const seen = items.filter((it, k) => { const m: any = mapBy.get(String(it.url)); return m?.product_id && m.hash === hashes[k]; }).map((i) => String(i.url));
  if (seen.length) await db.from("site_product_map").update({ seen_at: now(), removed_at: null }).eq("connection_id", c.id).in("url", seen);
  await db.rpc("site_run_bump", { p_id: run.id, p_done: items.length, p_created: created, p_updated: updated + unchanged, p_failed: failed, p_skipped: extra.skipped || 0, p_chunks_done: 1 });
  await maybeFinish(c.id, run.id);
}

async function maybeFinish(connectionId: string, runId: string) {
  const { data: ok } = await db.rpc("site_run_finish", { p_id: runId });
  if (!ok) return;
  const { data: run } = await db.from("site_sync_runs").select("*").eq("id", runId).single();
  const c = await getConn(connectionId);
  if (!c) return;
  let removed = 0;
  // Eşitlemede sitede artık olmayan ürünler: vitrinden ve pazaryerlerinden kalkar (stok 0 / gizli); ürün silinmez
  if (run.kind === "sync" && run.failed === 0 && run.done > 0) {
    const { data: gone } = await db.from("site_product_map").select("id, product_id").eq("connection_id", c.id).is("removed_at", null).lt("seen_at", run.created_at).limit(1000);
    for (const g of gone || []) {
      if (g.product_id) await db.from("products").update({ store_visible: false, stock_qty: 0, stock_status: "tukendi", source_note: "Sitede artık yok (eşitleme)" }).eq("id", g.product_id).eq("user_id", c.user_id);
      await db.from("site_product_map").update({ removed_at: now() }).eq("id", g.id);
      removed++;
    }
    if (removed) await db.from("site_sync_runs").update({ removed }).eq("id", runId);
  }
  // Taşıma: eski adres -> yeni ürün sayfası (301 haritası)
  if (c.purpose === "migrate") await buildRedirects(c);
  const next = new Date(Date.now() + (c.sync_hours || 6) * 3600_000).toISOString();
  const { count } = await db.from("site_product_map").select("id", { count: "exact", head: true }).eq("connection_id", c.id).is("removed_at", null);
  const { count: redirects } = c.purpose === "migrate" ? await db.from("store_redirects").select("id", { count: "exact", head: true }).eq("connection_id", c.id) : { count: null };
  await db.from("site_connections").update({
    status: "active", last_sync_at: now(), next_sync_at: c.auto_sync ? next : null, updated_at: now(),
    stats: { products: count || 0, ...(redirects != null ? { redirects } : {}), last_run: { kind: run.kind, created: run.created, updated: run.updated, failed: run.failed, removed, skipped_robots: run.skipped_robots, source: run.source } },
  }).eq("id", c.id);
  if (run.kind === "import" && (run.created || run.updated)) {
    const { data: st } = await db.from("store_settings").select("store_slug").eq("user_id", c.user_id).maybeSingle();
    await db.rpc("assistant_enqueue", { p_user: c.user_id, p_kind: "site_import", p_payload: { count: run.created + run.updated, site: c.origin, slug: st?.store_slug }, p_dedupe: "sitec:" + runId });
  }
}

async function buildRedirects(c: any) {
  const { data: st } = await db.from("store_settings").select("store_slug, custom_domain").eq("user_id", c.user_id).maybeSingle();
  if (!st) return;
  const { data: maps } = await db.from("site_product_map").select("product_id, url").eq("connection_id", c.id).not("product_id", "is", null).is("removed_at", null).limit(5000);
  const rows = (maps || []).map((m: any) => {
    let path = "";
    try { const u = new URL(m.url); path = (u.pathname + u.search).replace(/\/+$/, "") || "/"; } catch { return null; }
    if (path === "/" || path.startsWith("/#")) return null;
    return { user_id: c.user_id, from_path: path.slice(0, 500), to_url: `/p/${m.product_id}`, product_id: m.product_id, connection_id: c.id };
  }).filter(Boolean);
  for (let i = 0; i < rows.length; i += 500) await db.from("store_redirects").upsert(rows.slice(i, i + 500), { onConflict: "user_id,from_path" });
}

// ---------- Zamanlanmış eşitleme ----------
async function tick() {
  const { data: due } = await db.from("site_connections").select("*").is("deleted_at", null).eq("auto_sync", true).not("verified_at", "is", null)
    .lte("next_sync_at", now()).order("next_sync_at").limit(20);
  const out: unknown[] = [];
  for (const c of due || []) {
    if (!(await featureEnabled(c.user_id, "site_connect"))) continue;
    await db.from("site_connections").update({ next_sync_at: new Date(Date.now() + (c.sync_hours || 6) * 3600_000).toISOString() }).eq("id", c.id);
    out.push({ id: c.id, ...(await startRun(c, "sync")) });
  }
  return out;
}

// ---------- Webhook gönderimi (imzalı, tekrar denemeli) ----------
const BACKOFF_MIN = [1, 5, 30, 120, 720, 1440];
async function webhookSecret(c: any): Promise<string | null> {
  if (!c.webhook_secret_id) return null;
  const { data } = await db.rpc("seltigo_secret_get", { p_id: c.webhook_secret_id });
  return data?.secret || null;
}
async function deliver(c: any, secret: string, event: string, payload: unknown, id: string | number) {
  const body = JSON.stringify({ id: String(id), event, created_at: now(), data: payload });
  const sig = await hmacHex(secret, body);
  const r = await safeFetch(c.webhook_url, {
    method: "POST", body, accept: "application/json,*/*", timeout: 15000, maxBytes: 50_000, noPace: true,
    headers: { "Content-Type": "application/json", "X-Seltigo-Event": event, "X-Seltigo-Signature": "sha256=" + sig, "X-Seltigo-Delivery": String(id) },
  });
  return r;
}
async function webhooks() {
  const { data: evs } = await db.from("site_webhook_events").select("*").eq("status", "pending").lte("next_at", now()).order("id").limit(100);
  const conns = new Map<string, any>();
  let sent = 0, failed = 0;
  for (const e of evs || []) {
    let c = conns.get(e.connection_id);
    if (c === undefined) { c = await getConn(e.connection_id); if (c) c.secret = await webhookSecret(c); conns.set(e.connection_id, c || null); }
    if (!c?.webhook_url || !c.secret) { await db.from("site_webhook_events").update({ status: "failed", last_error: "webhook adresi / anahtarı yok" }).eq("id", e.id); continue; }
    try {
      const r = await deliver(c, c.secret, e.event, e.payload, e.id);
      if (r.status >= 200 && r.status < 300) {
        await db.from("site_webhook_events").update({ status: "sent", sent_at: now(), attempts: e.attempts + 1 }).eq("id", e.id);
        await db.from("site_connections").update({ webhook_last_ok_at: now(), webhook_last_error: null }).eq("id", c.id);
        sent++;
        continue;
      }
      throw new Error("HTTP " + r.status);
    } catch (err) {
      const a = e.attempts + 1;
      const done = a >= BACKOFF_MIN.length;
      await db.from("site_webhook_events").update({ attempts: a, last_error: short((err as Error).message, 200), status: done ? "failed" : "pending",
        next_at: new Date(Date.now() + BACKOFF_MIN[Math.min(a, BACKOFF_MIN.length - 1)] * 60_000).toISOString() }).eq("id", e.id);
      await db.from("site_connections").update({ webhook_last_error: short((err as Error).message, 200) }).eq("id", c.id);
      failed++;
    }
  }
  return { sent, failed };
}

// ---------- Ayarlar, anahtarlar ----------
async function setConn(userId: string, b: any) {
  const c = await getConn(String(b.id || ""), userId);
  if (!c) return { ok: false, error: "Bağlantı bulunamadı" };
  const patch: any = { updated_at: now() };
  if (b.feed_url !== undefined) {
    if (!b.feed_url) patch.feed_url = null;
    else {
      const f = await checkFeed(String(b.feed_url));
      if (!f) return { ok: false, error: "Bu adreste ürün akışı (XML / CSV) bulunamadı." };
      patch.feed_url = f;
      if (c.method !== "api") patch.method = "feed";
    }
  }
  if (b.auto_sync !== undefined) { patch.auto_sync = !!b.auto_sync; patch.next_sync_at = b.auto_sync ? new Date(Date.now() + (Number(b.sync_hours) || c.sync_hours) * 3600_000).toISOString() : null; }
  if (b.sync_hours !== undefined) patch.sync_hours = Math.min(168, Math.max(1, Number(b.sync_hours) || 6));
  let secret: string | null = null;
  if (b.webhook_url !== undefined) {
    if (!b.webhook_url) patch.webhook_url = null;
    else {
      const ref = normalizeSite(String(b.webhook_url));
      if (!ref || !ref.url.startsWith("https://")) return { ok: false, error: "Webhook adresi https:// ile başlamalı." };
      try { await assertPublicHost(new URL(ref.url).hostname); } catch (e) { return { ok: false, error: (e as Error).message }; }
      patch.webhook_url = ref.url;
      if (!c.webhook_secret_id) { secret = "whsec_" + randomToken(24); patch.webhook_secret_id = (await db.rpc("seltigo_secret_set", { p_id: null, p_name: "site_webhook", p_value: { secret } })).data; }
    }
  }
  if (Array.isArray(b.webhook_events)) {
    const ok = ["product.created", "product.updated", "product.deleted", "stock.updated", "order.created"];
    patch.webhook_events = b.webhook_events.filter((x: string) => ok.includes(x));
  }
  const { data } = await db.from("site_connections").update(patch).eq("id", c.id).select("*").single();
  return { ok: true, connection: publicConn(data), webhook_secret: secret };
}
async function apiKey(userId: string, b: any) {
  if (!(await featureEnabled(userId, "site_api"))) return { ok: false, error: FEATURE_OFF_MSG, feature: "site_api" };
  const c = await getConn(String(b.id || ""), userId);
  if (!c) return { ok: false, error: "Bağlantı bulunamadı" };
  if (!c.verified_at) return { ok: false, needVerify: true, error: "Önce sitenin sana ait olduğunu doğrula." };
  const key = "slt_live_" + randomToken(24);
  await db.from("site_connections").update({ api_key_hash: await sha256Hex(key), api_key_prefix: key.slice(0, 13), api_key_created_at: now(), updated_at: now() }).eq("id", c.id);
  return { ok: true, api_key: key, prefix: key.slice(0, 13), endpoint: `${SUPABASE_URL}/functions/v1/site-api`, docs: `${SITE}/site-baglanti-kurulum.html` };
}
async function newWebhookSecret(userId: string, b: any) {
  const c = await getConn(String(b.id || ""), userId);
  if (!c) return { ok: false, error: "Bağlantı bulunamadı" };
  const secret = "whsec_" + randomToken(24);
  const { data: id } = await db.rpc("seltigo_secret_set", { p_id: c.webhook_secret_id || null, p_name: "site_webhook", p_value: { secret } });
  await db.from("site_connections").update({ webhook_secret_id: id, updated_at: now() }).eq("id", c.id);
  return { ok: true, webhook_secret: secret };
}
async function webhookTest(userId: string, b: any) {
  const c = await getConn(String(b.id || ""), userId);
  if (!c?.webhook_url) return { ok: false, error: "Önce webhook adresini kaydet." };
  const secret = await webhookSecret(c);
  if (!secret) return { ok: false, error: "Webhook anahtarı yok" };
  try {
    const r = await deliver(c, secret, "ping", { message: "Seltigo bağlantı denemesi", connection_id: c.id }, "ping-" + Date.now());
    const ok = r.status >= 200 && r.status < 300;
    await db.from("site_connections").update(ok ? { webhook_last_ok_at: now(), webhook_last_error: null } : { webhook_last_error: "HTTP " + r.status }).eq("id", c.id);
    return { ok, status: r.status, body: short(r.text, 300) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
async function status(userId: string, b: any) {
  let q = db.from("site_connections").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: false });
  if (b.id) q = q.eq("id", String(b.id));
  const { data: conns } = await q;
  const ids = (conns || []).map((c: any) => c.id);
  const { data: runs } = ids.length ? await db.from("site_sync_runs").select("*").in("connection_id", ids).order("created_at", { ascending: false }).limit(50) : { data: [] };
  return {
    ok: true,
    connections: (conns || []).map((c: any) => ({
      ...publicConn(c), verify: c.verified_at ? null : verifyHelp(c), platform_info: PLATFORM_INFO[c.platform || "custom"],
      runs: (runs || []).filter((r: any) => r.connection_id === c.id).slice(0, 5),
    })),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "run" && b.jobId) { background(runJob(String(b.jobId))); return json({ ok: true }); }
      if (b.action === "tick") return json({ ok: true, started: await tick() });
      if (b.action === "webhooks") return json({ ok: true, ...(await webhooks()) });
      if (b.userId && ["detect", "verify", "import", "sync_now", "status", "set", "api_key"].includes(b.action)) return json(await userAction(String(b.userId), b));
      return json({ error: "Geçersiz işlem" }, 400);
    }
    const token = String(b?.userAccessToken || "").trim();
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    return json(await userAction(userId, b));
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
async function userAction(userId: string, b: any) {
  switch (b.action) {
    case "detect": return await detect(userId, b);
    case "verify": return await verify(userId, b);
    case "import": case "sync_now": return await startImport(userId, b);
    case "set": return await setConn(userId, b);
    case "status": return await status(userId, b);
    case "api_key": return await apiKey(userId, b);
    case "webhook_secret": return await newWebhookSecret(userId, b);
    case "webhook_test": return await webhookTest(userId, b);
    case "delete": {
      const c = await getConn(String(b.id || ""), userId);
      if (!c) return { ok: false, error: "Bağlantı bulunamadı" };
      await db.from("site_connections").update({ deleted_at: now(), auto_sync: false, api_key_hash: null, webhook_url: null }).eq("id", c.id);
      return { ok: true };
    }
    default: return { ok: false, error: "Geçersiz işlem" };
  }
}
