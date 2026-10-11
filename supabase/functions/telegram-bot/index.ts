// =========================================================
// Seltigo Asistan - Telegram bağlayıcısı (webhook; canlı, şirket gerektirmez)
// Telegram güncellemelerini çekirdeğe (_shared/assistant-core.ts) verir, cevapları gönderir.
// Güvenlik: Telegram'ın gizli başlığı (TELEGRAM_WEBHOOK_SECRET). Telegram'a hemen 200 dönülür, iş arkada sürer.
// Test: gövdede { cronSecret, update } -> eşzamanlı işler, gönderilecek mesajları döndürür (bot anahtarı yoksa gönderim yapılmaz).
// =========================================================
import { db, handleIncoming, type Incoming } from "../_shared/assistant-core.ts";
import { sendReply, telegramApi, telegramFile } from "../_shared/assistant-channels.ts";

const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

function toIncoming(u: any): { inc: Incoming; chatId: string; cbId?: string } | null {
  if (u.callback_query) {
    const q = u.callback_query;
    const chatId = String(q.message?.chat?.id ?? q.from?.id);
    return { inc: { channel: "telegram", externalId: chatId, name: q.from?.first_name, callback: String(q.data || "") }, chatId, cbId: q.id };
  }
  const m = u.message || u.edited_message;
  if (!m) return null;
  const chatId = String(m.chat.id);
  const inc: Incoming = { channel: "telegram", externalId: chatId, name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" "), text: m.text || m.caption || "" };
  if (m.photo?.length) {
    const ph = m.photo[m.photo.length - 1];
    inc.file = { kind: "image", mime: "image/jpeg", filename: "foto.jpg", bytes: () => telegramFile(ph.file_id) };
  } else if (m.document) {
    const d = m.document;
    const kind = String(d.mime_type || "").startsWith("image/") ? "image" : "document";
    inc.file = { kind, mime: d.mime_type, filename: d.file_name, bytes: () => telegramFile(d.file_id) };
  } else if (m.voice || m.audio) {
    const a = m.voice || m.audio;
    inc.file = { kind: "audio", mime: a.mime_type || "audio/ogg", filename: "ses.ogg", bytes: () => telegramFile(a.file_id) };
  }
  return { inc, chatId };
}

async function processUpdate(u: any) {
  const x = toIncoming(u);
  if (!x) return [];
  if (x.cbId) await telegramApi("answerCallbackQuery", { callback_query_id: x.cbId });
  if (x.inc.file) await telegramApi("sendChatAction", { chat_id: x.chatId, action: "typing" });
  const { link, replies } = await handleIncoming(x.inc);
  const target = link || { channel: "telegram", external_id: x.chatId, last_inbound_at: new Date().toISOString() };
  const out = [];
  for (const r of replies) out.push(await sendReply(db, target as any, r));
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const body = await req.json().catch(() => ({}));
  // Test (sistem): eşzamanlı, gönderilecekleri döndürür
  if (CRON_SECRET && String(body?.cronSecret || "").trim() === CRON_SECRET.trim()) {
    const out = await processUpdate(body.update || {});
    return new Response(JSON.stringify({ ok: true, sent: out }), { headers: { "Content-Type": "application/json" } });
  }
  if (SECRET && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== SECRET) return new Response("unauthorized", { status: 401 });
  // Telegram'a hemen dön; iş arkada
  const task = processUpdate(body).catch((e) => console.error("telegram", String(e)));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(task); else await task;
  return new Response("ok");
});
