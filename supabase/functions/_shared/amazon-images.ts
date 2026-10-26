// =========================================================
// Amazon görsel kuralları + otomatik düzeltme (ana görsel)
// Amazon ana görsel kuralları: saf beyaz zemin (RGB 255,255,255), ürün karenin en az %85'ini doldurur, uzun kenar en az 500 px
// (yakınlaştırma için 1000 px+), JPEG / PNG / GIF / TIFF, yazı / logo / filigran yok.
// Düzeltme (yalnız ana görsel; diğer görseller olduğu gibi gider, hız için):
//   1) Zemin beyaza yakınsa (kenarlardan bağlı açık renkli pikseller) saf beyaza çekilir
//   2) Ürün kırpılır, karenin ~%90'ını dolduracak şekilde beyaz kare tuvale ortalanır (en az 1000 px, en fazla 2000 px)
//   3) Zemin beyaz değilse: diğer ürün görsellerinden kurala uyan ilk görsel ana görsel yapılır;
//      hiçbiri uymuyorsa ve zemin silme açıksa (AMAZON_AUTO_BG_REMOVE=true + REMOVEBG_API_KEY; ücretli kredi, varsayılan KAPALI) zemin silinir;
//      o da yoksa uyarı (Amazon ilanı aramada gizleyebilir).
// Sonuç Supabase deposuna (product-images/amazon/...) yazılır; aynı kaynak görsel bir daha işlenmez (önbellek: validation.amazon.imageFix).
// =========================================================
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

export type ImgIssue = { code: string; field: string; msg: string; fixed: boolean; severity?: "ERROR" | "WARNING" };
export type Analysis = { width: number; height: number; borderWhite: number; borderLight: number; fill: number; ok: boolean; fixable: boolean };

// remove.bg anahtarı panelin "Arka planı sil" özelliğiyle ortak; Amazon için otomatik kullanım ayrıca açılır (her görsel kredi harcar)
const REMOVE_BG_API_KEY = Deno.env.get("AMAZON_AUTO_BG_REMOVE") === "true" ? (Deno.env.get("REMOVEBG_API_KEY") ?? "") : "";
const MIN_SIDE = 500, ZOOM_SIDE = 1000, MAX_SIDE = 2000, TARGET_FILL = 0.9;

const isWhite = (r: number, g: number, b: number) => r >= 250 && g >= 250 && b >= 250;
const isLight = (r: number, g: number, b: number) => Math.min(r, g, b) >= 215 && Math.max(r, g, b) - Math.min(r, g, b) <= 30;
const isProduct = (r: number, g: number, b: number, a = 255) => a > 16 && !(Math.min(r, g, b) >= 245);

export async function decode(bytes: Uint8Array): Promise<Image> {
  const img = await Image.decode(bytes) as Image;
  // Çok büyük görseller bellek sınırı için küçültülür (uzun kenar en fazla 3000 px)
  const long = Math.max(img.width, img.height);
  if (long > 3000) img.resize(Math.round(img.width * 3000 / long), Math.round(img.height * 3000 / long));
  return img;
}

// Zemin ve doluluk ölçümü (küçük kopya üzerinde, hızlı)
export function analyze(src: Image): Analysis {
  const width = src.width, height = src.height;
  const s = src.clone();
  const long = Math.max(width, height);
  if (long > 400) s.resize(Math.max(1, Math.round(width * 400 / long)), Math.max(1, Math.round(height * 400 / long)));
  const w = s.width, h = s.height, px = s.bitmap;
  const band = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  let n = 0, white = 0, light = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
      const edge = x < band || y < band || x >= w - band || y >= h - band;
      if (edge) {
        n++;
        if (a < 16 || isWhite(r, g, b)) white++;
        if (a < 16 || isLight(r, g, b)) light++;
      }
      if (isProduct(r, g, b, a)) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  const borderWhite = white / Math.max(1, n), borderLight = light / Math.max(1, n);
  // Kenar bandı da ürünse doluluk ölçümü anlamsız (zemin beyaz değil)
  const fill = maxX < 0 ? 0 : Math.max((maxX - minX + 1) / w, (maxY - minY + 1) / h);
  const ok = borderWhite >= 0.98 && fill >= 0.85 && long >= ZOOM_SIDE;
  const fixable = borderLight >= 0.9 && maxX >= 0 && long >= 300;
  return { width, height, borderWhite, borderLight, fill, ok, fixable };
}

// Kenarlardan bağlı açık renkli pikselleri saf beyaz yap (ürünün içindeki beyazlara dokunmaz)
export function whitenBackground(img: Image): number {
  const w = img.width, h = img.height, px = img.bitmap;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const k = y * w + x;
    if (seen[k]) return;
    const i = k * 4;
    if (px[i + 3] < 16 || isLight(px[i], px[i + 1], px[i + 2])) { seen[k] = 1; stack.push(k); } else seen[k] = 2;
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  let changed = 0;
  while (stack.length) {
    const k = stack.pop()!;
    const i = k * 4;
    if (px[i] !== 255 || px[i + 1] !== 255 || px[i + 2] !== 255 || px[i + 3] !== 255) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 255; changed++; }
    const x = k % w, y = (k - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  // Saydam kalan pikseller (PNG) beyaz zemine
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] < 255) {
    const a = px[i + 3] / 255;
    px[i] = Math.round(px[i] * a + 255 * (1 - a)); px[i + 1] = Math.round(px[i + 1] * a + 255 * (1 - a)); px[i + 2] = Math.round(px[i + 2] * a + 255 * (1 - a)); px[i + 3] = 255;
  }
  return changed;
}

// Ürünü kırp, beyaz kare tuvale ortala (ürün kenarın ~%90'ı)
export function frameProduct(img: Image): Image {
  const w = img.width, h = img.height, px = img.bitmap;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (isProduct(px[i], px[i + 1], px[i + 2], px[i + 3])) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return img;
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const crop = img.clone().crop(minX, minY, cw, ch);
  const side = Math.min(MAX_SIDE, Math.max(ZOOM_SIDE, Math.round(Math.max(cw, ch) / TARGET_FILL)));
  const scale = (side * TARGET_FILL) / Math.max(cw, ch);
  crop.resize(Math.max(1, Math.round(cw * scale)), Math.max(1, Math.round(ch * scale)));
  const canvas = new Image(side, side).fill(0xffffffff);
  canvas.composite(crop, Math.round((side - crop.width) / 2), Math.round((side - crop.height) / 2));
  return canvas;
}

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const len = Number(r.headers.get("content-length") || 0);
    if (len > 15_000_000) { await r.body?.cancel(); return null; }
    return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type") || "" };
  } catch (_) { return null; }
}

// Ücretli zemin silme (remove.bg); anahtar yoksa çağrılmaz
async function removeBackground(url: string): Promise<Uint8Array | null> {
  if (!REMOVE_BG_API_KEY) return null;
  try {
    const fd = new FormData();
    fd.set("image_url", url); fd.set("size", "auto"); fd.set("format", "png");
    const r = await fetch("https://api.remove.bg/v1.0/removebg", { method: "POST", headers: { "X-Api-Key": REMOVE_BG_API_KEY }, body: fd, signal: AbortSignal.timeout(60000) });
    if (!r.ok) { await r.body?.cancel(); return null; }
    return new Uint8Array(await r.arrayBuffer());
  } catch (_) { return null; }
}

export type Uploader = (path: string, jpeg: Uint8Array) => Promise<string>;
export const storageUploader = (db: any): Uploader => async (path, jpeg) => {
  const { error } = await db.storage.from("product-images").upload(path, new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error("görsel depoya yazılamadı: " + error.message);
  return db.storage.from("product-images").getPublicUrl(path).data.publicUrl;
};

async function hash8(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).slice(0, 4).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Görsel listesini Amazon'a hazırla. cache: önceki çalışmanın { [kaynak]: düzeltilmiş } eşlemesi.
export async function prepareImages(urls: string[], opts: { upload: Uploader; pathPrefix: string; cache?: Record<string, string> }): Promise<{ images: string[]; issues: ImgIssue[]; imageFix: Record<string, string>; ms: number }> {
  const t0 = Date.now();
  const issues: ImgIssue[] = [];
  const list = urls.filter((u) => /^https:\/\//i.test(u)).slice(0, 9);
  const imageFix: Record<string, string> = {};
  if (!list.length) return { images: [], issues: [{ code: "images_missing", field: "images", msg: "En az 1 görsel gerekli.", fixed: false, severity: "ERROR" }], imageFix, ms: 0 };
  const cached = opts.cache?.[list[0]];
  if (cached) { imageFix[list[0]] = cached; return { images: [cached, ...list.slice(1)], issues, imageFix, ms: Date.now() - t0 }; }

  const process = async (url: string, bytes: Uint8Array, why: string[]) => {
    const img = await decode(bytes);
    const changed = whitenBackground(img);
    const out = frameProduct(img);
    const jpeg = await out.encodeJPEG(90);
    const fixed = await opts.upload(`${opts.pathPrefix}-${await hash8(url)}.jpg`, jpeg);
    if (changed) why.push("zemin saf beyaza çekildi");
    return fixed;
  };

  // 1) Ana görsel
  const main = await fetchBytes(list[0]);
  let mainA: Analysis | null = null;
  if (main) { try { mainA = analyze(await decode(main.bytes)); } catch (_) { mainA = null; } }
  if (!main || !mainA) {
    issues.push({ code: "image_unreadable", field: "main_product_image_locator", fixed: false, severity: "WARNING", msg: "Ana görsel okunamadı (biçim JPEG / PNG değil ya da erişilemiyor); olduğu gibi gönderildi." });
    return { images: list, issues, imageFix, ms: Date.now() - t0 };
  }
  if (mainA.ok) return { images: list, issues, imageFix, ms: Date.now() - t0 };
  const why: string[] = [];
  if (Math.max(mainA.width, mainA.height) < ZOOM_SIDE) why.push(`boyut ${mainA.width}×${mainA.height} → en az ${ZOOM_SIDE} px`);
  if (mainA.fill < 0.85) why.push(`ürün karenin %${Math.round(mainA.fill * 100)}'ini dolduruyordu → %${Math.round(TARGET_FILL * 100)}`);
  if (mainA.fixable) {
    const fixed = await process(list[0], main.bytes, why);
    imageFix[list[0]] = fixed;
    issues.push({ code: "main_image_fixed", field: "main_product_image_locator", fixed: true, severity: "WARNING", msg: "Ana görsel Amazon kurallarına göre düzeltildi: " + why.join(", ") + "." });
    return { images: [fixed, ...list.slice(1)], issues, imageFix, ms: Date.now() - t0 };
  }
  // 2) Zemin beyaz değil: kurala uyan (ya da düzeltilebilir) başka bir görsel ana görsel olur
  for (let i = 1; i < Math.min(list.length, 5); i++) {
    const b = await fetchBytes(list[i]);
    if (!b) continue;
    let a: Analysis;
    try { a = analyze(await decode(b.bytes)); } catch (_) { continue; }
    if (!a.ok && !a.fixable) continue;
    const w2: string[] = [];
    const chosen = a.ok ? list[i] : await process(list[i], b.bytes, w2);
    if (!a.ok) imageFix[list[i]] = chosen;
    imageFix[list[0]] = chosen;
    issues.push({ code: "main_image_swapped", field: "main_product_image_locator", fixed: true, severity: "WARNING",
      msg: `Ana görselin zemini beyaz değil; Amazon kuralına uyan ${i + 1}. görsel ana görsel yapıldı${w2.length ? " (" + w2.join(", ") + ")" : ""}.` });
    return { images: [chosen, ...list.filter((_, k) => k !== i)], issues, imageFix, ms: Date.now() - t0 };
  }
  // 3) Ücretli zemin silme (anahtar varsa)
  const cut = await removeBackground(list[0]);
  if (cut) {
    const fixed = await process(list[0], cut, why);
    imageFix[list[0]] = fixed;
    issues.push({ code: "main_image_bg_removed", field: "main_product_image_locator", fixed: true, severity: "WARNING", msg: "Ana görselin zemini silinip beyaz yapıldı." });
    return { images: [fixed, ...list.slice(1)], issues, imageFix, ms: Date.now() - t0 };
  }
  issues.push({ code: "main_image_background", field: "main_product_image_locator", fixed: false, severity: "WARNING",
    msg: "Ana görselin zemini beyaz değil ve beyaz zeminli başka görsel yok. Amazon ilanı aramada gizleyebilir; beyaz zeminli bir ürün fotoğrafı ekle." });
  return { images: list, issues, imageFix, ms: Date.now() - t0 };
}
