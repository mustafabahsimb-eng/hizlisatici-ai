// =========================================================
// Etsy'ye ilan gönderme (Open API v3)
// Yeni ilan: createDraftListing (type: download | physical) -> uploadListingImage (en fazla 10) -> uploadListingFile (en fazla 5, dijital)
//            -> isteğe bağlı yayınlama: updateListing state=active (Etsy yayınlanan her ilan için ücret alır; varsayılan TASLAK)
// Var olan ilan: updateListing (başlık / açıklama / etiketler) + updateListingInventory (fiyat / adet); eksik görsel / dosya eklenir,
//                Seltigo'da silinen / değiştirilen görsel ve dosya Etsy'den de silinir (yenisi yüklendikten sonra).
// Dijital ilan sabitleri (Mustafa, 15 Ekim 2026): kategori Digital Prints, who_made i_did, when_made 2020_2026, is_supply false.
// Yüklenenler listings.validation.etsy içinde izlenir (tekrar yükleme olmaz).
// listings.attributes: etsy_publish (yayınla), etsy_auto_renew (Etsy 4 ayda bir kendiliğinden yeniler, yenileme ücretli),
//   etsy_replace_media (Seltigo dışında açılmış ilanı devralırken Etsy'deki eski görsel ve dosyaları yenileriyle değiştir; bir kez).
// =========================================================
import { cleanTags, cleanTitle, etsy, EtsyError, etsyTaxonomyId, type EtsyCtx } from "./etsy.ts";

export type EtsySubmit = {
  db: any; ctx: EtsyCtx; shopId: string; listing: any; product: any;
  images: { url: string }[];                                   // sırayla; ilki kapak
  files: { id: string; path: string; name: string; rank: number }[];
  publish: boolean;
  download?: (path: string) => Promise<Blob>;                 // product-files deposundan
  fetchImage?: (url: string) => Promise<Blob>;
};
export type EtsyResult = { ok: boolean; listingId: string | null; state: string | null; url: string | null; errors: string[]; warnings: string[]; etsy: Record<string, any> };

const plain = (s: string) => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();

async function defaultFetchImage(url: string): Promise<Blob> {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Seltigo/1.0)" }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`Görsel indirilemedi (${r.status})`);
  return await r.blob();
}

export async function submitEtsyListing(p: EtsySubmit): Promise<EtsyResult> {
  const { db, ctx, shopId, listing, product } = p;
  const prev: Record<string, any> = listing.validation?.etsy || {};
  const errors: string[] = [], warnings: string[] = [];
  const digital = product.product_type === "digital";
  const title = cleanTitle(listing.title || product.generated_title || product.name);
  const description = plain(listing.description || product.generated_description || "") || title;
  const price = Number(listing.price) || 0;
  const quantity = digital ? 999 : Math.max(0, Math.min(999, Number(product.stock_qty ?? 1)));
  let tags = cleanTags(Array.isArray(listing.keywords) ? listing.keywords : []);
  const attrs = listing.attributes || {};
  const autoRenew = typeof attrs.etsy_auto_renew === "boolean" ? attrs.etsy_auto_renew : undefined;
  if (!title) errors.push("Başlık boş");
  if (price < 0.2) errors.push("Etsy'de fiyat en az 0,20 olmalı");
  if (!p.images.length) errors.push("En az 1 görsel gerekli");
  if (digital && !p.files.length) errors.push("Dijital üründe en az 1 indirilebilir dosya gerekli");
  if (!tags.length) warnings.push("Etiket yok; Etsy aramasında görünürlük düşer");
  if (errors.length) return { ok: false, listingId: prev.listing_id || null, state: prev.state || null, url: prev.url || null, errors, warnings, etsy: prev };

  const base = `/shops/${shopId}/listings`;
  let listingId: string | null = prev.listing_id || null;
  let state: string | null = prev.state || null;
  let url: string | null = prev.url || null;
  const etsyState: Record<string, any> = { ...prev, images: [...(prev.images || [])], files: [...(prev.files || [])] };

  // 1) Taslak ilan (yoksa) ya da güncelleme
  if (!listingId) {
    let shippingProfileId: number | undefined;
    if (!digital) {
      const sp = await etsy(ctx, "GET", `/shops/${shopId}/shipping-profiles`);
      shippingProfileId = sp?.results?.[0]?.shipping_profile_id;
      if (!shippingProfileId) return { ok: false, listingId: null, state: null, url: null, errors: ["Etsy mağazanda kargo profili yok (fiziksel ürün için gerekli)"], warnings, etsy: prev };
    }
    const taxonomyId = digital ? await etsyTaxonomyId(db, ctx, "Digital Prints", "Prints") : await etsyTaxonomyId(db, ctx, "Prints", "Art");
    const d = await etsy(ctx, "POST", base, {
      form: {
        quantity, title, description, price: price.toFixed(2), who_made: "i_did", when_made: "2020_2026", is_supply: false,
        taxonomy_id: taxonomyId, type: digital ? "download" : "physical", tags: tags.length ? tags : undefined,
        shipping_profile_id: shippingProfileId, should_auto_renew: autoRenew === true,
      },
    });
    listingId = String(d.listing_id);
    state = d.state || "draft";
    url = d.url || null;
    etsyState.listing_id = listingId;
    etsyState.created_at = new Date().toISOString();
  } else {
    await etsy(ctx, "PATCH", `${base}/${listingId}`, { form: { title, description, tags: tags.length ? tags : undefined, should_auto_renew: autoRenew } });
    try {
      const inv = await etsy(ctx, "GET", `/listings/${listingId}/inventory`);
      const products = (inv.products || []).map((pr: any) => ({
        sku: pr.sku || "", property_values: pr.property_values || [],
        offerings: (pr.offerings || [{}]).map((o: any) => ({ price: price, quantity, is_enabled: o.is_enabled !== false })),
      }));
      if (products.length) await etsy(ctx, "PUT", `/listings/${listingId}/inventory`, { json: { products, price_on_property: inv.price_on_property || [], quantity_on_property: inv.quantity_on_property || [], sku_on_property: inv.sku_on_property || [] } });
    } catch (e) { warnings.push("Fiyat / adet güncellenemedi: " + (e as Error).message); }
  }

  // Devralınan ilan: Etsy'deki eski görsel ve dosyalar (Seltigo'nun yüklemedikleri) yenileriyle değiştirilecek
  let oldImages: number[] = [], oldFiles: number[] = [];
  const replacing = attrs.etsy_replace_media === true && !!prev.listing_id && !prev.media_replaced_at;
  if (replacing) {
    if (!state) { const g = await etsy(ctx, "GET", `/listings/${listingId}`); state = g.state || null; url = g.url || url; }  // devralınan ilanın Etsy'deki durumu
    const im = await etsy(ctx, "GET", `/listings/${listingId}/images`);
    oldImages = (im.results || []).map((x: any) => x.listing_image_id).filter((id: number) => !etsyState.images.some((y: any) => y.listing_image_id === id));
    if (digital) {
      const fl = await etsy(ctx, "GET", `${base}/${listingId}/files`);
      oldFiles = (fl.results || []).map((x: any) => x.listing_file_id).filter((id: number) => !etsyState.files.some((y: any) => y.listing_file_id === id));
    }
  }

  // 2) Görseller (en fazla 10; yüklenenler atlanır)
  const fetchImage = p.fetchImage || defaultFetchImage;
  for (let i = 0; i < Math.min(10, p.images.length); i++) {
    const im = p.images[i];
    if (etsyState.images.some((x: any) => x.src === im.url)) continue;
    try {
      const blob = await fetchImage(im.url);
      const fd = new FormData();
      fd.append("image", blob, `image-${i + 1}.${/png/.test(blob.type) ? "png" : "jpg"}`);
      fd.append("rank", String(i + 1));
      const d = await etsy(ctx, "POST", `${base}/${listingId}/images`, { multipart: fd });
      etsyState.images.push({ src: im.url, listing_image_id: d.listing_image_id, rank: i + 1 });
    } catch (e) { warnings.push(`Görsel ${i + 1} yüklenemedi: ${(e as Error).message}`); }
  }

  // Seltigo'da değiştirilen / kaldırılan görsel Etsy'den de silinir (yenisi yüklendikten SONRA; ilan görselsiz kalmaz)
  const wanted = new Set(p.images.slice(0, 10).map((x) => x.url));
  const stale = etsyState.images.filter((x: any) => !wanted.has(x.src));
  if (stale.length && etsyState.images.some((x: any) => wanted.has(x.src))) {
    for (const x of stale) {
      try { await etsy(ctx, "DELETE", `${base}/${listingId}/images/${x.listing_image_id}`); etsyState.images = etsyState.images.filter((y: any) => y !== x); }
      catch (e) { if (e instanceof EtsyError && e.status === 404) etsyState.images = etsyState.images.filter((y: any) => y !== x); else warnings.push("Etsy'deki eski görsel silinemedi"); }
    }
  }

  // Eski görseller: yeniler yüklendikten SONRA silinir (yayındaki ilan görselsiz kalmasın)
  if (replacing && etsyState.images.length) {
    for (const id of oldImages) {
      try { await etsy(ctx, "DELETE", `${base}/${listingId}/images/${id}`); } catch (e) { if (!(e instanceof EtsyError && e.status === 404)) warnings.push("Etsy'deki eski görsel silinemedi"); }
    }
  }

  // 3) Dijital dosyalar (en fazla 5): eksikler yüklenir, Seltigo'da silinenler Etsy'den de silinir
  if (digital) {
    const keep = new Set(p.files.map((f) => f.id));
    for (const ef of [...etsyState.files]) {
      if (!keep.has(ef.product_file_id)) {
        try { await etsy(ctx, "DELETE", `${base}/${listingId}/files/${ef.listing_file_id}`); } catch (e) { if (!(e instanceof EtsyError && e.status === 404)) warnings.push("Etsy'deki eski dosya silinemedi"); }
        etsyState.files = etsyState.files.filter((x: any) => x !== ef);
      }
    }
    for (const f of p.files.slice(0, 5)) {
      if (etsyState.files.some((x: any) => x.product_file_id === f.id)) continue;
      // Devralınan ilanda: Etsy en fazla 5 dosya alır -> önce bir eski dosyayı sil, sonra yenisini yükle (ilan dosyasız kalmaz)
      const total = etsyState.files.length + oldFiles.length;
      if (replacing && oldFiles.length && total >= 5) {
        const id = oldFiles.shift()!;
        try { await etsy(ctx, "DELETE", `${base}/${listingId}/files/${id}`); } catch (e) { if (!(e instanceof EtsyError && e.status === 404)) warnings.push("Etsy'deki eski dosya silinemedi"); }
      }
      try {
        const blob = p.download ? await p.download(f.path) : (() => { throw new Error("dosya okunamadı"); })();
        const fd = new FormData();
        fd.append("file", blob, f.name);
        fd.append("name", f.name.slice(0, 70));
        fd.append("rank", String(f.rank));
        const d = await etsy(ctx, "POST", `${base}/${listingId}/files`, { multipart: fd });
        etsyState.files.push({ product_file_id: f.id, listing_file_id: d.listing_file_id, name: f.name });
      } catch (e) { errors.push(`Dosya "${f.name}" yüklenemedi: ${(e as Error).message}`); }
    }
  }

  if (replacing && !errors.length) {
    for (const id of oldFiles) {
      try { await etsy(ctx, "DELETE", `${base}/${listingId}/files/${id}`); } catch (e) { if (!(e instanceof EtsyError && e.status === 404)) warnings.push("Etsy'deki eski dosya silinemedi"); }
    }
    etsyState.media_replaced_at = new Date().toISOString();
  }

  // 4) Yayınla (istenirse; görsel ve dijitalde dosya şart)
  const canPublish = etsyState.images.length > 0 && (!digital || etsyState.files.length > 0) && !errors.length;
  if (p.publish && state !== "active") {
    if (!canPublish) errors.push("Yayınlanamadı: görsel ya da dosya eksik");
    else {
      const d = await etsy(ctx, "PATCH", `${base}/${listingId}`, { form: { state: "active" } });
      state = d.state || "active";
      url = d.url || url;
      etsyState.published_at = new Date().toISOString();
    }
  }
  etsyState.state = state;
  etsyState.url = url || (listingId ? `https://www.etsy.com/listing/${listingId}` : null);
  etsyState.synced_at = new Date().toISOString();
  return { ok: !errors.length, listingId, state, url: etsyState.url, errors, warnings, etsy: etsyState };
}
