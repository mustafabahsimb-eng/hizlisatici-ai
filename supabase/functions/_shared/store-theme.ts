// =========================================================
// Seltigo mağaza teması: hazır temalar, yapay zekâ tasarımı (Claude; yoksa kurallı tasarımcı), doğrulama
// (renkler #rrggbb, metin / zemin karşıtlığı en az 4.5:1 — WCAG AA; düğme yazısı otomatik siyah / beyaz).
// Tema store_settings.theme'de durur; vitrin (magaza.html + magaza-pro.js) CSS değişkenleriyle uygular.
// =========================================================
export type Theme = {
  preset: string; font: "system" | "serif" | "rounded" | "mono"; radius: number; layout: "grid" | "large" | "list";
  colors: { bg: string; panel: string; panel2: string; border: string; text: string; dim: string; accent: string; accentText: string };
  hero: { title: string; subtitle: string }; announcement: string; ai?: { prompt: string; model: string } | null;
};

export const PRESETS: Record<string, Omit<Theme, "hero" | "announcement" | "preset">> = {
  gece: { font: "system", radius: 12, layout: "grid", colors: { bg: "#0b1220", panel: "#111a2e", panel2: "#16213a", border: "#233150", text: "#e7ecf5", dim: "#9aa7c2", accent: "#1D9E75", accentText: "#04150f" } },
  beyaz: { font: "system", radius: 8, layout: "grid", colors: { bg: "#ffffff", panel: "#f6f7f9", panel2: "#eef0f3", border: "#dfe3e8", text: "#14171c", dim: "#5b6470", accent: "#111827", accentText: "#ffffff" } },
  butik: { font: "serif", radius: 2, layout: "large", colors: { bg: "#faf7f2", panel: "#ffffff", panel2: "#f3ede4", border: "#e6dccd", text: "#2b2118", dim: "#7a6a58", accent: "#8a5a3b", accentText: "#ffffff" } },
  pastel: { font: "rounded", radius: 18, layout: "grid", colors: { bg: "#fdf6f9", panel: "#ffffff", panel2: "#f8ecf2", border: "#efd9e4", text: "#3a2a33", dim: "#86707c", accent: "#c2477d", accentText: "#ffffff" } },
  canli: { font: "rounded", radius: 14, layout: "grid", colors: { bg: "#0f0f1a", panel: "#181830", panel2: "#20203d", border: "#2e2e55", text: "#f3f3ff", dim: "#a9a9cf", accent: "#ffcc00", accentText: "#1a1400" } },
  dogal: { font: "serif", radius: 10, layout: "list", colors: { bg: "#f4f6ef", panel: "#ffffff", panel2: "#e9eee0", border: "#d6dfc8", text: "#1f2a17", dim: "#5d6b4f", accent: "#3f6b2a", accentText: "#ffffff" } },
};

const HEX = /^#[0-9a-f]{6}$/i;
function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const clean = (v: unknown, n: number) => String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

export function sanitizeTheme(t: any, storeName = ""): Theme {
  const preset = PRESETS[t?.preset] ? t.preset : "gece";
  const base = PRESETS[preset];
  const col: any = { ...base.colors };
  for (const k of Object.keys(col)) if (HEX.test(String(t?.colors?.[k] || ""))) col[k] = String(t.colors[k]).toLowerCase();
  // Okunabilirlik: metin zemine en az 4.5:1; değilse temanın kendi metin rengi
  if (contrast(col.text, col.bg) < 4.5) col.text = lum(col.bg) > 0.4 ? "#14171c" : "#f2f4f8";
  if (contrast(col.dim, col.bg) < 3) col.dim = lum(col.bg) > 0.4 ? "#5b6470" : "#a3adc2";
  if (contrast(col.text, col.panel) < 4.5) col.panel = col.bg;
  col.accentText = contrast("#ffffff", col.accent) >= contrast("#111111", col.accent) ? "#ffffff" : "#111111";
  return {
    preset, font: ["system", "serif", "rounded", "mono"].includes(t?.font) ? t.font : base.font,
    radius: Math.min(24, Math.max(0, Number.isFinite(Number(t?.radius)) ? Number(t.radius) : base.radius)),
    layout: ["grid", "large", "list"].includes(t?.layout) ? t.layout : base.layout, colors: col,
    hero: { title: clean(t?.hero?.title, 80) || storeName, subtitle: clean(t?.hero?.subtitle, 160) },
    announcement: clean(t?.announcement, 120), ai: t?.ai ? { prompt: clean(t.ai.prompt, 300), model: clean(t.ai.model, 40) } : null,
  };
}

// Kurallı tasarımcı (yapay zekâ yoksa): istekteki / ürünlerdeki anahtar kelimelerden tema
const RULES: [RegExp, string, string][] = [
  [/bebek|çocuk|oyuncak|pastel|kids|baby/i, "pastel", "Minik mutluluklar"],
  [/organik|doğal|bitki|kahve|çay|zeytin|bal|natural|eco/i, "dogal", "Doğadan gelen"],
  [/lüks|butik|takı|mücevher|deri|el yapımı|tasarım|vintage|boutique|jewel/i, "butik", "Özenle seçilmiş parçalar"],
  [/spor|oyun|elektronik|gaming|teknoloji|neon|tech/i, "canli", "Enerjini yükselt"],
  [/minimal|sade|beyaz|modern|clean/i, "beyaz", "Sade ve şık"],
];
export function ruleDesign(prompt: string, storeName: string, sample: string[]): Theme {
  const text = `${prompt} ${storeName} ${sample.join(" ")}`;
  const hit = RULES.find(([re]) => re.test(text));
  const preset = hit?.[1] || "gece";
  return sanitizeTheme({ preset, hero: { title: storeName, subtitle: hit?.[2] || "Yeni sezon ürünleri" }, ai: { prompt, model: "kurallı" } }, storeName);
}

export async function aiDesign(prompt: string, storeName: string, sample: string[]): Promise<Theme> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!key) return ruleDesign(prompt, storeName, sample);
  const system = "Sen bir e-ticaret mağaza tasarımcısısın. Yalnız JSON döndür. Şema: {\"preset\":\"gece|beyaz|butik|pastel|canli|dogal\",\"font\":\"system|serif|rounded|mono\",\"radius\":0-24,\"layout\":\"grid|large|list\",\"colors\":{\"bg\":\"#rrggbb\",\"panel\":\"#rrggbb\",\"panel2\":\"#rrggbb\",\"border\":\"#rrggbb\",\"text\":\"#rrggbb\",\"dim\":\"#rrggbb\",\"accent\":\"#rrggbb\"},\"hero\":{\"title\":\"en fazla 60 karakter\",\"subtitle\":\"en fazla 120 karakter\"},\"announcement\":\"kısa duyuru ya da boş\"}. Metin ile zemin arasında yüksek karşıtlık olsun. Türkçe yaz.";
  const user = `Mağaza adı: ${storeName}\nSatıcının isteği: ${prompt || "(yok)"}\nÖrnek ürünler: ${sample.slice(0, 12).join(", ")}`;
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-6"]) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: AbortSignal.timeout(30000),
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 700, system, messages: [{ role: "user", content: user }] }),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const txt = (d.content || []).map((c: any) => c.text || "").join("");
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) continue;
      return sanitizeTheme({ ...JSON.parse(m[0]), ai: { prompt, model } }, storeName);
    } catch { /* sonraki model */ }
  }
  return ruleDesign(prompt, storeName, sample);
}
