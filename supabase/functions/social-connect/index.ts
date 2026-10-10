// Supabase Edge Function: social-connect
// Satıcının sosyal medya hesabını Seltigo'ya bağlar. Şimdilik: Telegram kanalı.
// Bot (TELEGRAM_BOT_TOKEN) kanala yönetici olarak eklenmiş mi kontrol eder, sonra kanalı kaydeder.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");

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

async function tg(method: string, params: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return await r.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userAccessToken, platform, channel } = await req.json().catch(() => ({}));
    if (!userAccessToken) return json({ error: "Oturum bilgisi gerekli" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser(userAccessToken);
    if (userErr || !userData?.user) return json({ error: "Oturum geçersiz" }, 401);
    const userId = userData.user.id;

    if (platform !== "telegram") return json({ error: "Bu platform henüz hazır değil" }, 400);
    if (!TELEGRAM_BOT_TOKEN) return json({ error: "Telegram botu henüz kurulmadı (TELEGRAM_BOT_TOKEN eksik)" }, 500);

    let chatId = String(channel || "").trim().replace(/^https?:\/\/t\.me\//i, "");
    if (!chatId) return json({ error: "Kanal adı gerekli" }, 400);
    if (!/^-?\d+$/.test(chatId) && !chatId.startsWith("@")) chatId = "@" + chatId;

    // 1) Kanal var mı?
    const chatRes = await tg("getChat", { chat_id: chatId });
    if (!chatRes.ok) {
      return json({ error: "Kanal bulunamadı. Kanal adını kontrol et ve botu kanala yönetici olarak ekle." }, 400);
    }
    const chat = chatRes.result;

    // 2) Bot bu kanalda yönetici mi, paylaşım yapabiliyor mu?
    const me = await tg("getMe", {});
    if (!me.ok) return json({ error: "Telegram botu çalışmıyor (token hatalı olabilir)" }, 500);
    const member = await tg("getChatMember", { chat_id: chat.id, user_id: me.result.id });
    const st = member.ok ? member.result.status : "";
    const canPost = st === "creator" || (st === "administrator" && (chat.type !== "channel" || member.result.can_post_messages !== false));
    if (!canPost) {
      return json({ error: `@${me.result.username} botu bu kanalda yönetici değil. Kanal ayarlarından yönetici olarak ekle ve "Mesaj gönderme" iznini aç.` }, 400);
    }

    // 3) Kaydet
    const row = {
      user_id: userId,
      platform: "telegram",
      account_id: String(chat.id),
      account_name: chat.username ? "@" + chat.username : (chat.title || String(chat.id)),
      extra: { title: chat.title || null, username: chat.username || null, type: chat.type },
      active: true,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from("social_channels")
      .upsert(row, { onConflict: "user_id,platform,account_id" })
      .select()
      .single();
    if (error) throw error;

    return json({ ok: true, channel: data, bot: "@" + me.result.username });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});