// =========================================================
// Seltigo - sabit IP çıkışı (egress proxy) ortak modülü
// Neden: Supabase Edge Function'larının sabit IP'si yok. CJ (aynı IP'den en fazla 3 hesap),
// Trendyol test ortamı ve eMAG IP izni istiyor. Hetzner'deki Squid sunucumuz üzerinden çıkılır.
//
// Kullanım (fonksiyonun en üstünde, başka hiçbir şey değişmez):
//   import { installEgress } from "../_shared/egress.ts";
//   installEgress();
// Bu, global fetch'i sarar: yalnız listedeki alan adlarına giden istekler proxy'den çıkar.
//
// Ayar: public.egress_proxy (tek satır, id=1) — enabled (varsayılan KAPALI), host, port, username,
// hosts (proxy'den çıkacak alan adları), status (egress-health yazar: ok | down | unknown).
// Şifre: Edge Function secret EGRESS_PROXY_PASSWORD (depoda/veritabanında durmaz).
//
// Güvenlik ağı (proxy bozulursa siteyi durdurmaz):
// - Kapalıysa, ayar/şifre eksikse, egress-health "down" dediyse ya da çalışma ortamı proxy
//   desteklemiyorsa: doğrudan bağlantı (bugünkü davranış).
// - Proxy'ye bağlanılamazsa: istek doğrudan bağlantıyla tekrarlanır ve bu kopya 5 dakika
//   boyunca proxy'yi denemez. Hata egress_proxy.last_error'a yazılır.
// - Siparişi tekrarlayabilecek istekler (POST/PUT/PATCH/DELETE) yalnız bağlantı hiç
//   kurulamadıysa tekrarlanır; yanıt beklerken zaman aşımı olursa tekrar edilmez (çift sipariş olmasın).
// =========================================================

type EgressConfig = {
  enabled: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  hosts: string[] | null;
  status: string | null;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROXY_PASSWORD = Deno.env.get("EGRESS_PROXY_PASSWORD") ?? "";

const CONFIG_TTL_MS = 60_000;          // ayar en fazla 1 dakikada bir okunur
const BREAKER_MS = 5 * 60_000;         // proxy hatasından sonra doğrudan bağlantıda kalma süresi
const CONNECT_TIMEOUT_MS = 20_000;     // proxy üzerinden yanıt başlığı bekleme süresi

let origFetch: typeof fetch | null = null;
let cfg: EgressConfig | null = null;
let cfgAt = 0;
let cfgLoading: Promise<EgressConfig | null> | null = null;
let client: any = null;
let clientKey = "";
let breakerUntil = 0;

function supportsProxy(): boolean {
  return typeof (Deno as any).createHttpClient === "function";
}

async function loadConfig(): Promise<EgressConfig | null> {
  if (cfg && Date.now() - cfgAt < CONFIG_TTL_MS) return cfg;
  if (cfgLoading) return cfgLoading;
  cfgLoading = (async () => {
    try {
      const r = await origFetch!(`${SUPABASE_URL}/rest/v1/egress_proxy?id=eq.1&select=enabled,host,port,username,hosts,status`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      });
      const rows = r.ok ? await r.json() : null;
      cfg = Array.isArray(rows) && rows[0] ? rows[0] : { enabled: false, host: null, port: null, username: null, hosts: null, status: null };
    } catch (_) {
      // Ayar okunamadıysa eldeki ayarla devam (yoksa kapalı say)
      cfg = cfg || { enabled: false, host: null, port: null, username: null, hosts: null, status: null };
    }
    cfgAt = Date.now();
    cfgLoading = null;
    return cfg;
  })();
  return cfgLoading;
}

function hostMatches(hostname: string, list: string[]): boolean {
  const h = hostname.toLowerCase();
  return list.some((d) => {
    const x = String(d || "").trim().toLowerCase().replace(/^\*?\./, "");
    return x && (h === x || h.endsWith("." + x));
  });
}

// Proxy istemcisi (ayar değişince yenilenir)
export function proxyClient(c: { host: string; port: number; username: string }, password = PROXY_PASSWORD): any {
  const key = `${c.host}:${c.port}:${c.username}`;
  if (client && clientKey === key) return client;
  try { client?.close?.(); } catch (_) { /* yok say */ }
  client = (Deno as any).createHttpClient({
    proxy: { url: `http://${c.host}:${c.port}`, basicAuth: { username: c.username, password } },
  });
  clientKey = key;
  return client;
}

async function recordError(message: string) {
  try {
    await origFetch!(`${SUPABASE_URL}/rest/v1/egress_proxy?id=eq.1`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ last_error: String(message).slice(0, 300), last_error_at: new Date().toISOString() }),
    });
  } catch (_) { /* kayıt yapılamazsa da istek devam eder */ }
}

// Bu isteğin proxy'den çıkması gerekiyorsa istemciyi döndürür, yoksa null
async function routeFor(url: URL): Promise<any | null> {
  if (Date.now() < breakerUntil) return null;
  const c = await loadConfig();
  if (!c?.enabled || !c.host || !c.port || !c.username || !PROXY_PASSWORD) return null;
  if (c.status === "down") return null;
  if (!hostMatches(url.hostname, c.hosts || [])) return null;
  if (!supportsProxy()) return null;
  return proxyClient({ host: c.host, port: Number(c.port), username: c.username });
}

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

async function egressFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch (_) {
    return origFetch!(input as any, init);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return origFetch!(input as any, init);

  const viaProxy = await routeFor(url).catch(() => null);
  if (!viaProxy) return origFetch!(input as any, init);

  // Gövde tekrar gönderilebilsin diye isteği kopyala
  const req = new Request(input as any, init);
  const backup = req.clone();
  const method = req.method.toUpperCase();

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, CONNECT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  init?.signal?.addEventListener?.("abort", onAbort, { once: true }); // gövde okunurken de geçerli
  try {
    const res = await origFetch!(req, { client: viaProxy, signal: ctrl.signal } as any);
    // Squid'in kendi reddi (izin/yetki): hedefe hiç gidilmedi, doğrudan dene
    if ((res.status === 407 || (res.status === 403 && res.headers.get("server")?.toLowerCase().includes("squid")))) {
      breakerUntil = Date.now() + BREAKER_MS;
      await recordError(`Proxy isteği reddetti (HTTP ${res.status}) ${url.hostname}`);
      return origFetch!(backup);
    }
    return res;
  } catch (e) {
    if (init?.signal?.aborted) throw e; // çağıran iptal etti
    breakerUntil = Date.now() + BREAKER_MS;
    const msg = (e as Error)?.message || String(e);
    await recordError(`${timedOut ? "Zaman aşımı" : "Bağlantı hatası"} (${url.hostname}): ${msg}`);
    if (timedOut && !IDEMPOTENT.has(method)) {
      // İstek hedefe ulaşmış olabilir; tekrar göndermek çift işlem yaratabilir
      throw new Error(`Sabit IP sunucusu yanıt vermedi (${url.hostname}); işlem bir sonraki denemede tekrarlanacak`);
    }
    return origFetch!(backup);
  } finally {
    clearTimeout(timer);
  }
}

// Global fetch'i bir kez sarar. Kapalıyken davranış değişmez.
export function installEgress() {
  if (origFetch) return;
  origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = egressFetch as typeof fetch;
}

// egress-health için: proxy'nin kendisini sınamak (global ayardan bağımsız) ve durum
export function egressState() {
  return { installed: !!origFetch, breakerActive: Date.now() < breakerUntil, config: cfg };
}
export function resetEgressForTest() {
  breakerUntil = 0;
  cfg = null;
  cfgAt = 0;
}
export { supportsProxy, hostMatches };
