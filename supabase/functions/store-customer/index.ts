// =========================================================
// Seltigo - store-customer: mağaza müşteri hesabı (her mağazada ayrı; satıcı hesabından bağımsız)
//   POST { action: "register", store_slug, email, password, name?, phone? } -> { token, customer }
//   POST { action: "login", store_slug, email, password }                  -> { token, customer }
//   POST { action: "logout", token }
//   POST { action: "me", token }                                           -> müşteri + siparişler (takip bağlantılarıyla)
//   POST { action: "update", token, name?, phone?, addresses? }
// Parola bcrypt (pgcrypto, yalnız sunucuda). Oturum anahtarı 30 gün; yalnız özeti saklanır. Deneme sınırı: IP + mağaza başına saatte 20.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { featureEnabled } from "../_shared/features.ts";
import { randomToken, sha256Hex } from "../_shared/site-guard.ts";

const SITE = "https://mustafabahsimb-eng.github.io/hizlisatici-ai";
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

async function session(customerId: string) {
  const token = "stc_" + randomToken(24);
  await db.from("store_customer_sessions").insert({ token_hash: await sha256Hex(token), customer_id: customerId, expires_at: new Date(Date.now() + 30 * 86400_000).toISOString() });
  await db.from("store_customers").update({ last_login_at: new Date().toISOString() }).eq("id", customerId);
  return token;
}
async function fromToken(token: string) {
  if (!/^stc_[0-9a-f]{48}$/.test(token)) return null;
  const { data: s } = await db.from("store_customer_sessions").select("customer_id, expires_at").eq("token_hash", await sha256Hex(token)).maybeSingle();
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
  const { data: c } = await db.from("store_customers").select("id, user_id, email, name, phone, addresses, created_at").eq("id", s.customer_id).maybeSingle();
  return c;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
    if (b.action === "register" || b.action === "login") {
      const { data: store } = await db.from("store_settings").select("user_id, store_slug").eq("store_slug", clean(b.store_slug, 100)).maybeSingle();
      if (!store) return json({ ok: false, error: "Mağaza bulunamadı" }, 404);
      if (!(await featureEnabled(store.user_id, "store_checkout"))) return json({ ok: false, error: "Müşteri hesabı bu mağazada kapalı" }, 403);
      const { data: lim } = await db.rpc("rate_hit", { p_key: `cust:${ip}:${store.user_id}`, p_limit: 20, p_window_seconds: 3600 });
      if (lim === false) return json({ ok: false, error: "Çok fazla deneme; biraz sonra tekrar dene." }, 429);
      const email = clean(b.email, 160).toLowerCase(), pw = String(b.password || "");
      if (!EMAIL.test(email)) return json({ ok: false, error: "Geçerli bir e-posta yaz" }, 400);
      if (b.action === "register") {
        if (pw.length < 8) return json({ ok: false, error: "Parola en az 8 karakter olmalı" }, 400);
        const { data: id, error } = await db.rpc("store_customer_register", { p_user: store.user_id, p_email: email, p_name: clean(b.name, 120) || null, p_phone: clean(b.phone, 30) || null, p_password: pw });
        if (error) return json({ ok: false, error: error.code === "23505" ? "Bu e-postayla hesap var; giriş yap." : "Hesap açılamadı" }, 400);
        // Daha önce bu e-postayla verilmiş siparişler hesaba bağlanır
        await db.from("store_checkouts").update({ customer_id: id }).eq("user_id", store.user_id).ilike("email", email).is("customer_id", null);
        await db.from("store_orders").update({ customer_id: id }).eq("user_id", store.user_id).ilike("customer_email", email).is("customer_id", null);
        return json({ ok: true, token: await session(id), customer: { id, email, name: clean(b.name, 120) || null } });
      }
      const { data: id } = await db.rpc("store_customer_check", { p_user: store.user_id, p_email: email, p_password: pw });
      if (!id) return json({ ok: false, error: "E-posta ya da parola hatalı" }, 401);
      const { data: c } = await db.from("store_customers").select("id, email, name, phone").eq("id", id).single();
      return json({ ok: true, token: await session(id), customer: c });
    }
    const token = clean(b.token, 80);
    if (b.action === "logout") { await db.from("store_customer_sessions").delete().eq("token_hash", await sha256Hex(token)); return json({ ok: true }); }
    const c = await fromToken(token);
    if (!c) return json({ ok: false, error: "Oturum süresi doldu; tekrar giriş yap.", expired: true }, 401);
    if (b.action === "me") {
      const { data: cos } = await db.from("store_checkouts").select("id, created_at, total, currency, payment_method, payment_status, items, order_ids").eq("customer_id", c.id).order("created_at", { ascending: false }).limit(50);
      const ids = (cos || []).flatMap((x: any) => x.order_ids || []);
      const { data: ords } = ids.length ? await db.from("store_orders").select("id, status, tracking_token, tracking_number, shipped_at, delivered_at").in("id", ids) : { data: [] };
      const om = new Map((ords || []).map((o: any) => [o.id, o]));
      return json({
        ok: true, customer: { id: c.id, email: c.email, name: c.name, phone: c.phone, addresses: c.addresses },
        orders: (cos || []).map((x: any) => ({
          id: x.id, created_at: x.created_at, total: x.total, currency: x.currency, payment_method: x.payment_method, payment_status: x.payment_status,
          items: (x.items || []).map((l: any) => ({ name: l.name, variant_label: l.variant_label, qty: l.qty, image: l.image })),
          shipments: (x.order_ids || []).map((id: string) => om.get(id)).filter(Boolean).map((o: any) => ({ status: o.status, tracking_url: `${SITE}/takip.html?t=${o.tracking_token}`, shipped_at: o.shipped_at, delivered_at: o.delivered_at })),
        })),
      });
    }
    if (b.action === "update") {
      const patch: any = {};
      if (b.name !== undefined) patch.name = clean(b.name, 120);
      if (b.phone !== undefined) patch.phone = clean(b.phone, 30);
      if (Array.isArray(b.addresses)) patch.addresses = b.addresses.slice(0, 5).map((a: any) => ({ title: clean(a.title, 40), text: clean(a.text, 500), city: clean(a.city, 60), district: clean(a.district, 60), zip: clean(a.zip, 12) }));
      await db.from("store_customers").update(patch).eq("id", c.id);
      return json({ ok: true });
    }
    return json({ ok: false, error: "Geçersiz işlem" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Sunucu hatası" }, 500);
  }
});
