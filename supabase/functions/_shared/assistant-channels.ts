// =========================================================
// Seltigo Asistan - kanal göndericileri (Telegram, WhatsApp, Instagram DM, Messenger, test)
// Anahtar yoksa ya da kanal kapalıysa gönderim yapılmaz; ne gönderileceği "dry" olarak döner (testler bunu kullanır).
// Secrets:
//   TELEGRAM_BOT_TOKEN                      -> Telegram (canlı)
//   ASSISTANT_WA_ENABLED=true, ASSISTANT_WA_PHONE_ID, ASSISTANT_WA_TOKEN   -> WhatsApp (Seltigo'nun numarası; test numarası ya da gerçek)
//   ASSISTANT_META_ENABLED=true, ASSISTANT_PAGE_TOKEN, ASSISTANT_IG_TOKEN  -> Messenger / Instagram (sandbox)
// =========================================================
export type Button = { id: string; title: string };
export type Reply = { text: string; buttons?: Button[]; document?: { bytes: Uint8Array; filename: string }; link?: { title: string; url: string } };
export type SendResult = { ok: boolean; dry?: boolean; error?: string; payload?: unknown };

const env = (k: string) => Deno.env.get(k) ?? "";
const short = (v: unknown, n = 200) => String(v ?? "").slice(0, n);

// ---------- Telegram ----------
export async function telegramApi(method: string, body: unknown): Promise<any> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return { ok: false, dry: true };
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  return await r.json().catch(() => ({ ok: false }));
}
export async function telegramFile(fileId: string): Promise<Uint8Array> {
  const token = env("TELEGRAM_BOT_TOKEN");
  const f = await telegramApi("getFile", { file_id: fileId });
  if (!f?.ok) throw new Error("Telegram dosyası alınamadı (en fazla 20 MB)");
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("Telegram dosyası indirilemedi");
  return new Uint8Array(await r.arrayBuffer());
}
async function sendTelegram(chatId: string, rep: Reply): Promise<SendResult> {
  const kb = [
    ...(rep.buttons || []).map((b) => [{ text: b.title, callback_data: b.id.slice(0, 64) }]),
    ...(rep.link ? [[{ text: rep.link.title, url: rep.link.url }]] : []),
  ];
  const payload: any = { chat_id: chatId, text: rep.text.slice(0, 4000), disable_web_page_preview: true };
  if (kb.length) payload.reply_markup = { inline_keyboard: kb };
  if (!env("TELEGRAM_BOT_TOKEN")) return { ok: true, dry: true, payload };
  if (rep.document) {
    const token = env("TELEGRAM_BOT_TOKEN");
    const fd = new FormData();
    fd.append("chat_id", chatId);
    fd.append("document", new Blob([rep.document.bytes as BlobPart], { type: "application/pdf" }), rep.document.filename);
    await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: fd, signal: AbortSignal.timeout(60000) });
  }
  const r = await telegramApi("sendMessage", payload);
  return r?.ok ? { ok: true, payload } : { ok: false, error: short(r?.description), payload };
}

// ---------- WhatsApp (Seltigo'nun numarası) ----------
const GRAPH = "https://graph.facebook.com/v21.0";
const waOn = () => env("ASSISTANT_WA_ENABLED") === "true" && !!env("ASSISTANT_WA_PHONE_ID") && !!env("ASSISTANT_WA_TOKEN");
export async function whatsappMedia(mediaId: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const h = { Authorization: `Bearer ${env("ASSISTANT_WA_TOKEN")}` };
  const m = await (await fetch(`${GRAPH}/${mediaId}`, { headers: h })).json();
  if (!m?.url) throw new Error("WhatsApp dosyası alınamadı");
  if (Number(m.file_size) > 20 * 1024 * 1024) throw new Error("Dosya çok büyük (en fazla 20 MB)");
  const r = await fetch(m.url, { headers: h, signal: AbortSignal.timeout(60000) });
  return { bytes: new Uint8Array(await r.arrayBuffer()), mime: m.mime_type || "" };
}
async function waPost(body: unknown): Promise<any> {
  const r = await fetch(`${GRAPH}/${env("ASSISTANT_WA_PHONE_ID")}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${env("ASSISTANT_WA_TOKEN")}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return await r.json().catch(() => ({}));
}
async function waUpload(bytes: Uint8Array, filename: string): Promise<string | null> {
  const fd = new FormData();
  fd.append("messaging_product", "whatsapp");
  fd.append("type", "application/pdf");
  fd.append("file", new Blob([bytes as BlobPart], { type: "application/pdf" }), filename);
  const r = await fetch(`${GRAPH}/${env("ASSISTANT_WA_PHONE_ID")}/media`, { method: "POST", headers: { Authorization: `Bearer ${env("ASSISTANT_WA_TOKEN")}` }, body: fd });
  const d = await r.json().catch(() => ({}));
  return d?.id || null;
}
// windowOpen: kullanıcı son 24 saatte yazdı mı (Meta kuralı). Kapalıysa onaylı şablonla gönderilir.
async function sendWhatsApp(phone: string, rep: Reply, windowOpen: boolean): Promise<SendResult> {
  let payload: any;
  if (!windowOpen) {
    payload = {
      messaging_product: "whatsapp", to: phone, type: "template",
      template: { name: "seltigo_asistan_bildirim_v1", language: { code: "tr" }, components: [{ type: "body", parameters: [{ type: "text", text: rep.text.replace(/\s+/g, " ").slice(0, 900) }] }] },
    };
  } else if (rep.buttons?.length) {
    // WhatsApp: en fazla 3 buton (başlık en fazla 20 karakter)
    payload = {
      messaging_product: "whatsapp", to: phone, type: "interactive",
      interactive: { type: "button", body: { text: rep.text.slice(0, 1024) }, action: { buttons: rep.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) } },
    };
  } else {
    payload = { messaging_product: "whatsapp", to: phone, type: "text", text: { body: (rep.text + (rep.link ? `\n${rep.link.title}: ${rep.link.url}` : "")).slice(0, 4096), preview_url: false } };
  }
  if (!waOn()) return { ok: true, dry: true, payload };
  if (rep.document && windowOpen) {
    const id = await waUpload(rep.document.bytes, rep.document.filename);
    if (id) await waPost({ messaging_product: "whatsapp", to: phone, type: "document", document: { id, filename: rep.document.filename } });
  }
  const d = await waPost(payload);
  return d?.messages?.[0]?.id ? { ok: true, payload } : { ok: false, error: short(d?.error?.message || JSON.stringify(d)), payload };
}

// ---------- Messenger / Instagram DM (sandbox; yalnız 24 saat penceresinde) ----------
const metaOn = () => env("ASSISTANT_META_ENABLED") === "true";
async function sendMeta(kind: "messenger" | "instagram", recipient: string, rep: Reply, windowOpen: boolean): Promise<SendResult> {
  const text = rep.text.slice(0, kind === "instagram" ? 900 : 1900);
  const payload: any = { recipient: { id: recipient }, messaging_type: "RESPONSE", message: { text } };
  if (rep.buttons?.length) payload.message.quick_replies = rep.buttons.slice(0, 13).map((b) => ({ content_type: "text", title: b.title.slice(0, 20), payload: b.id }));
  if (!windowOpen) return { ok: false, error: "24 saat penceresi kapalı (Meta kuralı); bildirim WhatsApp / Telegram'dan gider", payload };
  const token = kind === "instagram" ? env("ASSISTANT_IG_TOKEN") : env("ASSISTANT_PAGE_TOKEN");
  if (!metaOn() || !token) return { ok: true, dry: true, payload };
  const r = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
  });
  const d = await r.json().catch(() => ({}));
  return d?.message_id ? { ok: true, payload } : { ok: false, error: short(d?.error?.message), payload };
}

// ---------- Ortak ----------
export async function sendReply(db: any, link: { channel: string; external_id: string; user_id?: string; last_inbound_at?: string | null }, rep: Reply): Promise<SendResult> {
  const windowOpen = !!link.last_inbound_at && Date.now() - new Date(link.last_inbound_at).getTime() < 24 * 3600_000;
  let r: SendResult;
  if (link.channel === "telegram") r = await sendTelegram(link.external_id, rep);
  else if (link.channel === "whatsapp") r = await sendWhatsApp(link.external_id, rep, windowOpen);
  else if (link.channel === "messenger" || link.channel === "instagram") r = await sendMeta(link.channel, link.external_id, rep, windowOpen);
  else {
    await db.from("assistant_test_inbox").insert({ user_id: link.user_id || null, external_id: link.external_id, reply: { ...rep, document: rep.document ? { filename: rep.document.filename, size: rep.document.bytes.length } : undefined } });
    r = { ok: true, dry: true };
  }
  if (r.ok && !r.dry && link.user_id) await db.from("assistant_messages").insert({ user_id: link.user_id, channel: link.channel, direction: "out" });
  return r;
}
