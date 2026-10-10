// =========================================================
// HızlıSatıcı AI - catalog-feed (WhatsApp / Facebook / Instagram katalog beslemesi)
// Mağazadaki yayında olan ürünleri Meta'nın (ve Google Merchant'ın) okuduğu
// RSS / XML biçiminde verir. Meta bu adresi her gün kendisi okur, katalog kendiliğinden güncellenir.
// Herkese açıktır (mağaza sayfası da herkese açık): sadece yayındaki ürünler çıkar.
// GET ?slug=<mağaza adresi>
// =========================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://mustafabahsimb-eng.github.io/hizlisatici-ai/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function xml(s: unknown): string {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // Türkçe karakterler her ortamda doğru görünsün: ü -> &#252; gibi yaz
    .replace(/[^\x00-\x7F]/gu, (c) => "&#" + (c.codePointAt(0) ?? 63) + ";");
}
function plain(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}
function errorXml(msg: string, status: number) {
  return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<error>' + xml(msg) + "</error>\n", {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/xml; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const slug = (url.searchParams.get("slug") || "").trim();
  if (!slug || slug.length > 100 || !/^[a-z0-9-]+$/i.test(slug)) return errorXml("slug gerekli / slug required", 400);

  // Mağaza sayfasının kullandığı aynı kaynaktan oku (sadece yayındaki ürünler)
  let data: any;
  try {
    const r = await fetch(SUPABASE_URL + "/functions/v1/get-store?slug=" + encodeURIComponent(slug), {
      headers: { Authorization: "Bearer " + SUPABASE_ANON_KEY, apikey: SUPABASE_ANON_KEY },
    });
    data = await r.json().catch(() => ({}));
    if (!r.ok) return errorXml(String(data?.error || "Mağaza bulunamadı / Store not found"), 404);
  } catch (_e) {
    return errorXml("Sunucu hatası / Server error", 500);
  }

  const store = data?.store || {};
  const storeName = plain(store.store_name || store.name || store.magaza_adi || store.title || slug, 100);
  const storeUrl = SITE_URL + "magaza.html?slug=" + encodeURIComponent(slug);
  const products: any[] = Array.isArray(data?.products) ? data.products : [];

  const items: string[] = [];
  for (const p of products) {
    const price = Number(p.sale_price);
    const img = String(p.image_url || "");
    if (!(price > 0) || !/^https?:\/\//i.test(img)) continue; // Meta fiyatsız / resimsiz ürünü kabul etmez
    const title = plain(p.generated_title || p.name, 150);
    if (!title) continue;
    const desc = plain(p.generated_description, 5000) || title;
    const cur = String(p.currency || "TRY").toUpperCase();
    const id = String(p.listing_id || p.id);
    const out = String(p.stock_status || "") === "tukendi";
    items.push(
      "    <item>\n" +
      "      <g:id>" + xml(id) + "</g:id>\n" +
      "      <g:title>" + xml(title) + "</g:title>\n" +
      "      <g:description>" + xml(desc) + "</g:description>\n" +
      "      <g:link>" + xml(storeUrl + "&p=" + encodeURIComponent(String(p.id))) + "</g:link>\n" +
      "      <g:image_link>" + xml(img) + "</g:image_link>\n" +
      "      <g:brand>" + xml(plain(p.brand, 100) || storeName) + "</g:brand>\n" +
      "      <g:condition>new</g:condition>\n" +
      "      <g:availability>" + (out ? "out of stock" : "in stock") + "</g:availability>\n" +
      "      <g:price>" + price.toFixed(2) + " " + xml(cur) + "</g:price>\n" +
      (p.model_code ? "      <g:mpn>" + xml(plain(p.model_code, 70)) + "</g:mpn>\n" : "") +
      "    </item>"
    );
  }

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">\n' +
    "  <channel>\n" +
    "    <title>" + xml(storeName) + "</title>\n" +
    "    <link>" + xml(storeUrl) + "</link>\n" +
    "    <description>" + xml(storeName) + "</description>\n" +
    items.join("\n") + (items.length ? "\n" : "") +
    "  </channel>\n" +
    "</rss>\n";

  return new Response(body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=1800" },
  });
});