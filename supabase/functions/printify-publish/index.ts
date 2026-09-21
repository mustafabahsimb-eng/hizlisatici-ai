import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function pf(token: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch("https://api.printify.com/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "User-Agent": "HizliSatici-AI",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.errors?.reason || data?.message || data?.error || data?.raw || ("HTTP " + res.status);
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

function cleanTitle(t: string) {
  return String(t || "").replace(/["“”]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
}
function cleanTags(tags: unknown): string[] {
  const arr = Array.isArray(tags) ? tags : [];
  const out: string[] = [];
  for (const t of arr) {
    const s = String(t || "").replace(/["“”]/g, "").trim().slice(0, 20).trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 13) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json();
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey);

    // Kullanıcıyı doğrula
    const { data: u, error: ue } = await admin.auth.getUser(String(b.userAccessToken || ""));
    if (ue || !u?.user) return json({ ok: false, error: "Oturum doğrulanamadı, tekrar giriş yap" });
    const userId = u.user.id;

    // Printify token'ı sunucudan al
    const { data: conn, error: ce } = await admin
      .from("printify_connections").select("*").eq("user_id", userId).maybeSingle();
    if (ce) return json({ ok: false, error: "Bağlantı okunamadı: " + ce.message });
    if (!conn) return json({ ok: false, error: "Printify bağlı değil" });
    const token = conn.api_token || conn.token || conn.access_token || conn.printify_token || conn.api_key;
    if (!token) return json({ ok: false, error: "Token kolonu bulunamadı. Kolonlar: " + Object.keys(conn).join(", ") });

    if (b.action !== "publish") return json({ ok: false, error: "Bilinmeyen işlem" });

    const productId = String(b.productId || "");
    const srcShop = String(b.sourceShopId || "");
    const targets: string[] = (Array.isArray(b.targetShopIds) ? b.targetShopIds : []).map(String);
    if (!productId || !srcShop || !targets.length) return json({ ok: false, error: "Eksik bilgi (ürün ya da mağaza)" });
    if (targets.length > 8) return json({ ok: false, error: "Tek seferde en fazla 8 mağaza seçilebilir" });

    const title = cleanTitle(b.title);
    const description = String(b.description || "").trim();
    const tags = cleanTags(b.tags);
    if (!title) return json({ ok: false, error: "Başlık boş" });
    if (!description) return json({ ok: false, error: "Açıklama boş" });

    // Kaynak ürünü oku
    const src = await pf(token, `/shops/${srcShop}/products/${productId}.json`);
    const enabled = (src.variants || []).filter((v: any) => v.is_enabled);
    if (!enabled.length) return json({ ok: false, error: "Üründe aktif varyant yok" });
    const enabledIds = new Set(enabled.map((v: any) => v.id));

    // Tasarımı olmayan (boş) baskı alanları Printify'da hata verir, o yüzden çıkarılır
    const printAreas = (src.print_areas || [])
      .map((pa: any) => ({
        variant_ids: (pa.variant_ids || []).filter((id: number) => enabledIds.has(id)),
        placeholders: (pa.placeholders || [])
          .map((ph: any) => ({
            position: ph.position,
            images: (ph.images || []).map((i: any) => ({ id: i.id, x: i.x, y: i.y, scale: i.scale, angle: i.angle })),
          }))
          .filter((ph: any) => ph.images.length),
      }))
      .filter((pa: any) => pa.variant_ids.length && pa.placeholders.length);
    if (!printAreas.length) return json({ ok: false, error: "Üründe tasarım (görsel) bulunamadı" });

    const publishFlags = {
      title: true, description: true, images: true, variants: true,
      tags: true, keyFeatures: true, shipping_template: true,
    };

    const results: any[] = [];
    for (const shopId of targets) {
      try {
        let pid = productId;
        if (shopId === srcShop) {
          // Aynı mağaza: ürünün metnini güncelle
          await pf(token, `/shops/${shopId}/products/${productId}.json`, "PUT", { title, description, tags });
        } else {
          const created = await pf(token, `/shops/${shopId}/products.json`, "POST", {
            title, description, tags,
            blueprint_id: src.blueprint_id,
            print_provider_id: src.print_provider_id,
            variants: enabled.map((v: any) => ({ id: v.id, price: v.price, is_enabled: true })),
            print_areas: printAreas,
          });
          pid = created.id;
        }
        await pf(token, `/shops/${shopId}/products/${pid}/publish.json`, "POST", publishFlags);
        results.push({ shopId, ok: true, productId: pid });
      } catch (e) {
        results.push({ shopId, ok: false, error: (e as Error).message });
      }
    }
    return json({ ok: true, results });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message });
  }
});