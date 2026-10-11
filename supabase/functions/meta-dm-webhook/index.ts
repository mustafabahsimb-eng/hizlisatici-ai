// =========================================================
// Seltigo Asistan - Instagram DM ve Facebook Messenger bağlayıcısı (sandbox; varsayılan KAPALI)
// Meta webhook'u (object: "page" = Messenger, "instagram" = Instagram DM) -> çekirdek -> cevap.
// Meta kuralı: yalnız kullanıcı yazdıktan sonraki 24 saat içinde cevap; otomatik rapor/uyarı yalnız pencere açıkken.
// Instagram: komut, fotoğraf / link ile ürün ekleme, katalog ekran görüntüsü; Messenger: ayrıca PDF.
// Açmak için secrets: ASSISTANT_META_ENABLED=true, ASSISTANT_PAGE_TOKEN (Messenger), ASSISTANT_IG_TOKEN (Instagram).
// Test (sistem): { cronSecret, metaTest: true, object, entry } -> eşzamanlı işler, gönderilecekleri döndürür.
// =========================================================
import { db, handleIncoming, type Incoming } from "../_shared/assistant-core.ts";
import { sendReply } from "../_shared/assistant-channels.ts";

const APP_SECRET = Deno.env.get("FACEBOOK_CLIENT_SECRET") || "";
const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

async function validSignature(raw: string, header: string | null): Promise<boolean> {
  if (!APP_SECRET || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return header.slice(7) === hex;
}

function toIncoming(object: string, ev: any): Incoming | null {
  const channel = object === "instagram" ? "instagram" : "messenger";
  const sender = String(ev.sender?.id || "");
  if (!sender || ev.message?.is_echo) return null;
  const inc: Incoming = { channel, externalId: sender, text: ev.message?.text || "" };
  if (ev.message?.quick_reply?.payload) inc.callback = ev.message.quick_reply.payload;
  if (ev.postback?.payload) inc.callback = ev.postback.payload;
  const att = (ev.message?.attachments || [])[0];
  if (att?.payload?.url) {
    const url = att.payload.url;
    const kind = att.type === "image" ? "image" : att.type === "audio" ? "audio" : att.type === "file" ? "document" : null;
    if (kind) inc.file = { kind, mime: kind === "image" ? "image/jpeg" : kind === "audio" ? "audio/mp4" : "application/pdf", filename: kind === "document" ? "dosya.pdf" : undefined,
      bytes: async () => new Uint8Array(await (await fetch(url, { signal: AbortSignal.timeout(60000) })).arrayBuffer()) };
  }
  return inc;
}

async function processBody(body: any) {
  const out: unknown[] = [];
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const inc = toIncoming(body.object, ev);
      if (!inc) continue;
      const { link, replies } = await handleIncoming(inc);
      const target = link || { channel: inc.channel, external_id: inc.externalId, last_inbound_at: new Date().toISOString() };
      for (const r of replies) out.push(await sendReply(db, target as any, r));
    }
  }
  return out;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (VERIFY_TOKEN && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }
  const raw = await req.text();
  let body: any = {};
  try { body = JSON.parse(raw || "{}"); } catch (_) { /* boş */ }
  if (CRON_SECRET && body?.cronSecret === CRON_SECRET && body?.metaTest) {
    return new Response(JSON.stringify({ ok: true, sent: await processBody(body) }), { headers: { "Content-Type": "application/json" } });
  }
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) return new Response("Bad signature", { status: 401 });
  if (Deno.env.get("ASSISTANT_META_ENABLED") !== "true") return new Response("OK"); // sandbox kapalıyken yok sayılır
  const task = processBody(body).catch((e) => console.error("meta-dm", String(e)));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(task); else await task;
  return new Response("OK");
});
