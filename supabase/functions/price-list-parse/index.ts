// =========================================================
// Seltigo - price-list-parse (Toplu Ürün Yükleme: "📄 Katalog / fiyat listesi yükle")
// Her türlü dosyadaki ürünleri okur: fiyat listesi, resimli katalog, tablo, taranmış sayfa,
// fotoğraf / ekran görüntüsü, düzeni ne olursa olsun Excel/CSV (tarayıcı metne çevirip gönderir).
// Satıcı hiçbir şablon doldurmaz; içerik yapay zekâyla anlaşılır.
// Büyük PDF'ler tarayıcıda parçalara bölünüp (birkaç sayfa) ayrı ayrı gönderilir.
// Sadece giriş yapmış kullanıcılar kullanabilir.
// POST { pdfBase64 | imageBase64 | text, language }
//   -> { rows: [{ code, name, price, list_price, currency, brand, page, box }], site }
//      site: belgede yazan tedarikçi / toptancı web adresi (görsel tamamlamada 2. kaynak)
//      page: parçadaki sayfa (1'den); box: görsel girişte ürün fotoğrafının yeri [x0,y0,x1,y1] (0-1000)
// POST { action: "page_photos", imageBase64, rows: [{ i, code, name }], boxes?: [{ n }] }
//   -> { matches: [{ i, n } | { i, box }] }  sayfa görüntüsünde her ürünün fotoğrafı
//      (boxes verilirse görüntüdeki kırmızı numaralı kutulardan biri seçilir, yoksa konum döner)
// =========================================================
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MAX_BASE64_LEN = 12_000_000; // ~9 MB
const MAX_TEXT_LEN = 120_000;
const MODELS = ["claude-sonnet-5-5", "claude-sonnet-4-6"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function hsIsLoggedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.split(".").length !== 3) return false;
  try {
    const r = await fetch((Deno.env.get("SUPABASE_URL") ?? "") + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch (_e) {
    return false;
  }
}

// "1.234,56" / "1,234.56" / "$19.99" -> sayı
function parsePrice(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  let s = String(v).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc > -1 && ld > -1) {
    s = lc > ld ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lc > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (ld > -1) {
    const parts = s.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
function cur(v: unknown): string | null {
  const s = String(v || "").toUpperCase();
  if (/TRY|TL|₺/.test(s)) return "TRY";
  if (/USD|\$/.test(s)) return "USD";
  if (/EUR|€/.test(s)) return "EUR";
  if (/GBP|£/.test(s)) return "GBP";
  return null;
}

const SYSTEM = `You read supplier / dealer PRICE LISTS and PRODUCT CATALOGUES (often Turkish) and extract every product.
The input can be a PDF, a scanned page, a photo or screenshot of a page, or a spreadsheet converted to tab-separated text with arbitrary columns.
Output ONE LINE PER PRODUCT, tab-separated, with exactly these 8 columns and NOTHING else (no header, no markdown, no explanations):
CODE<TAB>NAME<TAB>PRICE<TAB>LIST_PRICE<TAB>CURRENCY<TAB>BRAND<TAB>PAGE<TAB>BOX
- CODE: the model / product / stock code exactly as written (e.g. DZ-2628-DP). Empty if there is none.
- NAME: product name/description as written (max 160 chars, no tabs). Required.
- PRICE: the dealer / net / purchase price (bayi fiyatı, net fiyat, alış). If only one price exists, put it here. Number only, keep the document's decimal format. Empty if the product has no price.
- LIST_PRICE: the recommended retail price (PSF, tavsiye satış, liste fiyatı, perakende) if separately given, else empty.
- CURRENCY: TRY, USD, EUR or GBP (from headers, symbols or notes like "Fiyatlar USD'dir"). Empty if unknown.
- BRAND: the brand if written on the row, the section or the page header; else empty.
- PAGE: page number within this input (1 for a single image or spreadsheet).
- BOX: ONLY for image inputs: the product's PHOTO position on the image as x0,y0,x1,y1 in a 0-1000 scale (left,top,right,bottom). Empty if the product has no photo or the input is not an image.
Skip headers, category titles, totals, notes, contact info. Never invent products, codes or prices. Read small text carefully.
If the document shows the supplier's / company's own website (header, footer, contact block), output ONE extra first line: #SITE<TAB>domain (e.g. #SITE<TAB>ornektoptan.com). Never output a marketplace or social media domain there.`;

const MATCH_SYSTEM = `You match product rows to their PHOTOS on a catalogue page image.
You get the page image and a list of products (index, code, name) that appear on this page.
If the image has red numbered boxes, those are the photo regions: assign each product the number of ITS photo.
If there are no numbered boxes, give the product photo's position as x0,y0,x1,y1 in a 0-1000 scale (left,top,right,bottom), tightly around the product photo only (no text).
Output one line per product that has a photo: INDEX<TAB>NUMBER_OR_BOX. Nothing else. Skip products without a clearly identifiable photo. Never guess between similar photos; skip instead.`;

async function ask(system: string, content: unknown[], maxTokens = 16000): Promise<{ text: string; err: string }> {
  let lastErr = "";
  for (const model of MODELS) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { lastErr = String(d?.error?.message || r.status); console.error(model, lastErr); continue; }
    const text = (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    if (text.trim()) return { text, err: "" };
  }
  return { text: "", err: lastErr };
}

function imagePart(dataUrl: unknown): { part: unknown; len: number } | null {
  const m = String(dataUrl || "").match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (!m) return null;
  return { part: { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }, len: m[2].length };
}
function parseBox(v: unknown): number[] | null {
  const n = String(v || "").split(/[ ,;]+/).filter(Boolean).map(Number).filter((x) => Number.isFinite(x));
  if (n.length !== 4) return null;
  const [x0, y0, x1, y1] = n.map((x) => Math.max(0, Math.min(1000, Math.round(x))));
  return x1 - x0 >= 20 && y1 - y0 >= 20 ? [x0, y0, x1, y1] : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await hsIsLoggedIn(req))) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);

  const body = await req.json().catch(() => ({}));
  const en = String(body?.language || "").toLowerCase().startsWith("en");
  const E = (tr: string, eng: string) => (en ? eng : tr);

  try {
    // ---- Sayfadaki ürün fotoğraflarını eşleştir ----
    if (body?.action === "page_photos") {
      const img = imagePart(body.imageBase64);
      if (!img) return json({ error: E("Sayfa görüntüsü gerekli.", "A page image is required.") }, 400);
      if (img.len > MAX_BASE64_LEN) return json({ error: E("Görüntü çok büyük.", "The image is too large.") }, 413);
      const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 200)
        .map((r: any) => `${Number(r.i)}\t${String(r.code || "").slice(0, 60)}\t${String(r.name || "").slice(0, 120)}`);
      if (!rows.length) return json({ matches: [] });
      const boxes = Array.isArray(body.boxes) ? body.boxes : [];
      const hasBoxes = boxes.length > 0;
      const { text, err } = await ask(MATCH_SYSTEM, [
        img.part,
        { type: "text", text: (hasBoxes ? "The red numbered boxes are photo regions.\n" : "There are no numbered boxes.\n") +
          "Products (INDEX<TAB>CODE<TAB>NAME):\n" + rows.join("\n") },
      ], 4000);
      if (!text) return json({ error: E("Sayfa okunamadı: ", "Could not read the page: ") + err.slice(0, 200) }, 502);
      const valid = new Set(boxes.map((b: any) => Number(b.n)));
      const matches: unknown[] = [];
      for (const line of text.split(/\r?\n/)) {
        const c = line.split("\t").map((x) => x.trim());
        if (c.length < 2 || !/^\d+$/.test(c[0])) continue;
        const i = Number(c[0]);
        if (hasBoxes) {
          const n = Number(c[1].replace("#", ""));
          if (/^#?\d+$/.test(c[1]) && valid.has(n)) matches.push({ i, n });
        } else {
          const box = parseBox(c[1]);
          if (box) matches.push({ i, box });
        }
      }
      return json({ matches });
    }

    // ---- Ürün satırlarını oku ----
    let content: unknown[] | null = null;
    let isImage = false;
    const pdf = String(body?.pdfBase64 || "").match(/^data:application\/pdf;base64,(.+)$/);
    if (pdf) {
      if (pdf[1].length > MAX_BASE64_LEN) return json({ error: E("PDF parçası çok büyük.", "The PDF part is too large.") }, 413);
      content = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf[1] } },
        { type: "text", text: "Extract every product as tab-separated lines." },
      ];
    } else if (body?.imageBase64) {
      const img = imagePart(body.imageBase64);
      if (!img) return json({ error: E("Görüntü biçimi desteklenmiyor.", "Unsupported image format.") }, 400);
      if (img.len > MAX_BASE64_LEN) return json({ error: E("Görüntü çok büyük.", "The image is too large.") }, 413);
      isImage = true;
      content = [img.part, { type: "text", text: "Extract every product as tab-separated lines, including the BOX of each product photo." }];
    } else if (typeof body?.text === "string" && body.text.trim()) {
      content = [{
        type: "text",
        text: "Spreadsheet content (tab-separated, columns may be in any order or language):\n\n" +
          body.text.slice(0, MAX_TEXT_LEN) + "\n\nExtract every product as tab-separated lines.",
      }];
    }
    if (!content) return json({ error: E("Dosya içeriği gerekli.", "File content is required.") }, 400);

    const { text, err } = await ask(SYSTEM, content);
    if (!text.trim()) return json({ error: E("Dosya okunamadı: ", "Could not read the file: ") + err.slice(0, 200) }, 502);

    const rows: unknown[] = [];
    let site = "";
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("\t")) continue;
      if (line.startsWith("#SITE")) {
        const d = String(line.split("\t")[1] || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[\/?#\s]/)[0];
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && !/(trendyol|hepsiburada|n11|amazon|instagram|facebook|whatsapp|aliexpress|youtube|google)\./.test(d)) site = d;
        continue;
      }
      const c = line.split("\t").map((x) => x.trim());
      const code = (c[0] || "").replace(/^[`*"]+|[`*"]+$/g, "").slice(0, 80);
      const name = (c[1] || "").replace(/^[`*"]+|[`*"]+$/g, "").slice(0, 200);
      if (!name && !code) continue;
      if (/^code$/i.test(code) && /^name$/i.test(name)) continue; // başlık satırı
      const price = parsePrice(c[2]);
      const list = parsePrice(c[3]);
      rows.push({
        code, name, price: price || list || null, list_price: price ? list : null, currency: cur(c[4]),
        brand: (c[5] || "").slice(0, 80), page: Number(c[6]) || 1, box: isImage ? parseBox(c[7]) : null,
      });
      if (rows.length >= 3000) break;
    }
    return json({ rows, site });
  } catch (err) {
    console.error(err);
    return json({ error: E("Sunucu hatası", "Server error") }, 500);
  }
});
