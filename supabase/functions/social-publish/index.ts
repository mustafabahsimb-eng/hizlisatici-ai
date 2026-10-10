// Supabase Edge Function: social-publish
// Seçilen ürünleri, seçilen sosyal medya hesaplarına otomatik paylaşır.
// Her paylaşım social_posts tablosuna yazılır (Sırada -> Gönderiliyor -> Paylaşıldı / Hata).
// Platformlar: Telegram, Facebook (sayfa), Instagram (işletme hesabı).
// Çoklu resim: Instagram'da kaydırmalı gönderi (20 resim), Facebook'ta çoklu fotoğraf (20 resim), Telegram'da albüm (10 resim).
// Paylaşım türü: Gönderi, Hikaye (24 saat) ya da ikisi birden. Hikaye: Instagram + Facebook (Telegram'da hikaye yok, gönderi gider).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const GRAPH = "https://graph.facebook.com/v21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function escHtml(s: string) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(v: number, cur: string) {
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency: cur || "TRY" }).format(v);
  } catch {
    return `${v} ${cur || ""}`.trim();
  }
}

function plain(s: string, max: number) {
  const t = String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trim() + "…" : t;
}

// ---------- Telegram ----------
async function tg(method: string, params: Record<string, unknown>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const d = await r.json();
    if (d.ok) return d;
    const wait = d.parameters?.retry_after;
    if (r.status === 429 && wait && wait <= 30) { await sleep(wait * 1000 + 300); continue; }
    return d;
  }
  return { ok: false, description: "Telegram çok yoğun, sonra tekrar dene" };
}

// ---------- Facebook / Instagram ----------
async function fb(path: string, params: Record<string, string>, method = "POST") {
  const body = new URLSearchParams(params);
  const url = GRAPH + path + (method === "GET" ? "?" + body.toString() : "");
  const r = await fetch(url, method === "GET" ? {} : { method: "POST", body });
  const d = await r.json().catch(() => ({}));
  if (d.error) throw new Error(d.error.error_user_msg || d.error.message || "Facebook hatası");
  return d;
}

function niceMetaError(msg: string) {
  if (/expired|session has been invalidated|validating access token/i.test(msg)) return "Bağlantının süresi dolmuş, hesabı tekrar bağla";
  if (/permission|not authorized|requires/i.test(msg)) return "Paylaşım izni yok, hesabı tekrar bağla ve tüm izinleri ver";
  if (/aspect ratio/i.test(msg)) return "Instagram bu görselin oranını kabul etmedi";
  if (/media type|image format|only.*jpe?g/i.test(msg)) return "Instagram bu görsel türünü kabul etmedi (JPG olmalı)";
  return msg;
}

async function waitIgReady(id: string, token: string) {
  for (let i = 0; i < 20; i++) {
    const s = await fb(`/${id}`, { fields: "status_code", access_token: token }, "GET");
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error("Instagram görseli işleyemedi");
    await sleep(1500);
  }
}

async function postFacebook(ch: any, text: string, images: string[]) {
  const token = ch.access_token;
  const image = images[0] || null;
  if (images.length > 1) {
    // Çoklu fotoğraf: önce resimleri yayınlamadan yükle, sonra tek gönderide birleştir
    const ids: string[] = [];
    for (const url of images) {
      try {
        const ph = await fb(`/${ch.account_id}/photos`, { url, published: "false", access_token: token });
        if (ph.id) ids.push(String(ph.id));
      } catch { /* yüklenemeyen resmi atla */ }
    }
    if (ids.length) {
      const params: Record<string, string> = { message: text, access_token: token };
      ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
      const d = await fb(`/${ch.account_id}/feed`, params);
      return { id: String(d.id), url: `https://www.facebook.com/${d.id}` };
    }
  }
  if (image) {
    const d = await fb(`/${ch.account_id}/photos`, { url: image, caption: text, access_token: token });
    const pid = d.post_id || d.id;
    return { id: String(pid), url: `https://www.facebook.com/${pid}` };
  }
  const d = await fb(`/${ch.account_id}/feed`, { message: text, access_token: token });
  return { id: String(d.id), url: `https://www.facebook.com/${d.id}` };
}

async function postInstagram(ch: any, text: string, images: string[]) {
  if (!images.length) throw new Error("Instagram'da paylaşmak için ürünün görseli olmalı");
  const token = ch.access_token;
  let creationId = "";
  if (images.length > 1) {
    // Kaydırmalı gönderi (carousel): her resmi ayrı hazırla, sonra birleştir
    const children: string[] = [];
    for (const url of images) {
      try {
        const it = await fb(`/${ch.account_id}/media`, { image_url: url, is_carousel_item: "true", access_token: token });
        await waitIgReady(it.id, token);
        children.push(String(it.id));
      } catch { /* kabul edilmeyen resmi atla */ }
    }
    if (children.length >= 2) {
      const car = await fb(`/${ch.account_id}/media`, {
        media_type: "CAROUSEL", children: children.join(","), caption: text, access_token: token,
      });
      await waitIgReady(car.id, token);
      creationId = car.id;
    }
  }
  if (!creationId) {
    // Tek resim
    const c = await fb(`/${ch.account_id}/media`, { image_url: images[0], caption: text, access_token: token });
    await waitIgReady(c.id, token);
    creationId = c.id;
  }
  const c = { id: creationId };
  // Yayınla
  const p = await fb(`/${ch.account_id}/media_publish`, { creation_id: c.id, access_token: token });
  let url = "";
  try {
    const m = await fb(`/${p.id}`, { fields: "permalink", access_token: token }, "GET");
    url = m.permalink || "";
  } catch { /* bağlantı alınamazsa sorun değil */ }
  return { id: String(p.id), url };
}

// ---------- Hikaye (24 saat) ----------
async function storyInstagram(ch: any, images: string[]) {
  if (!images.length) throw new Error("Hikaye için ürünün görseli olmalı");
  const token = ch.access_token;
  const ids: string[] = [];
  let lastErr = "";
  for (const url of images.slice(0, 10)) {
    try {
      const c = await fb(`/${ch.account_id}/media`, { image_url: url, media_type: "STORIES", access_token: token });
      await waitIgReady(c.id, token);
      const p = await fb(`/${ch.account_id}/media_publish`, { creation_id: c.id, access_token: token });
      ids.push(String(p.id));
    } catch (e) { lastErr = String((e as Error)?.message || e); }
  }
  if (!ids.length) throw new Error(lastErr || "Hikaye paylaşılamadı");
  const uname = ch.extra?.username;
  return { id: ids.join(","), url: uname ? `https://www.instagram.com/stories/${uname}/` : "" };
}

async function storyFacebook(ch: any, images: string[]) {
  if (!images.length) throw new Error("Hikaye için ürünün görseli olmalı");
  const token = ch.access_token;
  const ids: string[] = [];
  let lastErr = "";
  for (const url of images.slice(0, 10)) {
    try {
      const ph = await fb(`/${ch.account_id}/photos`, { url, published: "false", access_token: token });
      const st = await fb(`/${ch.account_id}/photo_stories`, { photo_id: String(ph.id), access_token: token });
      ids.push(String(st.post_id || st.id || ph.id));
    } catch (e) { lastErr = String((e as Error)?.message || e); }
  }
  if (!ids.length) throw new Error(lastErr || "Hikaye paylaşılamadı");
  return { id: ids.join(","), url: `https://www.facebook.com/${ch.account_id}` };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userAccessToken, productIds, channelIds, footer, allImages, mode } = await req.json().catch(() => ({}));
    // Paylaşım türü: "post" (gönderi), "story" (hikaye), "both" (ikisi)
    const shareMode = mode === "story" || mode === "both" ? mode : "post";
    const useAll = allImages !== false; // varsayılan: tüm resimler
    // Satıcının gönderinin sonuna eklemek istediği yazı/link (isteğe bağlı, satıcı ne yazarsa)
    const extra = String(footer || "").trim().slice(0, 500);
    if (!userAccessToken) return json({ error: "Oturum bilgisi gerekli" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser(userAccessToken);
    if (userErr || !userData?.user) return json({ error: "Oturum geçersiz" }, 401);
    const userId = userData.user.id;

    const pIds = (Array.isArray(productIds) ? productIds : []).map(String).slice(0, 50);
    const cIds = (Array.isArray(channelIds) ? channelIds : []).map(String).slice(0, 20);
    if (!pIds.length) return json({ error: "Ürün seçilmedi" }, 400);
    if (!cIds.length) return json({ error: "Hesap seçilmedi" }, 400);

    const [prodRes, chanRes, listRes, imgRes] = await Promise.all([
      supabase.from("products").select("*").eq("user_id", userId).in("id", pIds),
      supabase.from("social_channels").select("*").eq("user_id", userId).eq("active", true).in("id", cIds),
      supabase.from("listings").select("product_id, price, currency").in("product_id", pIds)
        .eq("marketplace_code", "own_store").is("deleted_at", null),
      supabase.from("product_images").select("product_id, url, position").in("product_id", pIds)
        .order("position", { ascending: true }),
    ]);
    if (prodRes.error) throw prodRes.error;
    if (chanRes.error) throw chanRes.error;

    const products = prodRes.data || [];
    const channels = chanRes.data || [];
    if (!products.length) return json({ error: "Ürün bulunamadı" }, 400);
    if (!channels.length) return json({ error: "Bağlı hesap bulunamadı" }, 400);

    const listing: Record<string, any> = {};
    (listRes.data || []).forEach((l: any) => { listing[String(l.product_id)] = l; });
    const gallery: Record<string, string[]> = {};
    (imgRes.data || []).forEach((r: any) => {
      const k = String(r.product_id);
      (gallery[k] = gallery[k] || []).push(r.url);
    });
    const isUrl = (u: any) => typeof u === "string" && /^https?:\/\//i.test(u);

    // 1) Her hesap için, platformuna uygun metni hazırla ve "Sırada" olarak kaydet
    const jobs: any[] = [];
    for (const ch of channels) {
      for (const p of products) {
        const l = listing[String(p.id)];
        const price = l && Number(l.price) > 0 ? Number(l.price) : (Number(p.sale_price) > 0 ? Number(p.sale_price) : null);
        const cur = l && Number(l.price) > 0 ? (l.currency || "TRY") : (p.cost_currency || "TRY");
        const name = p.generated_title || p.name || "";
        const desc = plain(p.generated_description || p.description || "", 350);
        // Ana resim önce, sonra diğer resimler (tekrarsız, en fazla 20)
        const all = Array.from(new Set([p.image_url, ...(gallery[String(p.id)] || [])].filter(isUrl))).slice(0, 20);
        const images: string[] = useAll ? all : all.slice(0, 1);
        const image = images[0] || null;
        const priceTxt = price != null ? money(price, cur) : "";

        let caption = "";
        if (ch.platform === "telegram") {
          const lines = [`<b>${escHtml(name)}</b>`];
          if (p.is_bundle) lines.push("📦 Paket fırsatı");
          if (desc) lines.push("", escHtml(desc));
          if (priceTxt) lines.push("", `💰 <b>${escHtml(priceTxt)}</b>`);
          if (extra) lines.push("", escHtml(extra));
          caption = lines.join("\n").slice(0, 1024);
        } else {
          // Facebook / Instagram: düz yazı
          const lines = [name];
          if (p.is_bundle) lines.push("📦 Paket fırsatı");
          if (desc) lines.push("", desc);
          if (priceTxt) lines.push("", `💰 ${priceTxt}`);
          if (extra) lines.push("", extra);
          caption = lines.join("\n").slice(0, 2200);
        }
        // Telegram'da hikaye yok: orada her zaman gönderi
        const kinds = ch.platform === "telegram" ? ["post"]
          : shareMode === "both" ? ["post", "story"] : [shareMode];
        for (const kind of kinds) jobs.push({ ch, p, caption, image, images, kind });
      }
    }

    const { data: inserted, error: insErr } = await supabase.from("social_posts").insert(
      jobs.map((j) => ({
        user_id: userId,
        product_id: j.p.id,
        channel_id: j.ch.id,
        platform: j.ch.platform,
        status: "pending",
        caption: j.caption,
        image_url: j.image,
        kind: j.kind,
      })),
    ).select("id");
    if (insErr) throw insErr;
    jobs.forEach((j, i) => { j.postId = inserted?.[i]?.id; });

    // 2) Gönder
    let posted = 0;
    let failed = 0;
    const lastSent: Record<string, number> = {};

    for (const j of jobs) {
      const upd = async (fields: Record<string, unknown>) => {
        if (j.postId) await supabase.from("social_posts").update(fields).eq("id", j.postId);
      };
      const ok = async (id: string | null, url: string | null) => {
        await upd({ status: "posted", post_id: id, post_url: url || null, posted_at: new Date().toISOString(), error: null });
        posted++;
      };
      const fail = async (msg: string) => {
        await upd({ status: "error", error: String(msg).slice(0, 300) });
        failed++;
      };
      await upd({ status: "posting" });

      // Aynı hesaba art arda gönderirken platform sınırına takılmamak için kısa ara
      const key = j.ch.platform + ":" + j.ch.account_id;
      const prev = lastSent[key] || 0;
      const gap = Date.now() - prev;
      if (prev && gap < 1100) await sleep(1100 - gap);

      try {
        if (j.ch.platform === "telegram") {
          if (!TELEGRAM_BOT_TOKEN) { await fail("Telegram botu henüz kurulmadı"); continue; }
          let res: any = { ok: false };
          let msgIds: number[] = [];
          if (j.images.length > 1) {
            // Albüm: yazı ilk resmin altında görünür (Telegram en fazla 10 resim kabul ediyor)
            res = await tg("sendMediaGroup", {
              chat_id: j.ch.account_id,
              media: j.images.slice(0, 10).map((u: string, i: number) => i === 0
                ? { type: "photo", media: u, caption: j.caption, parse_mode: "HTML" }
                : { type: "photo", media: u }),
            });
            if (res.ok) msgIds = (res.result || []).map((m: any) => m.message_id);
          }
          if (!res.ok && j.image) {
            res = await tg("sendPhoto", { chat_id: j.ch.account_id, photo: j.image, caption: j.caption, parse_mode: "HTML" });
            if (res.ok) msgIds = [res.result?.message_id];
          }
          if (!res.ok) {
            res = await tg("sendMessage", { chat_id: j.ch.account_id, text: j.caption, parse_mode: "HTML" });
            if (res.ok) msgIds = [res.result?.message_id];
          }
          if (res.ok) {
            const msgId = msgIds[0];
            const uname = j.ch.extra?.username;
            // Albümde tüm mesaj numaralarını sakla (silerken hepsi silinsin)
            await ok(msgIds.length ? msgIds.join(",") : null, uname && msgId ? `https://t.me/${uname}/${msgId}` : null);
          } else {
            const d = String(res.description || "Telegram hatası");
            await fail(/not enough rights|chat not found|bot was kicked|not a member/i.test(d)
              ? "Bot kanalda yönetici değil, hesabı tekrar bağla" : d);
          }
        } else if (j.kind === "story" && j.ch.platform === "instagram") {
          const r = await storyInstagram(j.ch, j.images);
          await ok(r.id, r.url);
        } else if (j.kind === "story" && j.ch.platform === "facebook") {
          const r = await storyFacebook(j.ch, j.images);
          await ok(r.id, r.url);
        } else if (j.ch.platform === "facebook") {
          const r = await postFacebook(j.ch, j.caption, j.images);
          await ok(r.id, r.url);
        } else if (j.ch.platform === "instagram") {
          const r = await postInstagram(j.ch, j.caption, j.images);
          await ok(r.id, r.url);
        } else {
          await fail("Bu platform yakında açılacak");
        }
      } catch (e) {
        await fail(niceMetaError(String((e as Error)?.message || e)));
      }
      lastSent[key] = Date.now();
    }

    return json({ ok: true, queued: jobs.length, posted, failed });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});