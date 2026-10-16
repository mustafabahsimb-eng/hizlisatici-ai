// =========================================================
// İçerik otomasyonu (İ1-İ2): haftalık içerik planı -> şablon görsel + AI metin -> (onay) -> zamanında paylaşım -> ölçüm -> öğrenme
// Satıcı (userAccessToken):
//   { action: "status" }                       -> ayarlar, bağlı kanallar, önümüzdeki 14 gün + son yayınlananlar, öğrenilen en iyi şablon / saat
//   { action: "plan" }                         -> önümüzdeki 7 günü planla (var olanlar korunur)
//   { action: "approve", id | all: true }      { action: "skip", id }   { action: "caption", id, caption }   { action: "publish_now", id }
// Sistem (CRON_SECRET; saatlik): { action: "run" } -> açık satıcılara plan, zamanı gelenleri paylaş, sonuç ve etkileşim oku
//   { action: "plan", userId, hop } -> planın devamı. Görsel çizimi ağır: tek istekte en fazla RENDER_BATCH görsel çizilir,
//   kalan için fonksiyon kendini yeni bir istekle çağırır (her istek yeni işlem sınırı; tek istekte hepsi WORKER_RESOURCE_LIMIT verir)
// Paylaşım: Instagram -> social_posts kuyruğu (instagram-worker); Facebook Sayfası -> doğrudan Graph API
// Varsayılan KAPALI (content_settings.enabled). Yeni içerik varsayılan onaya düşer. Paket anahtarı: content_auto
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled, FEATURE_OFF_MSG } from "../_shared/features.ts";
import { type CProduct, type ContentSettings, fallbackCaption, learn, planWeek, type PlanItem, weekStartOf } from "../_shared/content-engine.ts";
import { render } from "../_shared/content-render.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const FB_GRAPH = "https://graph.facebook.com/v21.0", IG_GRAPH = "https://graph.instagram.com/v23.0";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const nowIso = () => new Date().toISOString();
const DEFAULTS: ContentSettings = { posts_per_day: 1, stories_per_week: 3, channels: ["instagram", "facebook"], post_hours: ["19:30"], approval_mode: "approve", timezone: "Europe/Istanbul" };

async function settingsFor(userId: string) {
  const { data } = await db.from("content_settings").select("*").eq("user_id", userId).maybeSingle();
  return { enabled: !!data?.enabled, ...DEFAULTS, ...(data || {}) } as ContentSettings & { enabled: boolean };
}
async function channelsFor(userId: string) {
  const { data } = await db.from("social_channels").select("id, platform, account_id, account_name, token_status").eq("user_id", userId).eq("active", true).in("platform", ["instagram", "facebook"]);
  return data || [];
}
const money = (v: number, cur: string) => { try { return new Intl.NumberFormat("tr-TR", { style: "currency", currency: cur || "TRY" }).format(v); } catch { return v.toFixed(2) + " " + cur; } };

async function productsFor(userId: string): Promise<(CProduct & { title: string })[]> {
  const { data: ps } = await db.from("products").select("id, name, generated_title, sale_price, image_url, created_at, stock_qty, stock_status, store_visible, product_type")
    .eq("user_id", userId).is("deleted_at", null).eq("store_visible", true).limit(500);
  const ids = (ps || []).map((p: any) => p.id);
  if (!ids.length) return [];
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [{ data: so }, { data: mo }, { data: posts }, { data: prof }] = await Promise.all([
    db.from("store_orders").select("product_id").eq("user_id", userId).gte("created_at", since).neq("status", "cancelled"),
    db.from("marketplace_orders").select("product_id").eq("user_id", userId).gte("ordered_at", since),
    db.from("content_items").select("product_ids, published_at").eq("user_id", userId).eq("status", "published").gte("published_at", new Date(Date.now() - 60 * 86400000).toISOString()),
    db.from("user_profiles").select("home_currency").eq("user_id", userId).maybeSingle(),
  ]);
  const sold = new Map<number, number>();
  for (const o of [...(so || []), ...(mo || [])]) if (o.product_id) sold.set(o.product_id, (sold.get(o.product_id) || 0) + 1);
  const last = new Map<number, string>();
  for (const c of posts || []) for (const id of c.product_ids || []) if (!last.has(id) || last.get(id)! < c.published_at) last.set(id, c.published_at);
  const cur = prof?.home_currency || "TRY";
  return (ps || []).map((p: any) => ({ id: p.id, name: p.generated_title || p.name, title: p.generated_title || p.name, price: Number(p.sale_price) || 0, currency: cur, image: /^https?:\/\//.test(p.image_url || "") ? p.image_url : null,
    createdAt: p.created_at, sold30: sold.get(p.id) || 0, lastPostedAt: last.get(p.id) || null, inStock: p.product_type === "digital" || p.stock_qty == null || (Number(p.stock_qty) > 0 && p.stock_status !== "tukendi"), visible: true }));
}

async function statsFor(userId: string, tz: string) {
  const { data } = await db.from("content_items").select("template, scheduled_at, metrics").eq("user_id", userId).eq("status", "published").not("metrics", "is", null).order("published_at", { ascending: false }).limit(200);
  return learn((data || []).map((x: any) => ({ template: x.template, scheduledAt: x.scheduled_at, tz, metrics: x.metrics })));
}

// AI ile metinler (tek çağrı; olmazsa yedek metin)
async function captions(store: string, items: { template: string; names: string[]; price: string | null; season?: string; kind: string; channel: string }[]) {
  const fb = items.map((it) => it.kind === "story" ? "" : fallbackCaption(it.template as any, it.names, it.price, store, it.season));
  if (!ANTHROPIC_API_KEY || !items.length) return fb;
  try {
    const prompt = `Mağaza: ${store}\nAşağıdaki her sosyal medya gönderisi için kısa, samimi, Türkçe gönderi metni yaz (en fazla 300 karakter + 5-8 Türkçe hashtag; abartılı ve yanıltıcı vaat yok; fiyatı verilen kadar yaz; "profildeki bağlantı" ile bitir). Hikâye (story) için boş metin ver.\n` +
      items.map((it, i) => `${i + 1}) kanal=${it.channel} tür=${it.kind} şablon=${it.template}${it.season ? " özel gün=" + it.season : ""} ürün(ler)=${it.names.join(" | ")} fiyat=${it.price || "-"}`).join("\n") +
      `\nYalnız JSON dizi döndür (sırayla, ${items.length} öğe): ["...", ...]`;
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(60000) });
    const d = await r.json();
    const m = (d?.content || []).map((c: any) => c.text || "").join("").match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    return items.map((it, i) => it.kind === "story" ? "" : (typeof arr[i] === "string" && arr[i].trim() ? short(arr[i], 2000) : fb[i]));
  } catch (_) { return fb; }
}

async function renderAndStore(userId: string, it: PlanItem, prods: Map<number, CProduct & { title: string }>, store: string) {
  const ps = it.productIds.map((id) => prods.get(id)!).filter((p) => p?.image);
  const bytes = await render({ template: it.template, store, season: it.season, products: ps.map((p) => ({ name: p.title, price: p.price ? money(p.price, p.currency) : null, image: p.image! })) });
  const path = `${userId}/${it.scheduledAt.slice(0, 10)}/${crypto.randomUUID()}.jpg`;
  const up = await db.storage.from("content-media").upload(path, bytes, { contentType: "image/jpeg", upsert: true });
  if (up.error) throw up.error;
  return db.storage.from("content-media").getPublicUrl(path).data.publicUrl;
}

const RENDER_BATCH = 3, MAX_HOPS = 25;
function background(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p.catch((e) => console.error("content", String(e))));
}
// Planın devamını yeni istekte başlat (kendi kendini zincirler)
function planLater(userId: string, hop: number) {
  background(fetch(`${SUPABASE_URL}/functions/v1/content`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ action: "plan", userId, hop, cronSecret: CRON_SECRET }),
  }).then((r) => r.body?.cancel()));
}

async function plan(userId: string, opts: { hop?: number } = {}) {
  const hop = opts.hop ?? 0;
  if (!(await featureEnabled(userId, "content_auto"))) return { ok: false, error: FEATURE_OFF_MSG };
  const s = await settingsFor(userId);
  const chs = await channelsFor(userId);
  const connected = new Set(chs.map((c: any) => c.platform));
  const settings = { ...s, channels: s.channels.filter((c) => connected.has(c)) };
  if (!settings.channels.length) return { ok: false, error: "Instagram ya da Facebook bağlı değil (Sosyal medya)" };
  const prods = await productsFor(userId);
  if (!prods.length) return { ok: false, error: "Mağazada paylaşılacak ürün yok" };
  const now = Date.now();
  const { data: taken } = await db.from("content_items").select("scheduled_at, channel, kind, product_ids").eq("user_id", userId).gte("scheduled_at", new Date(now).toISOString()).neq("status", "skipped");
  const weekStart = new Date(now).toISOString().slice(0, 10);   // bugünden itibaren 7 gün
  // Önceki parçalarda planlanmış ürünler yeni paylaşılmış sayılır (aynı ürün art arda gelmesin)
  const plannedIds = new Set((taken || []).flatMap((t: any) => t.product_ids || []));
  for (const p of prods) if (plannedIds.has(p.id)) p.lastPostedAt = new Date(now).toISOString();
  const all = planWeek({ settings, products: prods, stats: await statsFor(userId, settings.timezone), weekStart, now, seed: Math.floor(now / 3600000),
    taken: (taken || []).map((t: any) => ({ scheduledAt: t.scheduled_at, channel: t.channel, kind: t.kind })) });
  if (!all.length) return { ok: true, created: 0, done: true };
  // Bu istekte çizilecek parça: ilk RENDER_BATCH görsel (aynı slottaki kanallar aynı görseli paylaşır)
  const keyOf = (it: PlanItem) => `${it.kind}|${it.template}|${it.scheduledAt}|${it.productIds.join(",")}`;
  const keys = new Set<string>();
  const items = all.filter((it) => { const k = keyOf(it); if (keys.has(k)) return true; if (keys.size >= RENDER_BATCH) return false; keys.add(k); return true; });
  const more = items.length < all.length;
  const byId = new Map(prods.map((p) => [p.id, p]));
  const { data: ss } = await db.from("store_settings").select("store_name, business_name").eq("user_id", userId).maybeSingle();
  const store = ss?.business_name || ss?.store_name || "Mağazam";
  const caps = await captions(store, items.map((it) => ({ template: it.template, kind: it.kind, channel: it.channel, season: it.season, names: it.productIds.map((id) => byId.get(id)?.title || ""),
    price: it.productIds.length === 1 && byId.get(it.productIds[0])?.price ? money(byId.get(it.productIds[0])!.price, byId.get(it.productIds[0])!.currency) : null })));
  // Aynı slotta (kanal farkı) aynı görsel kullanılır
  const mediaCache = new Map<string, string>();
  let created = 0, errors: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const key = keyOf(it);
    try {
      if (!mediaCache.has(key)) mediaCache.set(key, await renderAndStore(userId, it, byId, store));
      await db.from("content_items").insert({ user_id: userId, channel: it.channel, kind: it.kind, template: it.template, product_ids: it.productIds, reason: it.reason, caption: caps[i] || null,
        media_urls: [mediaCache.get(key)!], scheduled_at: it.scheduledAt, status: settings.approval_mode === "direct" ? "scheduled" : "pending_approval", week_start: weekStartOf(new Date(it.scheduledAt), settings.timezone) });
      created++;
    } catch (e) { errors.push(short((e as Error).message, 120)); }
  }
  // Kalan görseller: yeni istekte devam (bu parçada hiç içerik oluşmadıysa döngüye girmemek için durur)
  const continuing = more && created > 0 && hop < MAX_HOPS;
  if (continuing) planLater(userId, hop + 1);
  // Panel planın sürdüğünü buradan görür (status.planning)
  await db.from("app_cache").upsert({ key: `content_plan:${userId}`, value: { running: continuing, at: nowIso() }, updated_at: nowIso() });
  // Asistan bildirimi plan tamamlanınca bir kez (hazırlanan toplam içerik sayısıyla)
  if (!continuing && settings.approval_mode !== "direct") {
    const { count } = await db.from("content_items").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "pending_approval").gte("scheduled_at", new Date(now).toISOString());
    if (count) await db.rpc("assistant_enqueue", { p_user: userId, p_kind: "content", p_payload: { count }, p_dedupe: "content:" + weekStart });
  }
  return { ok: true, created, continuing, done: !continuing, errors: errors.slice(0, 5) };
}

// ---------- Paylaşım ----------
async function channelToken(ch: any) { const { data } = await db.rpc("social_channel_get_token", { p_channel_id: ch.id }); return data as string | null; }

async function publish(it: any) {
  const chs = await channelsFor(it.user_id);
  const ch = chs.find((c: any) => c.platform === it.channel);
  if (!ch) throw new Error(`${it.channel === "instagram" ? "Instagram" : "Facebook"} bağlı değil`);
  if (it.channel === "instagram") {
    const { data: sp, error } = await db.from("social_posts").insert({ user_id: it.user_id, product_id: it.product_ids?.[0] ?? null, channel_id: ch.id, platform: "instagram", status: "pending",
      kind: it.kind === "story" ? "story" : "post", caption: it.caption || "", image_url: it.media_urls[0], scheduled_at: nowIso() }).select("id").single();
    if (error) throw error;
    await db.from("content_items").update({ status: "publishing", social_post_id: sp.id, updated_at: nowIso() }).eq("id", it.id);
    return { queued: true };
  }
  // Facebook Sayfası: fotoğraflı gönderi
  const tok = await channelToken(ch);
  if (!tok) throw new Error("Facebook anahtarı yok");
  const r = await fetch(`${FB_GRAPH}/${ch.account_id}/photos`, { method: "POST", body: new URLSearchParams({ url: it.media_urls[0], caption: it.caption || "", access_token: tok }), signal: AbortSignal.timeout(60000) });
  const d = await r.json();
  if (!r.ok || !d?.id) throw new Error(d?.error?.error_user_msg || d?.error?.message || "Facebook gönderisi açılamadı");
  const postId = String(d.post_id || d.id);
  await db.from("content_items").update({ status: "published", external_id: postId, external_url: `https://www.facebook.com/${postId}`, published_at: nowIso(), error: null, updated_at: nowIso() }).eq("id", it.id);
  return { published: true };
}

async function readMetrics(it: any) {
  const chs = await channelsFor(it.user_id);
  const ch = chs.find((c: any) => c.platform === it.channel);
  if (!ch || !it.external_id) return null;
  const tok = await channelToken(ch);
  if (!tok) return null;
  if (it.channel === "instagram") {
    const m: Record<string, number> = {};
    const b = await (await fetch(`${IG_GRAPH}/${it.external_id}?fields=like_count,comments_count&access_token=${encodeURIComponent(tok)}`)).json();
    m.likes = Number(b.like_count) || 0; m.comments = Number(b.comments_count) || 0;
    try {
      const ins = await (await fetch(`${IG_GRAPH}/${it.external_id}/insights?metric=reach,saved,shares&access_token=${encodeURIComponent(tok)}`)).json();
      for (const x of ins.data || []) m[x.name === "saved" ? "saves" : x.name] = Number(x.values?.[0]?.value ?? x.total_value?.value) || 0;
    } catch (_) { /* hikâye / izin yoksa yalnız beğeni */ }
    return m;
  }
  const d = await (await fetch(`${FB_GRAPH}/${it.external_id}?fields=likes.summary(true).limit(0),comments.summary(true).limit(0),shares&access_token=${encodeURIComponent(tok)}`)).json();
  if (d.error) return null;
  return { likes: Number(d.likes?.summary?.total_count) || 0, comments: Number(d.comments?.summary?.total_count) || 0, shares: Number(d.shares?.count) || 0 };
}

async function run() {
  const deadline = Date.now() + 110_000;
  const out: Record<string, unknown> = {};
  // 1) Onay bekleyip zamanı geçenler atlanır
  const { data: late } = await db.from("content_items").update({ status: "skipped", error: "Onaylanmadan zamanı geçti", updated_at: nowIso() })
    .eq("status", "pending_approval").lt("scheduled_at", new Date(Date.now() - 60 * 60000).toISOString()).select("id");
  out.expired = (late || []).length;
  // 2) Zamanı gelenleri paylaş
  const { data: due } = await db.from("content_items").select("*").eq("status", "scheduled").lte("scheduled_at", nowIso()).order("scheduled_at").limit(30);
  let pub = 0;
  for (const it of due || []) {
    if (Date.now() > deadline) break;
    if (!(await featureEnabled(it.user_id, "content_auto"))) continue;
    try { await publish(it); pub++; } catch (e) { await db.from("content_items").update({ status: "error", error: short((e as Error).message), updated_at: nowIso() }).eq("id", it.id); }
  }
  out.published = pub;
  // 3) Instagram kuyruğunun sonucu
  const { data: pend } = await db.from("content_items").select("id, social_post_id").eq("status", "publishing").not("social_post_id", "is", null).limit(100);
  for (const it of pend || []) {
    const { data: sp } = await db.from("social_posts").select("status, post_id, post_url, error, posted_at").eq("id", it.social_post_id).maybeSingle();
    if (sp?.status === "posted") await db.from("content_items").update({ status: "published", external_id: sp.post_id, external_url: sp.post_url, published_at: sp.posted_at || nowIso(), error: null, updated_at: nowIso() }).eq("id", it.id);
    else if (sp?.status === "error") await db.from("content_items").update({ status: "error", error: sp.error, updated_at: nowIso() }).eq("id", it.id);
  }
  // 4) Etkileşim (son 14 gün, 12 saatte bir)
  const { data: pubs } = await db.from("content_items").select("*").eq("status", "published").gte("published_at", new Date(Date.now() - 14 * 86400000).toISOString()).limit(100);
  let measured = 0;
  for (const it of pubs || []) {
    if (Date.now() > deadline) break;
    if (it.metrics?.checked_at && Date.now() - Date.parse(it.metrics.checked_at) < 12 * 3600000) continue;
    try { const m = await readMetrics(it); if (m) { await db.from("content_items").update({ metrics: { ...m, checked_at: nowIso() } }).eq("id", it.id); measured++; } } catch (_) { /* bir sonraki turda */ }
  }
  out.measured = measured;
  // 5) Açık satıcılara plan (önümüzdeki 3 günde içerik kalmadıysa)
  const { data: users } = await db.from("content_settings").select("user_id").eq("enabled", true);
  const planned: unknown[] = [];
  for (const u of users || []) {
    if (Date.now() > deadline) break;
    const { count } = await db.from("content_items").select("id", { count: "exact", head: true }).eq("user_id", u.user_id).gte("scheduled_at", nowIso()).lte("scheduled_at", new Date(Date.now() + 3 * 86400000).toISOString()).neq("status", "skipped");
    if (count) continue;
    planLater(u.user_id, 0);   // her satıcının planı kendi isteğinde (görsel çizimi işlem sınırına takılmasın)
    planned.push(u.user_id);
  }
  out.planned = planned;
  return out;
}

async function status(userId: string) {
  const s = await settingsFor(userId);
  const chs = await channelsFor(userId);
  const { data: items } = await db.from("content_items").select("*").eq("user_id", userId).gte("scheduled_at", new Date(Date.now() - 7 * 86400000).toISOString())
    .lte("scheduled_at", new Date(Date.now() + 14 * 86400000).toISOString()).order("scheduled_at").limit(200);
  const stats = await statsFor(userId, s.timezone);
  const best = [...stats].filter((x) => x.n >= 2).sort((a, b) => b.engagement - a.engagement)[0] || null;
  // Plan parça parça hazırlanıyor mu (son parça 3 dk içinde ve devam edecek)
  const { data: pc } = await db.from("app_cache").select("value").eq("key", `content_plan:${userId}`).maybeSingle();
  const planning = !!pc?.value?.running && Date.now() - Date.parse(pc.value.at) < 3 * 60000;
  return { ok: true, settings: s, channels: chs.map((c: any) => ({ platform: c.platform, name: c.account_name, status: c.token_status })), items: items || [], best, planning };
}

async function itemAction(userId: string, b: any) {
  if (b.action === "approve" && b.all) {
    const { data } = await db.from("content_items").update({ status: "scheduled", updated_at: nowIso() }).eq("user_id", userId).eq("status", "pending_approval").gte("scheduled_at", nowIso()).select("id");
    return { ok: true, approved: (data || []).length };
  }
  const { data: it } = await db.from("content_items").select("*").eq("id", String(b.id || "")).eq("user_id", userId).maybeSingle();
  if (!it) return { ok: false, error: "İçerik bulunamadı" };
  if (b.action === "approve") { if (it.status !== "pending_approval") return { ok: false, error: "Bu içerik onay beklemiyor" }; await db.from("content_items").update({ status: "scheduled", updated_at: nowIso() }).eq("id", it.id); return { ok: true }; }
  if (b.action === "skip") { if (["published", "publishing"].includes(it.status)) return { ok: false, error: "Paylaşılmış içerik atlanamaz" }; await db.from("content_items").update({ status: "skipped", updated_at: nowIso() }).eq("id", it.id); return { ok: true }; }
  if (b.action === "caption") { if (["published", "publishing"].includes(it.status)) return { ok: false, error: "Paylaşılmış içerik değiştirilemez" }; await db.from("content_items").update({ caption: short(b.caption, 2200), updated_at: nowIso() }).eq("id", it.id); return { ok: true }; }
  if (b.action === "publish_now") {
    if (["published", "publishing"].includes(it.status)) return { ok: false, error: "Zaten paylaşıldı" };
    if (!(await featureEnabled(userId, "content_auto"))) return { ok: false, error: FEATURE_OFF_MSG };
    try { const r = await publish({ ...it, status: "scheduled" }); return { ok: true, ...r }; }
    catch (e) { await db.from("content_items").update({ status: "error", error: short((e as Error).message), updated_at: nowIso() }).eq("id", it.id); return { ok: false, error: short((e as Error).message) }; }
  }
  return { ok: false, error: "Geçersiz işlem" };
}

async function sellerAction(userId: string, b: any) {
  if (b.action === "status") return await status(userId);
  if (b.action === "plan") return await plan(userId, { hop: Number(b.hop) || 0 });
  if (["approve", "skip", "caption", "publish_now"].includes(b.action)) return await itemAction(userId, b);
  return { ok: false, error: "Geçersiz işlem" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (b.action === "run") return json({ ok: true, ...(await run()) });
      if (b.userId) return json(await sellerAction(String(b.userId), b));
      return json({ error: "Geçersiz işlem" }, 400);
    }
    const token = String(b?.userAccessToken || "").trim();
    const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    return json(await sellerAction(userId, b));
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
