// =========================================================
// HızlıSatıcı AI - trendyol-match
// Bir ürün için yapay zekâ ile Trendyol eşleştirmesi ÖNERİR:
//   1) Trendyol kategorisi (en alt kategori)
//   2) Marka (ürün metninde marka geçiyorsa Trendyol'daki karşılığı)
//   3) Kategorinin zorunlu özellikleri (renk, beden, materyal...)
// Hiçbir şeyi kaydetmez, sadece öneri döndürür. Kaydetme ekranda yapılır.
//
// Girdi: { listing_id }  ya da  { title, description, category_key }
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const AI_MODEL = "claude-sonnet-5";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errMsg(e) {
  if (!e) return "unknown_error";
  if (typeof e === "string") return e;
  return e.message || JSON.stringify(e);
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------
// Yapay zekâ: sadece JSON cevap ister
// ---------------------------------------------------------
async function askJson(system, user, maxTokens = 800) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("ai_error: " + JSON.stringify(data).slice(0, 300));
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("ai_bad_json");
  return JSON.parse(text.slice(start, end + 1));
}

// trendyol-catalog fonksiyonunu sunucu olarak çağır
async function catalog(body) {
  const res = await fetch(SUPABASE_URL + "/functions/v1/trendyol-catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error("catalog_error: " + (data.error || res.status));
  return data;
}

// ---------------------------------------------------------
// 1) Anahtar kelimeler + marka tahmini
// ---------------------------------------------------------
async function extractKeywords(productText) {
  const system =
    "Sen Trendyol kategori uzmanısın. Verilen ürün için Trendyol kategori ağacında (Türkçe kategori adları) " +
    "arama yapmak üzere 6 kısa Türkçe anahtar kelime üret. Kelimeler tek kelime, küçük harf ve kategori adlarında " +
    "geçebilecek türden olsun (ör. 'pijama', 'kulaklık', 'kadın', 'telefon', 'mutfak'). En belirleyici olanı başa yaz. " +
    "Ürün metninde açıkça bir marka adı geçiyorsa brand alanına yaz, yoksa null yaz. Marka uydurma. " +
    'SADECE tek satır JSON döndür: {"keywords":["..."],"brand":null}';
  const out = await askJson(system, productText, 300);
  const keywords = (out.keywords || [])
    .map((k) => String(k || "").toLocaleLowerCase("tr-TR").trim())
    .filter((k) => k.length >= 2)
    .slice(0, 8);
  const brand = out.brand ? String(out.brand).trim() : null;
  return { keywords, brand };
}

// ---------------------------------------------------------
// 2) Aday kategoriler (kendi tablomuzdan)
// ---------------------------------------------------------
async function findCandidates(keywords) {
  const score = new Map();
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i].replace(/[\\%_]/g, (m) => "\\" + m);
    const { data, error } = await db
      .from("trendyol_categories")
      .select("id, path")
      .eq("is_leaf", true)
      .ilike("path", "%" + kw + "%")
      .limit(80);
    if (error) throw error;
    const weight = keywords.length - i; // baştaki kelime daha önemli
    for (const c of data || []) {
      const cur = score.get(c.id) || { id: c.id, path: c.path, score: 0 };
      cur.score += weight;
      score.set(c.id, cur);
    }
  }
  return Array.from(score.values()).sort((a, b) => b.score - a.score).slice(0, 60);
}

// ---------------------------------------------------------
// 3) Yapay zekâ en uygun kategoriyi seçer
// ---------------------------------------------------------
async function pickCategory(productText, candidates) {
  const list = candidates.map((c) => c.id + " | " + c.path).join("\n");
  const system =
    "Sen Trendyol kategori uzmanısın. Ürün için aşağıdaki aday listeden EN UYGUN kategoriyi seç. " +
    "Sadece listedeki numaralardan birini kullan. Ayrıca en fazla 2 alternatif ver. " +
    "confidence 0 ile 1 arasında olsun. " +
    'SADECE tek satır JSON döndür: {"category_id":123,"alternatives":[456,789],"confidence":0.8}';
  const out = await askJson(system, "ÜRÜN:\n" + productText + "\n\nADAY KATEGORİLER:\n" + list, 200);
  const ids = new Set(candidates.map((c) => c.id));
  const chosen = ids.has(Number(out.category_id)) ? Number(out.category_id) : candidates[0].id;
  const alternatives = (out.alternatives || []).map(Number).filter((id) => ids.has(id) && id !== chosen).slice(0, 2);
  const confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
  return { chosen, alternatives, confidence };
}

// ---------------------------------------------------------
// 4) Zorunlu özellikleri doldur
// ---------------------------------------------------------
async function fillAttributes(productText, attributes) {
  const required = attributes.filter((a) => a.required);
  if (!required.length) return [];

  const textLower = productText.toLocaleLowerCase("tr-TR");
  const blocks = required.map((a) => {
    let values = a.attribute_values || [];
    if (values.length > 150) {
      const hits = values.filter((v) => textLower.includes(String(v.name).toLocaleLowerCase("tr-TR")));
      values = hits.concat(values.slice(0, 60)).slice(0, 150);
    }
    const valueText = values.length ? values.map((v) => v.id + "=" + v.name).join("; ") : "(liste yok)";
    return "ÖZELLİK " + a.attribute_id + " | " + a.name +
      " | serbest metin: " + (a.allow_custom ? "evet" : "hayır") +
      "\nDEĞERLER: " + valueText;
  }).join("\n\n");

  const system =
    "Sen Trendyol ürün uzmanısın. Ürün için her ZORUNLU özelliğe değer seç. " +
    "Listede uygun değer varsa value_id olarak onun numarasını yaz. Listede yoksa ve serbest metin 'evet' ise " +
    "custom_value yaz. Ürün metninden anlaşılmıyorsa ürün için en makul değeri seç ve guessed=true yaz. " +
    "Hiç uygun değer yoksa value_id ve custom_value null olsun. " +
    'SADECE tek satır JSON döndür: {"attributes":[{"attribute_id":1,"value_id":2,"custom_value":null,"guessed":false}]}';
  const out = await askJson(system, "ÜRÜN:\n" + productText + "\n\n" + blocks, 1500);

  const answers = new Map((out.attributes || []).map((x) => [Number(x.attribute_id), x]));
  return required.map((a) => {
    const ans = answers.get(Number(a.attribute_id)) || {};
    const val = (a.attribute_values || []).find((v) => Number(v.id) === Number(ans.value_id));
    const custom = !val && a.allow_custom && ans.custom_value ? String(ans.custom_value).slice(0, 100) : null;
    return {
      attribute_id: a.attribute_id,
      name: a.name,
      required: true,
      varianter: !!a.varianter,
      value_id: val ? val.id : null,
      value_name: val ? val.name : null,
      custom_value: custom,
      guessed: !!ans.guessed,
      missing: !val && !custom,
    };
  });
}

// ---------------------------------------------------------
// Giriş noktası
// ---------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const started = Date.now();
  const url = new URL(req.url);
  let body = {};
  try { body = (await req.clone().json()) || {}; } catch (_) { body = {}; }

  // Yetki: sunucu ya da giriş yapmış kullanıcı
  const candidatesAuth = [];
  req.headers.forEach((value) => {
    if (!value) return;
    candidatesAuth.push(value.trim());
    if (value.startsWith("Bearer ")) candidatesAuth.push(value.slice(7).trim());
  });
  const isServer =
    (!!CRON_SECRET && candidatesAuth.includes(CRON_SECRET.trim())) ||
    (!!SERVICE_KEY && candidatesAuth.includes(SERVICE_KEY.trim()));

  let userId = null;
  if (!isServer) {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (token) {
      const { data } = await db.auth.getUser(token);
      if (data && data.user) userId = data.user.id;
    }
    if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  }

  try {
    if (!ANTHROPIC_API_KEY) return json({ ok: false, error: "ai_key_missing" }, 500);

    // Ürün bilgisi: ilandan ya da doğrudan gönderilen metinden
    let title = body.title || url.searchParams.get("title") || "";
    let description = body.description || "";
    let categoryKey = body.category_key || "";
    let extra = "";

    const listingId = body.listing_id || url.searchParams.get("listing_id");
    if (listingId) {
      let q = db.from("listings")
        .select("id, user_id, title, description, bullet_points, attributes, category_key")
        .eq("id", listingId);
      if (!isServer) q = q.eq("user_id", userId);
      const { data: l, error } = await q.maybeSingle();
      if (error) throw error;
      if (!l) return json({ ok: false, error: "listing_not_found" }, 404);
      title = l.title || title;
      description = l.description || description;
      categoryKey = l.category_key || categoryKey;
      if (Array.isArray(l.bullet_points)) extra += "\nÖne çıkanlar: " + l.bullet_points.join(" | ");
      if (l.attributes && typeof l.attributes === "object") extra += "\nÖzellikler: " + JSON.stringify(l.attributes).slice(0, 800);
    }

    title = String(title).trim();
    if (!title) return json({ ok: false, error: "title_required" }, 400);

    const productText =
      "Başlık: " + title +
      (categoryKey ? "\nBizdeki kategori: " + categoryKey : "") +
      (description ? "\nAçıklama: " + stripHtml(description).slice(0, 1500) : "") +
      extra;

    // 1) Anahtar kelimeler
    const { keywords, brand: brandGuess } = await extractKeywords(productText);

    // 2) Aday kategoriler
    const cands = await findCandidates(keywords);
    if (!cands.length) {
      return json({ ok: false, error: "no_category_candidates", keywords, ms: Date.now() - started }, 200);
    }

    // 3) Kategori seçimi
    const pick = await pickCategory(productText, cands);
    const byId = new Map(cands.map((c) => [c.id, c]));

    // 4) Özellikler + marka (aynı anda)
    const [attrRes, brandRes] = await Promise.all([
      catalog({ action: "attributes", category_id: pick.chosen }),
      brandGuess ? catalog({ action: "brands", q: brandGuess }).catch(() => ({ brands: [] })) : Promise.resolve({ brands: [] }),
    ]);

    const attributes = await fillAttributes(productText, attrRes.attributes || []);

    const brands = brandRes.brands || [];
    const exactBrand = brands.find((b) => String(b.name).toLocaleLowerCase("tr-TR") === String(brandGuess || "").toLocaleLowerCase("tr-TR"));

    return json({
      ok: true,
      category: { id: pick.chosen, path: byId.get(pick.chosen).path, confidence: pick.confidence },
      alternatives: pick.alternatives.map((id) => ({ id, path: byId.get(id).path })),
      brand: {
        guess: brandGuess,
        match: exactBrand || null,
        options: brands.slice(0, 5),
      },
      attributes,
      missing_required: attributes.filter((a) => a.missing).map((a) => a.name),
      keywords,
      ms: Date.now() - started,
    });
  } catch (e) {
    const msg = errMsg(e).slice(0, 500);
    console.error("trendyol-match", msg);
    return json({ ok: false, error: msg }, 502);
  }
});