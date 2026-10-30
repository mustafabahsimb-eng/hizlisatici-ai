// =========================================================
// Seltigo Asistan - yönetim fonksiyonu
// Satıcı (oturum):  { action: "link_code", channel, role?, isOwner? } -> tek kullanımlık bağlama kodu (+ Telegram derin bağlantısı)
//                   { action: "status" } -> kanalların açık/kapalı durumu (panel)
// Sistem (CRON_SECRET):
//   { action: "test", externalId, text?, callback?, fileBase64?, mime?, filename? } -> test kanalı (cevaplar döner; otomatik testler)
//   { action: "outbox" }   -> bildirim kuyruğunu gönder (1 dk'da bir; sessiz saatlere ve yetkiye uyar)
//   { action: "reports" }  -> sabah raporu (her gün 08:00 TR) ve pazartesi haftalık özet kuyruğa
//   { action: "connections" } -> süresi dolmak üzere olan bağlantılar kuyruğa (günde bir)
//   { action: "wa_templates" } -> WhatsApp 24 saat dışı bildirim şablonlarını Seltigo hesabında onaya gönder / durumunu sor
//   { action: "telegram_webhook" } -> Telegram webhook adresini kaydet (bot anahtarı girildikten sonra bir kez)
// =========================================================
import { db, handleIncoming, renderAlert } from "../_shared/assistant-core.ts";
import { sendReply, telegramApi } from "../_shared/assistant-channels.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 200) => String(v ?? "").slice(0, n);
const env = (k: string) => Deno.env.get(k) ?? "";

function code8(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(r).map((x) => a[x % a.length]).join("");
}

// Sessiz saat mi (satıcının saat diliminde)
function inQuiet(st: any, tz: string): boolean {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: tz || "Europe/Istanbul" }));
  const m = now.getHours() * 60 + now.getMinutes();
  const toMin = (s: string) => { const [h, mm] = String(s || "00:00").split(":").map(Number); return h * 60 + (mm || 0); };
  const a = toMin(st?.quiet_start || "22:00"), b = toMin(st?.quiet_end || "08:00");
  return a < b ? m >= a && m < b : m >= a || m < b;
}

async function runOutbox() {
  const { data: items } = await db.from("assistant_outbox").select("*").eq("status", "pending").lte("send_after", new Date().toISOString()).order("id").limit(50);
  const results: unknown[] = [];
  for (const it of items || []) {
    try {
      const { data: links } = await db.from("assistant_links").select("*").eq("user_id", it.user_id);
      if (!links?.length) { await db.from("assistant_outbox").update({ status: "skipped", error: "bağlı hesap yok" }).eq("id", it.id); continue; }
      const { data: st } = await db.from("assistant_settings").select("*").eq("user_id", it.user_id).maybeSingle();
      const { data: prof } = await db.from("user_profiles").select("timezone").eq("user_id", it.user_id).maybeSingle();
      if (inQuiet(st, prof?.timezone) && !["loss_approval"].includes(it.kind)) {
        // Sessiz saat: bitişine ertele
        await db.from("assistant_outbox").update({ send_after: new Date(Date.now() + 30 * 60_000).toISOString() }).eq("id", it.id);
        results.push({ id: it.id, deferred: true });
        continue;
      }
      const r = await renderAlert(it.kind, it.payload || {}, it.user_id);
      if (!r) { await db.from("assistant_outbox").update({ status: "skipped", error: "bilinmeyen tür" }).eq("id", it.id); continue; }
      const allowed = links.filter((l: any) => l.role === "full" || (r.need === "orders" && l.role === "orders") || (r.need === "products" && l.role === "products"));
      const sent: unknown[] = [];
      for (const l of allowed) sent.push({ channel: l.channel, ...(await sendReply(db, l, r.reply)) });
      const ok = sent.some((x: any) => x.ok);
      await db.from("assistant_outbox").update({ status: ok ? "sent" : "failed", sent_at: new Date().toISOString(), error: ok ? null : short(JSON.stringify(sent), 300) }).eq("id", it.id);
      results.push({ id: it.id, kind: it.kind, sent });
    } catch (e) {
      await db.from("assistant_outbox").update({ status: "failed", error: short((e as Error).message) }).eq("id", it.id);
    }
  }
  return results;
}

async function queueReports() {
  const { data: users } = await db.from("assistant_links").select("user_id");
  const ids = [...new Set((users || []).map((u: any) => u.user_id))];
  const day = new Date().toISOString().slice(0, 10);
  const monday = new Date().getUTCDay() === 1;
  let n = 0;
  for (const uid of ids) {
    const { data: st } = await db.from("assistant_settings").select("morning_report, weekly_summary").eq("user_id", uid).maybeSingle();
    if (st?.morning_report !== false) { await db.rpc("assistant_enqueue", { p_user: uid, p_kind: "morning_report", p_payload: {}, p_dedupe: "morning:" + day }); n++; }
    if (monday && st?.weekly_summary !== false) { await db.rpc("assistant_enqueue", { p_user: uid, p_kind: "weekly_summary", p_payload: {}, p_dedupe: "weekly:" + day }); n++; }
  }
  return n;
}

async function queueConnections() {
  const soon = new Date(Date.now() + 3 * 86400_000).toISOString();
  const { data: sc } = await db.from("social_channels").select("user_id, platform, token_expires_at").lt("token_expires_at", soon).gt("token_expires_at", new Date().toISOString());
  const { data: sup } = await db.from("supplier_connections").select("user_id, supplier, refresh_expires_at").lt("refresh_expires_at", soon);
  let n = 0;
  for (const c of sc || []) { await db.rpc("assistant_enqueue", { p_user: c.user_id, p_kind: "connection", p_payload: { name: c.platform, expires: String(c.token_expires_at).slice(0, 10) }, p_dedupe: "conn:" + c.platform + ":" + String(c.token_expires_at).slice(0, 10) }); n++; }
  for (const c of sup || []) { await db.rpc("assistant_enqueue", { p_user: c.user_id, p_kind: "connection", p_payload: { name: c.supplier, expires: String(c.refresh_expires_at).slice(0, 10) }, p_dedupe: "conn:" + c.supplier + ":" + String(c.refresh_expires_at).slice(0, 10) }); n++; }
  return n;
}

// WhatsApp 24 saat dışı bildirim şablonu (Seltigo'nun WhatsApp hesabında)
const WA_TEMPLATES = [{
  name: "seltigo_asistan_bildirim_v1", language: "tr", category: "UTILITY",
  components: [{ type: "BODY", text: "Seltigo mağaza bildirimi: {{1}}\n\nAyrıntı ve işlemler için bu mesaja cevap yazabilirsin.", example: { body_text: [["Yeni sipariş: Çelik termos 500 ml, 1 adet, 349,90 TL"]] } }],
}];
async function waTemplates() {
  const waba = env("ASSISTANT_WA_WABA_ID") || env("ASSISTANT_WABA_ID"), token = env("ASSISTANT_WA_TOKEN");
  if (!waba || !token) return { ok: false, dry: true, templates: WA_TEMPLATES, note: "ASSISTANT_WABA_ID / ASSISTANT_WA_TOKEN girilince onaya gönderilir" };
  const out: unknown[] = [];
  const ex = await (await fetch(`https://graph.facebook.com/v21.0/${waba}/message_templates?limit=200`, { headers: { Authorization: `Bearer ${token}` } })).json();
  for (const t of WA_TEMPLATES) {
    const found = (ex?.data || []).find((x: any) => x.name === t.name && x.language === t.language);
    if (found) { out.push({ name: t.name, status: found.status }); continue; }
    const r = await fetch(`https://graph.facebook.com/v21.0/${waba}/message_templates`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(t) });
    out.push({ name: t.name, created: await r.json().catch(() => null) });
  }
  return { ok: true, templates: out };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    const sys = !!CRON_SECRET && String(b?.cronSecret || "").trim() === CRON_SECRET.trim();
    if (sys) {
      if (b.action === "test") {
        const bytes = b.fileBase64 ? Uint8Array.from(atob(String(b.fileBase64)), (c) => c.charCodeAt(0)) : null;
        const kind = !bytes ? undefined : String(b.mime || "").startsWith("image/") ? "image" : String(b.mime || "").startsWith("audio/") ? "audio" : "document";
        const r = await handleIncoming({
          channel: "test", externalId: String(b.externalId || "test"), name: "Test", text: b.text, callback: b.callback,
          file: bytes ? { kind: kind as any, mime: b.mime, filename: b.filename, bytes: async () => bytes } : undefined,
        });
        return json({ ok: true, linked: !!r.link, replies: r.replies.map((x) => ({ ...x, document: x.document ? { filename: x.document.filename, size: x.document.bytes.length } : undefined })) });
      }
      if (b.action === "outbox") return json({ ok: true, results: await runOutbox() });
      if (b.action === "reports") return json({ ok: true, queued: await queueReports() });
      if (b.action === "connections") return json({ ok: true, queued: await queueConnections() });
      if (b.action === "wa_templates") return json(await waTemplates());
      if (b.action === "telegram_webhook") {
        const secret = env("TELEGRAM_WEBHOOK_SECRET");
        const r = await telegramApi("setWebhook", { url: `${SUPABASE_URL}/functions/v1/telegram-bot`, secret_token: secret || undefined, allowed_updates: ["message", "callback_query"] });
        const me = await telegramApi("getMe", {});
        return json({ ok: !!r?.ok, setWebhook: r, bot: me?.result?.username || null });
      }
      if (b.action === "link_code" && b.userId) return json(await makeCode(String(b.userId), b));
      return json({ error: "Geçersiz işlem" }, 400);
    }
    // Satıcı
    // Proje deseni: oturum anahtarı gövdede (userAccessToken); eski çağrılar için Authorization başlığı da kabul
    const bearer = String(b?.userAccessToken || (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")).trim();
    const { data } = bearer.split(".").length === 3 ? await db.auth.getUser(bearer) : { data: { user: null } };
    const userId = data?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
    if (b.action === "link_code") return json(await makeCode(userId, b));
    if (b.action === "test") {
      // Satıcının kendi test sohbeti (yalnız kendi verisi; "test" kanalı, kod ile bağlanır)
      const bytes = b.fileBase64 ? Uint8Array.from(atob(String(b.fileBase64)), (c) => c.charCodeAt(0)) : null;
      const kind = !bytes ? undefined : String(b.mime || "").startsWith("image/") ? "image" : String(b.mime || "").startsWith("audio/") ? "audio" : "document";
      const r = await handleIncoming({
        channel: "test", externalId: "web:" + userId + ":" + String(b.externalId || "1").slice(0, 40), name: "Test", text: b.text, callback: b.callback,
        file: bytes ? { kind: kind as any, mime: b.mime, filename: b.filename, bytes: async () => bytes } : undefined,
      });
      if (r.link && r.link.user_id !== userId) return json({ error: "yetkisiz" }, 403);
      return json({ ok: true, linked: !!r.link, replies: r.replies.map((x) => ({ ...x, document: x.document ? { filename: x.document.filename, size: x.document.bytes.length } : undefined })) });
    }
    if (b.action === "status") {
      const me = env("TELEGRAM_BOT_TOKEN") ? await telegramApi("getMe", {}) : null;
      return json({
        ok: true,
        telegram: { live: !!me?.result?.username, bot: me?.result?.username || null },
        whatsapp: { live: env("ASSISTANT_WA_ENABLED") === "true", number: env("ASSISTANT_WA_DISPLAY_NUMBER") || null, test: env("ASSISTANT_WA_TEST") !== "false" },
        instagram: { live: env("ASSISTANT_META_ENABLED") === "true" }, messenger: { live: env("ASSISTANT_META_ENABLED") === "true" },
      });
    }
    return json({ error: "Geçersiz işlem" }, 400);
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message, 300) }, 500);
  }
});

async function makeCode(userId: string, b: any) {
  const channel = String(b.channel || "");
  if (!["telegram", "whatsapp", "instagram", "messenger", "test"].includes(channel)) return { ok: false, error: "Geçersiz kanal" };
  const role = ["full", "products", "orders"].includes(b.role) ? b.role : "full";
  const code = code8();
  const { error } = await db.from("assistant_link_codes").insert({ code, user_id: userId, channel, role, is_owner: b.isOwner !== false });
  if (error) throw error;
  let deepLink: string | null = null;
  if (channel === "telegram") {
    const me = env("TELEGRAM_BOT_TOKEN") ? await telegramApi("getMe", {}) : null;
    if (me?.result?.username) deepLink = `https://t.me/${me.result.username}?start=${code}`;
  }
  if (channel === "whatsapp" && env("ASSISTANT_WA_DISPLAY_NUMBER")) {
    deepLink = `https://wa.me/${env("ASSISTANT_WA_DISPLAY_NUMBER").replace(/\D/g, "")}?text=${encodeURIComponent("BAĞLA " + code)}`;
  }
  return { ok: true, code, deepLink, expiresInMinutes: 30 };
}
