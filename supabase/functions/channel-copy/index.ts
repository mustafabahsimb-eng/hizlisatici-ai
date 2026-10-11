import { featureEnabled, FEATURE_OFF_MSG, userIdFromToken } from "../_shared/features.ts";
// =========================================================
// Seltigo - channel-copy ("✨ Metni kanala göre yaz")
// Linkten / dosyadan çekilen ürünlerin başlık ve açıklamasını seçilen satış kanalının
// kurallarına ve üslubuna göre yeniden yazar (toplu, en fazla 8 ürün / istek).
// Kaynak metindeki bilgilere sadık kalır; uydurma özellik, iddia, iletişim bilgisi eklemez.
// POST { channel: own_store | trendyol | hepsiburada | n11 | instagram | whatsapp | etsy | amazon,
//        language?: "tr" | "en", items: [{ name, description, specs:[{k,v}], brand, category }] }
// -> { items: [{ title, description }] }  (aynı sırada)
// Sadece giriş yapmış kullanıcılar kullanabilir.
// =========================================================
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODELS = ["claude-sonnet-5-5", "claude-sonnet-4-6"];
const MAX_ITEMS = 8;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function hsIsLoggedIn(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token.split(".").length !== 3) return false;
  try {
    const r = await fetch((Deno.env.get("SUPABASE_URL") ?? "") + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!u?.id;
  } catch { return false; }
}

// Kanal kuralları (başlık sınırı + üslup)
const CHANNELS: Record<string, { lang: "tr" | "en"; titleMax: number; rules: string }> = {
  own_store: { lang: "tr", titleMax: 80, rules: "Seller's own web store. SEO-friendly clear title (brand + product type + key feature). Description: 1 short intro paragraph, then 4-6 bullet lines starting with '• ' covering key features/specs, then a usage/care line if relevant. Warm, trustworthy tone." },
  trendyol: { lang: "tr", titleMax: 100, rules: "Trendyol marketplace. Title format: Brand + product type + key attributes (material, size, color, model). NO promotional words (indirim, kampanya, en ucuz, bedava, orijinal garantili), NO emojis, NO all-caps, NO other site names, NO contact info or links. Description: plain factual paragraphs and '• ' bullet lines with specifications; no HTML." },
  hepsiburada: { lang: "tr", titleMax: 100, rules: "Hepsiburada marketplace. Brand + model + product type + key attribute. No promotional words, emojis, links or contact info. Factual description with '• ' bullets." },
  n11: { lang: "tr", titleMax: 100, rules: "n11 marketplace. Brand + product type + key attributes. No promotional words, emojis, links or contact info. Factual description with '• ' bullets." },
  instagram: { lang: "tr", titleMax: 60, rules: "Instagram shopping post. Title: short catchy product name. Description = caption: hook first line, 3-5 short lines with a few fitting emojis, a call to action like 'Sipariş için DM' style without phone numbers, then 8-12 relevant Turkish hashtags on the last line." },
  whatsapp: { lang: "tr", titleMax: 60, rules: "WhatsApp catalog / message. Title: short product name. Description: max 400 characters, friendly, 3-4 short lines with key features, at most 2 emojis, no hashtags." },
  etsy: { lang: "en", titleMax: 140, rules: "Etsy listing in English. Title: descriptive keyword-rich phrases separated by commas or ' - ' (what it is, material, style, use/gift). Description: engaging intro, bullet list of details/materials/dimensions, care instructions if relevant." },
  amazon: { lang: "en", titleMax: 150, rules: "Amazon listing in English. Title: Brand + product type + key features + size/color/quantity. No promotional claims. Description: 5 bullet points starting with a short CAPITALIZED benefit label, then one product description paragraph." },
};

function extractJson(text: string): any {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function ask(system: string, user: string): Promise<any> {
  for (const model of MODELS) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 8000, system, messages: [{ role: "user", content: user }] }),
      });
      const d = await r.json();
      if (!r.ok) { console.error(model, d?.error?.message); continue; }
      const text = (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      const parsed = extractJson(text);
      if (parsed) return parsed;
    } catch (e) { console.error(model, e); }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const fUid = await userIdFromToken(req.headers.get("Authorization"));
  if (!fUid) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);
  if (!(await featureEnabled(fUid, "ai_copy"))) return json({ error: FEATURE_OFF_MSG, feature: "ai_copy" }, 403);
  if (!ANTHROPIC_API_KEY) return json({ error: "Yapay zekâ anahtarı tanımlı değil" }, 500);
  const body = await req.json().catch(() => ({}));
  const ch = CHANNELS[String(body?.channel || "own_store")] || CHANNELS.own_store;
  const lang = body?.language === "en" ? "en" : ch.lang;
  const items = (Array.isArray(body?.items) ? body.items : []).slice(0, MAX_ITEMS).map((it: any) => ({
    name: clean(it?.name, 300),
    brand: clean(it?.brand, 80),
    category: clean(it?.category, 200),
    description: clean(it?.description, 3000),
    specs: (Array.isArray(it?.specs) ? it.specs : []).slice(0, 30).map((s: any) => `${clean(s?.k, 60)}: ${clean(s?.v, 120)}`),
  }));
  if (!items.length) return json({ error: "Ürün yok" }, 400);

  const system = `You are an e-commerce copywriter. Rewrite product titles and descriptions for the given sales channel.
Channel rules: ${ch.rules}
Output language: ${lang === "tr" ? "Turkish (natural, correct Turkish with proper characters)" : "English"}. Translate source text if it is in another language.
Title max ${ch.titleMax} characters.
Strict rules: use ONLY facts present in the source (name, brand, specs, description). Never invent materials, sizes, certifications, warranty, origin or health claims. Never add phone numbers, links, prices or shipping promises. Keep model codes and brand names exactly as given. Plain text, no HTML, no markdown headings.
Answer ONLY with JSON: {"items":[{"title":"","description":""}]} with exactly one entry per input product, in the same order.`;
  const user = JSON.stringify({ products: items });
  const ai = await ask(system, user);
  const out = Array.isArray(ai?.items) ? ai.items : null;
  if (!out || out.length !== items.length) return json({ error: "Metin yazılamadı, tekrar dene." }, 502);
  return json({
    items: out.map((o: any) => ({ title: clean(o?.title, ch.titleMax), description: String(o?.description ?? "").trim().slice(0, 5000) })),
  });
});
