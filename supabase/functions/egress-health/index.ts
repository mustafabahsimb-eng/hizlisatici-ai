// =========================================================
// Seltigo - egress-health (sabit IP sunucusunun sağlık kontrolü)
// 10 dakikada bir (zamanlanmış görev, CRON_SECRET):
//   - Anahtar kapalıysa sadece kayıt düşer (hiçbir şey proxy'den çıkmaz).
//   - Açıksa proxy üzerinden çıkış IP'sini sorar; IP sunucunun adresiyle aynıysa status=ok.
//   - Art arda 2 başarısız kontrolde status=down: fonksiyonlar doğrudan bağlantıya döner
//     (_shared/egress.ts). Sunucu düzelince ilk başarılı kontrolde kendiliğinden ok'a döner.
// Sistem denemesi (kaydetmez): { cronSecret, test: { host, port?, username?, password? } }
//   -> sunucuyu açmadan önce bağlantıyı sınamak için.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { egressState, installEgress, proxyClient, resetEgressForTest, supportsProxy } from "../_shared/egress.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const PROXY_PASSWORD = Deno.env.get("EGRESS_PROXY_PASSWORD") ?? "";
// api64: sunucu IPv6 ile çıkarsa onu da gösterir (hedefler IPv4'ü görmeli)
const IP_URL = "https://api64.ipify.org?format=json";
const TARGET_URL = "https://developers.cjdropshipping.com/"; // izinli bir hedefe tünel açılabiliyor mu
const DOWN_AFTER = 2;

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);

async function timed(url: string, init: any, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

async function directIp(): Promise<string | null> {
  try { return (await (await timed(IP_URL, {})).json())?.ip || null; } catch (_) { return null; }
}

// Proxy üzerinden çıkış IP'si + hedefe tünel
async function probe(host: string, port: number, username: string, password: string) {
  if (!supportsProxy()) return { ok: false, error: "Çalışma ortamı proxy desteklemiyor (Deno.createHttpClient yok)" };
  if (!password) return { ok: false, error: "EGRESS_PROXY_PASSWORD tanımlı değil" };
  const client = proxyClient({ host, port, username }, password);
  try {
    const r = await timed(IP_URL, { client });
    if (r.status === 407) return { ok: false, error: "Proxy şifreyi kabul etmedi (407)" };
    const ip = (await r.json().catch(() => null))?.ip || null;
    if (!ip) return { ok: false, error: `IP alınamadı (HTTP ${r.status})` };
    if (ip !== host) return { ok: false, ip, error: `Çıkış IP'si beklenenden farklı: ${ip} (beklenen ${host})` };
    const t = await timed(TARGET_URL, { client, method: "HEAD" });
    if (t.status === 403 && (t.headers.get("server") || "").toLowerCase().includes("squid")) {
      return { ok: false, ip, error: "Proxy CJ adresine izin vermiyor (izinli-alanlar.txt)" };
    }
    return { ok: true, ip, target: t.status };
  } catch (e) {
    return { ok: false, error: "Proxy'ye bağlanılamadı: " + short((e as Error).message, 200) };
  }
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(body?.cronSecret || "").trim() !== CRON_SECRET.trim()) return json({ error: "unauthorized" }, 401);

  try {
    // Kaydetmeyen deneme
    if (body?.test?.host) {
      const t = body.test;
      const r = await probe(String(t.host), Number(t.port || 3128), String(t.username || "seltigo"), String(t.password || PROXY_PASSWORD));
      return json({ ok: true, test: r, proxySupported: supportsProxy(), directIp: await directIp() });
    }

    // Uçtan uca yol denemesi (kaydetmez): global fetch sarılır, IP adresi istenir.
    // egress_proxy.hosts içinde api64.ipify.org varsa istek proxy'den çıkmaya çalışır;
    // proxy yoksa doğrudan bağlantıya dönüşü (yedek yol) gösterir.
    if (body?.selfTest === true) {
      installEgress();
      resetEgressForTest();
      const t0 = Date.now();
      let ip: string | null = null, err: string | null = null;
      try { ip = (await (await fetch(IP_URL)).json())?.ip || null; } catch (e) { err = short((e as Error).message); }
      const st = egressState();
      return json({ ok: true, ip, err, ms: Date.now() - t0, fellBack: st.breakerActive, proxySupported: supportsProxy(), config: st.config });
    }

    const { data: c, error } = await db.from("egress_proxy").select("*").eq("id", 1).maybeSingle();
    if (error) throw error;
    const now = new Date().toISOString();
    if (!c?.enabled || !c.host) {
      await db.from("egress_proxy").update({ last_check_at: now }).eq("id", 1);
      return json({ ok: true, enabled: false, proxySupported: supportsProxy(), passwordSet: !!PROXY_PASSWORD, directIp: await directIp() });
    }

    const r: any = await probe(c.host, Number(c.port), c.username, PROXY_PASSWORD);
    if (r.ok) {
      await db.from("egress_proxy").update({
        status: "ok", fail_count: 0, last_ok_at: now, last_check_at: now, last_ip: r.ip, updated_at: now,
      }).eq("id", 1);
    } else {
      const fails = Number(c.fail_count || 0) + 1;
      await db.from("egress_proxy").update({
        status: fails >= DOWN_AFTER ? "down" : c.status, fail_count: fails, last_check_at: now,
        last_ip: r.ip || c.last_ip, last_error: short(r.error), last_error_at: now, updated_at: now,
      }).eq("id", 1);
    }
    return json({ ok: true, enabled: true, previous: c.status, result: r });
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
