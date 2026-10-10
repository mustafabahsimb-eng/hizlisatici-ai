// =========================================================
// HızlıSatıcı AI - price-list-parse (Toplu Ürün Yükleme: PDF fiyat listesi)
// PDF fiyat listesindeki satırları okur: model kodu, ürün adı, fiyat, tavsiye fiyat, para birimi.
// Büyük PDF'ler tarayıcıda parçalara bölünüp (birkaç sayfa) ayrı ayrı gönderilir.
// Sadece giriş yapmış kullanıcılar kullanabilir.
// POST { pdfBase64: "data:application/pdf;base64,...", language }
// Cevap: { rows: [{ code, name, price, list_price, currency }] }
// =========================================================
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MAX_BASE64_LEN = 12_000_000; // ~9 MB

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

const SYSTEM = `You read supplier / dealer PRICE LIST documents (often Turkish) and extract every product row.
Output ONE LINE PER PRODUCT, tab-separated, with exactly these 5 columns and NOTHING else (no header, no markdown, no explanations):
CODE<TAB>NAME<TAB>PRICE<TAB>LIST_PRICE<TAB>CURRENCY
- CODE: the model / product / stock code exactly as written (e.g. DZ-2628-DP). Empty if there is none.
- NAME: short product name/description as written (max 120 chars, no tabs).
- PRICE: the dealer / net / purchase price (bayi fiyatı, net fiyat, alış). If only one price column exists, put it here. Number only, keep the document's decimal format.
- LIST_PRICE: the recommended retail price (PSF, tavsiye satış, liste fiyatı, perakende) if a separate column exists, else empty.
- CURRENCY: TRY, USD, EUR or GBP (from the column header, symbols or a note like "Fiyatlar USD'dir"). Empty if unknown.
Skip headers, category titles, totals, notes and rows without any price. Never invent rows or prices.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await hsIsLoggedIn(req))) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);

  const body = await req.json().catch(() => ({}));
  const en = String(body?.language || "").toLowerCase().startsWith("en");
  const E = (tr: string, eng: string) => (en ? eng : tr);

  try {
    const m = String(body?.pdfBase64 || "").match(/^data:application\/pdf;base64,(.+)$/);
    if (!m) return json({ error: E("PDF dosyası gerekli.", "A PDF file is required.") }, 400);
    if (m[1].length > MAX_BASE64_LEN) return json({ error: E("PDF parçası çok büyük.", "The PDF part is too large.") }, 413);

    let text = "";
    let lastErr = "";
    for (const model of ["claude-sonnet-5", "claude-haiku-4-5"]) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: 16000,
          system: SYSTEM,
          messages: [{
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: m[1] } },
              { type: "text", text: "Extract every product row from this price list as tab-separated lines." },
            ],
          }],
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { lastErr = String(d?.error?.message || r.status); console.error(model, lastErr); continue; }
      text = (d?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      if (text.trim()) break;
    }
    if (!text.trim()) return json({ error: E("PDF okunamadı: ", "Could not read the PDF: ") + lastErr.slice(0, 200) }, 502);

    const rows: any[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("\t")) continue;
      const c = line.split("\t").map((x) => x.trim());
      const price = parsePrice(c[2]);
      const list = parsePrice(c[3]);
      if (!price && !list) continue;
      const code = (c[0] || "").replace(/^[`*"]+|[`*"]+$/g, "").slice(0, 80);
      const name = (c[1] || "").slice(0, 200);
      if (!code && !name) continue;
      rows.push({ code, name, price: price || list, list_price: price ? list : null, currency: cur(c[4]) });
      if (rows.length >= 3000) break;
    }
    return json({ rows });
  } catch (err) {
    console.error(err);
    return json({ error: E("Sunucu hatası", "Server error") }, 500);
  }
});