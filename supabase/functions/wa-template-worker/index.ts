// =========================================================
// Seltigo - wa-template-worker (WhatsApp kargo şablonu: otomatik onaya gönder + takip)
// Meta, mesaj şablonlarını her WhatsApp Business hesabı (WABA) için ayrı onaylar.
// Bu görev, bağlı her WhatsApp hesabı için kargo bildirimi şablonunu:
//   - henüz gönderilmediyse Meta'ya onaya gönderir
//   - onay bekliyorsa durumunu sorar (Onaylandı / Reddedildi)
// Satıcının elle bir şey yapması gerekmez.
// Çağıranlar: zamanlanmış görev (CRON_SECRET) ve social-meta-connect
// (bağlantı anında, { cronSecret, userId } ile sadece o satıcı için).
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const GRAPH = "https://graph.facebook.com/v21.0";
const SITE = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";

// cj-tracking-sync ile aynı şablon (metin değişirse yeni sürüm adı verilmeli: _v2)
const TEMPLATE = {
  name: "seltigo_kargo_takip_v1",
  language: "tr",
  category: "UTILITY",
  components: [
    {
      type: "BODY",
      text: "Merhaba {{1}}, {{2}} mağazasından verdiğin sipariş kargoya verildi. Kargo takip numaran: {{3}}. Kargonun durumunu aşağıdaki bağlantıdan takip edebilirsin.",
      example: { body_text: [["Ayşe", "Örnek Mağaza", "CJ1234567890TR"]] },
    },
    {
      type: "BUTTONS",
      buttons: [{
        type: "URL",
        text: "Kargoyu takip et",
        url: `${SITE}/takip.html?t={{1}}`,
        example: [`${SITE}/takip.html?t=a1b2c3d4e5f6a1b2c3d4e5f6`],
      }],
    },
  ],
};

const DONE = ["APPROVED", "REJECTED", "DISABLED"];
const TIME_BUDGET_MS = 45000;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function graph(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && !d?.error, data: d };
}

async function fetchStatus(wabaId: string, token: string) {
  const q = new URLSearchParams({ name: TEMPLATE.name, fields: "id,name,language,status,rejected_reason" });
  const r = await graph(`/${wabaId}/message_templates?${q}`, token, { method: "GET" });
  if (!r.ok) return { error: String(r.data?.error?.message || "durum alınamadı").slice(0, 200) };
  const t = (r.data?.data || []).find((x: any) => x.name === TEMPLATE.name && String(x.language).toLowerCase().startsWith(TEMPLATE.language));
  return { template: t || null };
}

async function processChannel(ch: any): Promise<string> {
  const wabaId = String(ch.extra?.waba_id || "");
  if (!wabaId || !ch.access_token) return "waba_veya_anahtar_yok";
  const now = new Date().toISOString();

  // Şablon kaydı (yoksa aç)
  let { data: row } = await db
    .from("whatsapp_templates")
    .select("*")
    .eq("channel_id", ch.id)
    .eq("name", TEMPLATE.name)
    .eq("language", TEMPLATE.language)
    .maybeSingle();
  if (!row) {
    const ins = await db.from("whatsapp_templates")
      .insert({ user_id: ch.user_id, channel_id: ch.id, waba_id: wabaId, name: TEMPLATE.name, language: TEMPLATE.language })
      .select("*").single();
    if (ins.error) return "kayıt: " + ins.error.message;
    row = ins.data;
  }
  if (DONE.includes(row.status)) return row.status;

  // Meta'da zaten var mı? (aynı WABA'da başka bir bağlantıdan gönderilmiş olabilir)
  const existing = await fetchStatus(wabaId, ch.access_token);
  if (existing.template) {
    await db.from("whatsapp_templates").update({
      status: String(existing.template.status || "PENDING").toUpperCase(),
      meta_template_id: String(existing.template.id),
      reason: existing.template.rejected_reason && existing.template.rejected_reason !== "NONE" ? String(existing.template.rejected_reason) : null,
      submitted_at: row.submitted_at || now,
      checked_at: now,
      updated_at: now,
    }).eq("id", row.id);
    return String(existing.template.status);
  }

  // Gönder
  const r = await graph(`/${wabaId}/message_templates`, ch.access_token, {
    method: "POST",
    body: JSON.stringify(TEMPLATE),
  });
  if (!r.ok) {
    await db.from("whatsapp_templates").update({
      status: "ERROR",
      reason: String(r.data?.error?.error_user_msg || r.data?.error?.message || "gönderilemedi").slice(0, 300),
      checked_at: now,
      updated_at: now,
    }).eq("id", row.id);
    return "ERROR";
  }
  await db.from("whatsapp_templates").update({
    status: String(r.data?.status || "PENDING").toUpperCase(),
    meta_template_id: r.data?.id ? String(r.data.id) : null,
    reason: null,
    submitted_at: now,
    checked_at: now,
    updated_at: now,
  }).eq("id", row.id);
  return String(r.data?.status || "PENDING");
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(body?.cronSecret || "").trim() !== CRON_SECRET.trim()) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const started = Date.now();
  let q = db.from("social_channels")
    .select("id, user_id, account_id, access_token, extra, active")
    .eq("platform", "whatsapp")
    .eq("active", true);
  if (body?.userId) q = q.eq("user_id", String(body.userId));
  const { data: channels, error } = await q.limit(200);
  if (error) return json({ ok: false, error: error.message }, 500);

  const results: Record<string, string> = {};
  for (const ch of channels || []) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      results[ch.id] = await processChannel(ch);
    } catch (e) {
      results[ch.id] = "hata: " + String((e as Error)?.message || e).slice(0, 200);
    }
  }
  return json({ ok: true, channels: Object.keys(results).length, results, ms: Date.now() - started });
});
