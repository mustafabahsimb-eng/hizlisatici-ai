// =========================================================
// Amazon siparişi için etiket: Amazon "Buy Shipping" (Merchant Fulfillment API v0)
// Akış: getEligibleShipmentServices -> en ucuz (ek bilgi istemeyen) hizmet -> createShipment -> etiket (Base64 + GZip; PNG/PDF)
// Amazon'dan alınan etiketlerde gönderim Amazon tarafından siparişe işlenir (ayrıca confirmShipment gerekmez).
// Hizmet her pazarda yok; Amazon hata dönerse gönderi satıcının kendi kargo hesabına (shipping-hub sağlayıcıları) düşer.
// Etiket ücreti satıcının Amazon hesabından kesilir.
// =========================================================
import { type AmazonMarket, type Ctx, sp } from "./amazon.ts";

// Amazon'un ölçü birimleri: ABD'de inç/ons, diğerlerinde cm/gram
export function units(market: AmazonMarket) {
  return market.country === "US" ? { len: "inches", weight: "oz" } : { len: "centimeters", weight: "g" };
}

export type ShipFrom = { Name: string; AddressLine1: string; AddressLine2?: string; City: string; StateOrProvinceCode?: string; PostalCode: string; CountryCode: string; Phone: string; Email: string };

// Gönderen adresi: Amazon siparişindeki satıcı gönderim adresi (DefaultShipFromLocationAddress) ya da kargo hesabındaki gönderen
export function shipFromAddress(order: any, sender: any): ShipFrom | null {
  const a = order?.DefaultShipFromLocationAddress;
  if (a?.AddressLine1) {
    return { Name: a.Name, AddressLine1: a.AddressLine1, ...(a.AddressLine2 ? { AddressLine2: a.AddressLine2 } : {}), City: a.City,
      ...(a.StateOrRegion ? { StateOrProvinceCode: a.StateOrRegion } : {}), PostalCode: a.PostalCode, CountryCode: a.CountryCode, Phone: a.Phone || sender?.phone || "", Email: sender?.email || "" };
  }
  if (sender?.address && sender?.city) {
    return { Name: sender.name || "", AddressLine1: sender.address, City: sender.city, PostalCode: sender.zip || "", CountryCode: sender.country || "TR", Phone: sender.phone || "", Email: sender.email || "" };
  }
  return null;
}

export function shipmentRequest(p: { amazonOrderId: string; orderItemId: string; quantity: number; shipFrom: ShipFrom; market: AmazonMarket;
  dims: { length: number; width: number; height: number }; weight: number }) {
  const u = units(p.market);
  return {
    AmazonOrderId: p.amazonOrderId,
    ItemList: [{ OrderItemId: p.orderItemId, Quantity: p.quantity }],
    ShipFromAddress: p.shipFrom,
    PackageDimensions: { Length: p.dims.length, Width: p.dims.width, Height: p.dims.height, Unit: u.len },
    Weight: { Value: p.weight, Unit: u.weight },
    ShippingServiceOptions: { DeliveryExperience: "NoTracking", CarrierWillPickUp: false, CarrierWillPickUpOption: "ShipperWillDropOff" },
  };
}

// Ürün ölçüsü (cm, kg) -> pazar birimi
export function parcelFor(market: AmazonMarket, product: any, qty: number) {
  const kg = Math.max(0.1, Number(product?.weight_kg || 0.5) * qty);
  const l = Number(product?.length_cm || 20), w = Number(product?.width_cm || 15), h = Number(product?.height_cm || 10) * Math.max(1, qty);
  if (units(market).len === "inches") {
    const r = (x: number) => Math.round(x / 2.54 * 100) / 100;
    return { dims: { length: r(l), width: r(w), height: r(h) }, weight: Math.round(kg * 35.274 * 100) / 100 };
  }
  return { dims: { length: l, width: w, height: h }, weight: Math.round(kg * 1000) };
}

export async function gunzipBase64(b64: string): Promise<Uint8Array> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ds = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")));
  return new Uint8Array(await ds.arrayBuffer());
}

export type AmazonLabel = { shipmentId: string; trackingId: string | null; carrier: string; service: string; cost: number | null; currency: string | null;
  fileType: string; contents: string };

export async function buyAmazonLabel(ctx: Ctx, details: ReturnType<typeof shipmentRequest>): Promise<AmazonLabel> {
  const el = await sp(ctx, "POST", "/mfn/v0/eligibleShippingServices", { body: { ShipmentRequestDetails: details } });
  const all: any[] = el?.payload?.ShippingServiceList || [];
  if (!all.length) throw new Error("Amazon bu sipariş için kargo hizmeti sunmadı");
  // En ucuz; ek satıcı bilgisi istemeyen hizmet önce (isteyen hizmette Amazon eksik bilgi hatası dönerse gönderi satıcının kargo hesabına düşer)
  const cheap = (a: any, b: any) => Number(a.Rate?.Amount ?? 1e9) - Number(b.Rate?.Amount ?? 1e9);
  const plain = all.filter((s) => !s.RequiresAdditionalSellerInputs).sort(cheap);
  const pick = plain[0] || [...all].sort(cheap)[0];
  const cr = await sp(ctx, "POST", "/mfn/v0/shipments", {
    body: { ShipmentRequestDetails: details, ShippingServiceId: pick.ShippingServiceId, ShippingServiceOfferId: pick.ShippingServiceOfferId },
  });
  const p = cr?.payload || {};
  const fc = p.Label?.FileContents;
  if (!fc?.Contents) throw new Error("Amazon etiket dosyası gelmedi");
  return {
    shipmentId: p.ShipmentId, trackingId: p.TrackingId || null,
    carrier: String(p.ShippingService?.CarrierName || pick.CarrierName || "Amazon").replace(/®/g, ""),
    service: String(p.ShippingService?.ShippingServiceName || pick.ShippingServiceName || "").replace(/®/g, ""),
    cost: p.ShippingService?.Rate?.Amount ?? pick.Rate?.Amount ?? null, currency: p.ShippingService?.Rate?.CurrencyCode ?? pick.Rate?.CurrencyCode ?? null,
    fileType: fc.FileType || "image/png", contents: fc.Contents,
  };
}

// Etiket PNG ise yazdırılabilir A6 PDF'e çevrilir (tüm etiketler panelde aynı biçimde)
export async function labelToPdf(l: { fileType: string; contents: string }): Promise<Uint8Array> {
  const file = await gunzipBase64(l.contents);
  if (l.fileType === "application/pdf") return file;
  const { PDFDocument } = await import("npm:pdf-lib@1.17.1");
  const pdf = await PDFDocument.create();
  const img = l.fileType === "image/png" ? await pdf.embedPng(file) : await pdf.embedJpg(file);
  const W = 297.6, H = 419.5; // A6 (pt)
  const s = Math.min(W / img.width, H / img.height);
  const page = pdf.addPage([W, H]);
  page.drawImage(img, { x: (W - img.width * s) / 2, y: (H - img.height * s) / 2, width: img.width * s, height: img.height * s });
  return await pdf.save();
}
