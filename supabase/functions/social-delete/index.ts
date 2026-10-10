// Supabase Edge Function: social-delete
// Seltigo'dan yapılan paylaşımları tek tıkla siler: önce platformdan (Facebook, Instagram, Telegram),
// sonra Seltigo'daki paylaşım geçmişinden.

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

// Gönderi zaten silinmişse (ör. satıcı platformdan elle sildiyse) bunu başarı say
function alreadyGone(msg: string) {
  return /does not exist|cannot be loaded|unsupported (delete|get) request|not found|message to delete not found|object with id/i.test(msg);
}

async function deleteFromPlatform(post: any, ch: any): Promise<string | null> {
  if (!post.post_id || post.status !== "posted") return null; // platforma hiç gitmemiş
  if (!ch) return null; // hesap bağlantısı kaldırılmış: sadece listeden sil

  if (post.platform === "facebook" || post.platform === "instagram") {
    // Hikayelerde birden çok kare olabilir (virgülle saklanır): hepsini sil
    const ids = String(post.post_id).split(",").map((x) => x.trim()).filter(Boolean);
    let lastErr = "";
    for (const pid of ids) {
      const url = `${GRAPH}/${pid}?access_token=${encodeURIComponent(ch.access_token || "")}`;
      const r = await fetch(url, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (d.success === true || r.ok) continue;
      const msg = String(d.error?.message || "Silinemedi");
      if (alreadyGone(msg)) continue;
      lastErr = msg;
    }
    if (!lastErr) return null;
    if (post.platform === "instagram") {
      return post.kind === "story"
        ? "Instagram hikayeleri dışarıdan silinemiyor; 24 saat sonra kendiliğinden kaybolur ya da Instagram'dan silebilirsin."
        : "Instagram bu gönderiyi dışarıdan silmeye izin vermedi. Instagram uygulamasından silebilirsin.";
    }
    return lastErr;
  }

  if (post.platform === "telegram") {
    if (!TELEGRAM_BOT_TOKEN) return "Telegram botu kurulu değil";
    // Albümlerde birden çok mesaj numarası virgülle saklanır: hepsini sil
    const msgIds = String(post.post_id).split(",").map((x) => Number(x)).filter((x) => x > 0);
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ch.account_id, message_ids: msgIds }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) return null;
    const msg = String(d.description || "Silinemedi");
    if (alreadyGone(msg)) return null;
    return msg;
  }

  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userAccessToken, postIds } = await req.json().catch(() => ({}));
    if (!userAccessToken) return json({ error: "Oturum bilgisi gerekli" }, 400);
    const ids = (Array.isArray(postIds) ? postIds : []).map(String).slice(0, 100);
    if (!ids.length) return json({ error: "Silinecek paylaşım seçilmedi" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + userAccessToken } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser(userAccessToken);
    if (userErr || !userData?.user) return json({ error: "Oturum geçersiz" }, 401);
    const userId = userData.user.id;

    const { data: posts, error } = await supabase
      .from("social_posts").select("*").eq("user_id", userId).in("id", ids);
    if (error) throw error;
    if (!posts?.length) return json({ deleted: 0, failed: [] });

    const chIds = Array.from(new Set(posts.map((p: any) => p.channel_id).filter(Boolean)));
    const { data: chans } = chIds.length
      ? await supabase.from("social_channels").select("*").eq("user_id", userId).in("id", chIds)
      : { data: [] as any[] };
    const chById: Record<string, any> = {};
    (chans || []).forEach((c: any) => { chById[c.id] = c; });

    let deleted = 0;
    const failed: { id: string; error: string }[] = [];
    for (const p of posts) {
      let err: string | null = null;
      try {
        err = await deleteFromPlatform(p, chById[p.channel_id]);
      } catch (e) {
        err = String((e as Error)?.message || e);
      }
      if (err) {
        failed.push({ id: p.id, error: err });
        continue;
      }
      const { error: delErr } = await supabase.from("social_posts").delete().eq("id", p.id);
      if (delErr) failed.push({ id: p.id, error: delErr.message });
      else deleted++;
    }

    return json({ ok: true, deleted, failed });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});