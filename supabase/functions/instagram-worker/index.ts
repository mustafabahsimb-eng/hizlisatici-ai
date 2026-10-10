import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GRAPH = "https://graph.instagram.com/v23.0";
const MAX_ATTEMPTS = 5;
const BATCH = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

// CRON_SECRET: başlıktan, adres parametresinden veya gövdeden kabul edilir
async function authorized(req: Request): Promise<boolean> {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) return false;
  const cands: string[] = [];
  req.headers.forEach((v) => cands.push(v, v.replace(/^Bearer\s+/i, "")));
  new URL(req.url).searchParams.forEach((v) => cands.push(v));
  try {
    const body = await req.clone().json();
    if (body && typeof body === "object") {
      Object.values(body).forEach((v) => { if (typeof v === "string") cands.push(v); });
    }
  } catch { /* gövde yok */ }
  return cands.includes(secret);
}

async function makeCaption(p: any): Promise<string> {
  const title = p.generated_title || p.name || "";
  const desc = String(p.generated_description || "").slice(0, 1500);
  const price = p.sale_price ? `${p.sale_price}` : "";
  const fallback = [title, desc.slice(0, 600), price ? `Fiyat: ${price}` : ""].filter(Boolean).join("\n\n");
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return fallback.slice(0, 2100);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 700,
        messages: [{
          role: "user",
          content:
            `Bir e-ticaret ürünü için Instagram gönderi açıklaması yaz. Dil: ${p.content_language === "en" ? "İngilizce" : "Türkçe"}.\n` +
            `Kurallar: dikkat çeken ilk satır, 2-4 kısa paragraf, ürünün faydaları, uygun yerlerde az sayıda emoji, ` +
            `fiyat varsa belirt, sonda "Sipariş için DM" gibi kısa bir çağrı, en sonda 8-12 alakalı hashtag. ` +
            `Toplam 2000 karakteri geçme. Sadece açıklama metnini yaz.\n\n` +
            `Ürün adı: ${title}\nAçıklama: ${desc}\nFiyat: ${price}`,
        }],
      }),
    });
    const data = await res.json();
    const text = (data?.content || []).map((c: any) => c?.text || "").join("").trim();
    return (text || fallback).slice(0, 2150);
  } catch {
    return fallback.slice(0, 2100);
  }
}

Deno.serve(async (req) => {
  if (!(await authorized(req))) return json({ error: "yetkisiz" }, 401);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const report = { refreshed: 0, refreshFailed: 0, published: 0, failed: 0, retried: 0 };

  // ---------- A) Anahtar yenileme (süresi 7 günden az kalanlar) ----------
  try {
    const soon = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const { data: chans } = await supabase
      .from("social_channels")
      .select("id, token_expires_at")
      .eq("platform", "instagram")
      .neq("active", false)
      .lt("token_expires_at", soon)
      .gt("token_expires_at", new Date().toISOString())
      .limit(20);

    for (const c of chans || []) {
      try {
        const { data: tok } = await supabase.rpc("social_channel_get_token", { p_channel_id: c.id });
        if (!tok) throw new Error("anahtar yok");
        const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tok)}`);
        const j = await r.json();
        if (!r.ok || !j?.access_token) throw new Error(j?.error?.message || "yenilenemedi");
        await supabase.rpc("social_channel_set_token", { p_channel_id: c.id, p_token: j.access_token });
        await supabase.from("social_channels").update({
          token_expires_at: new Date(Date.now() + (Number(j.expires_in) || 5184000) * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", c.id);
        report.refreshed++;
      } catch {
        report.refreshFailed++;
      }
    }
  } catch { /* yenileme hatası kuyruğu durdurmasın */ }

  // ---------- B) Takılı kalan işleri geri al (10 dk'dan eski 'processing') ----------
  await supabase.from("social_posts")
    .update({ status: "pending", updated_at: new Date().toISOString() })
    .eq("platform", "instagram").eq("status", "processing")
    .lt("updated_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  // ---------- C) Kuyruğu işle ----------
  const { data: jobs } = await supabase
    .from("social_posts")
    .select("*")
    .eq("platform", "instagram")
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .lt("attempts", MAX_ATTEMPTS)
    .order("scheduled_at", { ascending: true })
    .limit(BATCH);

  for (const job of jobs || []) {
    // Sahiplen (aynı işi iki kez almasın)
    const { data: claimed } = await supabase.from("social_posts")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", job.id).eq("status", "pending")
      .select("id").maybeSingle();
    if (!claimed) continue;

    try {
      const { data: ch } = await supabase.from("social_channels")
        .select("id, account_id, active").eq("id", job.channel_id).maybeSingle();
      if (!ch || ch.active === false) throw new Error("Instagram hesabı bulunamadı veya pasif");

      const { data: token } = await supabase.rpc("social_channel_get_token", { p_channel_id: ch.id });
      if (!token) throw new Error("Erişim anahtarı yok");

      const { data: p } = await supabase.from("products")
        .select("id, name, generated_title, generated_description, sale_price, image_url, content_language, deleted_at")
        .eq("id", job.product_id).maybeSingle();
      if (!p || p.deleted_at) {
        await supabase.from("social_posts").update({
          status: "canceled", error: "Ürün silinmiş", updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        continue;
      }

      const image = job.image_url || p.image_url;
      if (!image || !/^https?:\/\//i.test(image)) throw new Error("Ürünün herkese açık görseli henüz yok");

      const caption = job.caption || await makeCaption(p);

      const cRes = await fetch(`${GRAPH}/${ch.account_id}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ image_url: image, caption, access_token: token }),
      });
      const created = await cRes.json();
      if (!cRes.ok || !created?.id) throw new Error(created?.error?.message || "Instagram görseli kabul etmedi");

      let status = "IN_PROGRESS";
      for (let i = 0; i < 10; i++) {
        const s = await (await fetch(`${GRAPH}/${created.id}?fields=status_code&access_token=${encodeURIComponent(token)}`)).json();
        status = s?.status_code || status;
        if (status === "FINISHED") break;
        if (status === "ERROR" || status === "EXPIRED") throw new Error("Instagram görseli işleyemedi");
        await sleep(3000);
      }

      const pRes = await fetch(`${GRAPH}/${ch.account_id}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ creation_id: created.id, access_token: token }),
      });
      const pub = await pRes.json();
      if (!pRes.ok || !pub?.id) throw new Error(pub?.error?.message || "Gönderi yayınlanamadı");

      let permalink: string | null = null;
      try {
        permalink = (await (await fetch(`${GRAPH}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(token)}`)).json())?.permalink || null;
      } catch { /* link şart değil */ }

      await supabase.from("social_posts").update({
        status: "published",
        post_id: pub.id,
        post_url: permalink,
        caption,
        image_url: image,
        error: null,
        posted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      report.published++;
    } catch (e) {
      const attempts = (job.attempts || 0) + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await supabase.from("social_posts").update({
        status: giveUp ? "failed" : "pending",
        attempts,
        error: String((e as Error)?.message || e).slice(0, 500),
        scheduled_at: new Date(Date.now() + attempts * 5 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      giveUp ? report.failed++ : report.retried++;
    }
  }

  return json({ ok: true, ...report });
});