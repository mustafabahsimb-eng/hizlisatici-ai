// =========================================================
// İçerik görselleri (şablonlar): photo, price, collage, season (gönderi 1080x1350), story (1080x1920)
// imagescript (saf TS + wasm; Edge Function'da çalışır). Yazı tipi Poppins (OFL), Türkçe karakter + ₺ destekli.
// =========================================================
import { Image, TextLayout } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const BG = 0x0d0f16ff, PANEL = 0x141821ff, GREEN = 0x1d9e75ff, WHITE = 0xffffffff, DIM = 0xaab2c0ff;
const FONT_URLS = {
  bold: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-SemiBold.ttf",
  reg: "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-Regular.ttf",
};
const fontCache = new Map<string, Uint8Array>();
async function font(k: keyof typeof FONT_URLS) {
  if (!fontCache.has(k)) fontCache.set(k, new Uint8Array(await (await fetch(FONT_URLS[k], { signal: AbortSignal.timeout(20000) })).arrayBuffer()));
  return fontCache.get(k)!;
}
async function photo(url: string): Promise<Image> {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Seltigo/1.0)" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Görsel indirilemedi (${r.status})`);
  return await Image.decode(new Uint8Array(await r.arrayBuffer())) as Image;
}
async function text(s: string, size: number, color: number, maxWidth: number, bold = true) {
  return await Image.renderText(await font(bold ? "bold" : "reg"), size, s, color, new TextLayout({ maxWidth, wrapStyle: "word", verticalAlign: "left", horizontalAlign: "top" }));
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
function roundedRect(w: number, h: number, color: number, r = 28) { const i = new Image(w, h); i.fill(color); i.roundCorners(r); return i; }

export type RenderIn = { template: "photo" | "price" | "collage" | "season" | "story"; store: string; products: { name: string; price: string | null; image: string }[]; season?: string };

export async function render(x: RenderIn): Promise<Uint8Array> {
  const p0 = x.products[0];
  if (x.template === "story") {
    const img = new Image(1080, 1920); img.fill(BG);
    const ph = await photo(p0.image); ph.cover(1080, 1350); img.composite(ph, 0, 230);
    img.composite(await text(clip(x.store, 30), 46, DIM, 1000, false), 40, 120);
    img.composite(await text(clip(p0.name, 70), 64, WHITE, 1000), 40, 1610);
    if (p0.price) { const b = roundedRect(380, 110, GREEN, 55); b.composite(await text(p0.price, 54, WHITE, 360), 34, 18); img.composite(b, 40, 1440); }
    img.composite(await text("Mağazada incele", 44, GREEN, 600), 40, 1800);
    return await img.encodeJPEG(88);
  }
  if (x.template === "collage") {
    const img = new Image(1080, 1350); img.fill(BG);
    img.composite(await text("Haftanın seçkisi", 64, WHITE, 1000), 40, 40);
    img.composite(await text(clip(x.store, 40), 36, DIM, 1000, false), 40, 140);
    const cells = x.products.slice(0, 4);
    for (let i = 0; i < cells.length; i++) {
      const ph = await photo(cells[i].image); ph.cover(510, 510); ph.roundCorners(24);
      const cx = 20 + (i % 2) * 530, cy = 220 + Math.floor(i / 2) * 560;
      img.composite(ph, cx, cy);
      if (cells[i].price) { const b = roundedRect(250, 70, GREEN, 35); b.composite(await text(cells[i].price!, 36, WHITE, 230), 22, 10); img.composite(b, cx + 16, cy + 424); }
    }
    return await img.encodeJPEG(88);
  }
  // photo / price / season: 1080x1350
  const img = new Image(1080, 1350); img.fill(BG);
  if (x.template === "price") {
    const ph = await photo(p0.image); ph.cover(1080, 1350); img.composite(ph, 0, 0);
    const band = new Image(1080, 300); band.fill(0x0d0f16e6); img.composite(band, 0, 1050);
    img.composite(await text(clip(p0.name, 80), 54, WHITE, 1000), 40, 1090);
    if (p0.price) { const b = roundedRect(440, 150, GREEN, 75); b.composite(await text(p0.price, 72, WHITE, 420), 40, 24); img.composite(b, 600, 40); }
    return await img.encodeJPEG(88);
  }
  const ph = await photo(p0.image); ph.cover(1080, 1080); img.composite(ph, 0, 0);
  if (x.template === "season" && x.season) {
    const banner = new Image(1080, 120); banner.fill(GREEN);
    banner.composite(await text(clip(`${x.season} için`, 40), 58, WHITE, 1040), 40, 22); img.composite(banner, 0, 0);
  }
  const panel = new Image(1080, 270); panel.fill(PANEL); img.composite(panel, 0, 1080);
  img.composite(await text(clip(p0.name, 80), 50, WHITE, 760), 40, 1110);
  if (p0.price) img.composite(await text(p0.price, 62, GREEN, 320), 780, 1120);
  img.composite(await text(clip(x.store, 40), 34, DIM, 1000, false), 40, 1280);
  return await img.encodeJPEG(88);
}
