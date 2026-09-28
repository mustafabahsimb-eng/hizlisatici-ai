import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const EU = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);
const EUROPE_OTHER = new Set(["GB", "CH", "NO", "IS"]);
const TARGETS = ["DE", "PL", "IT", "GB", "US", "CA"];

// Sağlayıcı listesi bellekte 30 dk önbellekte tutulur (katalog limiti dakikada 100 istek)
let providersCache: { at: number; map: Map<number, any> } | null = null;
const CACHE_MS = 30 * 60 * 1000;

async function pf(path: string, token: string) {
  const res = await fetch(`https://api.printify.com${path}`, {
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "User-Agent": "HizliSaticiAI",
    },
  });
  if (res.status === 401 || res.status === 403) throw new Error("TOKEN");
  if (res.status === 429) throw new Error("RATE");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Printify hatası (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

function regionOf(country: string | null) {
  const c = String(country || "").toUpperCase();
  if (EU.has(c)) return "eu";
  if (EUROPE_OTHER.has(c)) return "europe";
  return "other";
}

// Bir ülke için en ucuz "ilk ürün" kargo ücretini bulur; yoksa "dünyanın geri kalanı" tarifesine bakar
function pickShip(profiles: any[], code: string) {
  const scan = (match: (countries: string[]) => boolean) => {
    let best: any = null;
    for (const p of profiles) {
      const countries: string[] = Array.isArray(p.countries) ? p.countries : [];
      if (!match(countries)) continue;
      const f = p.first_item;
      if (!f || typeof f.cost !== "number") continue;
      if (!best || f.cost < best.cost) {
        best = {
          cost: f.cost,
          currency: f.currency || "USD",
          additional: p.additional_items && typeof p.additional_items.cost === "number" ? p.additional_items.cost : null,
        };
      }
    }
    return best;
  };
  const direct = scan((c) => c.includes(code));
  if (direct) return { ...direct, rest: false };
  const rest = scan((c) => c.includes("REST_OF_THE_WORLD"));
  return rest ? { ...rest, rest: true } : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { userAccessToken, action, blueprintId } = await req.json();
    if (!userAccessToken || !action) return json({ ok: false, error: "Eksik bilgi" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(userAccessToken);
    if (authError || !user) return json({ ok: false, error: "Oturum doğrulanamadı" }, 401);

    const { data: conn } = await supabase
      .from("printify_connections")
      .select("api_token")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!conn) return json({ ok: false, error: "Önce Printify hesabını bağlamalısın (Hesaplarım sayfası)" });
    const token = conn.api_token;

    // Bir ürün türü için tüm sağlayıcıları konum, üretim süresi ve ülke bazlı kargo ücretiyle karşılaştır
    if (action === "compare") {
      if (!blueprintId) return json({ ok: false, error: "Ürün türü seçilmedi" }, 400);

      if (!providersCache || Date.now() - providersCache.at > CACHE_MS) {
        const all = await pf("/v1/catalog/print_providers.json", token);
        const map = new Map<number, any>();
        for (const p of Array.isArray(all) ? all : []) map.set(Number(p.id), p);
        providersCache = { at: Date.now(), map };
      }

      const bpProviders = await pf(`/v1/catalog/blueprints/${blueprintId}/print_providers.json`, token);
      const list = (Array.isArray(bpProviders) ? bpProviders : []).slice(0, 40);

      const rows: any[] = [];
      for (let i = 0; i < list.length; i += 8) {
        const batch = list.slice(i, i + 8);
        const part = await Promise.all(batch.map(async (p: any) => {
          const info = providersCache!.map.get(Number(p.id)) || {};
          const loc = info.location || p.location || {};
          const country = loc.country ? String(loc.country).toUpperCase() : null;
          const row: any = {
            id: p.id,
            title: p.title || info.title || String(p.id),
            country,
            city: loc.city || null,
            region: regionOf(country),
            handling_time: null,
            ship: null,
          };
          try {
            const s = await pf(`/v1/catalog/blueprints/${blueprintId}/print_providers/${p.id}/shipping.json`, token);
            row.handling_time = s.handling_time || null;
            const profiles = Array.isArray(s.profiles) ? s.profiles : [];
            const ship: Record<string, any> = {};
            for (const code of TARGETS) ship[code] = pickShip(profiles, code);
            row.ship = ship;
          } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            if (msg === "TOKEN" || msg === "RATE") throw e;
            row.error = "Kargo bilgisi alınamadı";
          }
          return row;
        }));
        rows.push(...part);
      }

      const order: Record<string, number> = { eu: 0, europe: 1, other: 2 };
      rows.sort((a, b) => (order[a.region] - order[b.region]) || String(a.title).localeCompare(String(b.title)));
      return json({ ok: true, targets: TARGETS, providers: rows });
    }

    return json({ ok: false, error: "Bilinmeyen işlem" }, 400);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg === "TOKEN") return json({ ok: false, error: "Printify token'ın geçersiz veya süresi dolmuş, yeniden bağla" });
    if (msg === "RATE") return json({ ok: false, error: "Printify istek limiti doldu, bir dakika sonra tekrar dene" });
    return json({ ok: false, error: msg }, 500);
  }
});