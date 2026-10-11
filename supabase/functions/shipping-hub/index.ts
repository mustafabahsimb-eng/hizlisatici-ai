// =========================================================
// Seltigo - shipping-hub (kargo: gönderi oluşturma, etiket PDF'i, takip)
// Bizim şirketimizi gerektirmez; her satıcı kendi hesabıyla çalışır. Üç yol:
//   1) Pazaryeri siparişi -> etiket pazaryerinin anlaşmalı kargosundan (Trendyol: createCommonLabel / getCommonLabel)
//   2) Satıcının kendi kargo anlaşması -> Yurtiçi (SOAP; test ortamı denendi), Aras, MNG, PTT, Sürat, HepsiJet
//   3) Anlaşması olmayan satıcı -> kargo aracı platformu: Geliver (test modu var), Basit Kargo
// Mağaza siparişi gelince (Kendi stoğum / Toptancı ürünleri) gönderi otomatik oluşturulur (shipments kuyruğu,
// tetikleyici store_order_to_shipment); etiket PDF'i özel depoya, takip numarası siparişe ve müşteri takip sayfasına.
//
// Satıcı (oturum): { action: "connect", provider, mode, credentials, settings, makeDefault }
//                  { action: "disconnect", accountId } | { action: "create", storeOrderId } | { action: "label", shipmentId }
//                  { action: "create", marketplaceOrderId } -> pazaryeri (ör. Amazon) siparişine gönderi
// Pazaryeri siparişleri: satıcının kendi stoğundaki ürünün Amazon siparişi -> varsayılan kargo hesabı; hesap yoksa ve pazar
//   destekliyorsa Amazon "Buy Shipping" etiketi (provider "amazon"; tetikleyici marketplace_order_to_shipment).
// Sistem (CRON_SECRET): {} -> bekleyen gönderileri oluştur + açık gönderilerin takibini güncelle
//                       { shipmentId } -> tek gönderi
// Kimlik bilgileri Vault'ta (shipping_account_*_credentials); depoda ve tarayıcıda görünmez.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { installEgress } from "../_shared/egress.ts";
import { marketByCode } from "../_shared/amazon.ts";
import { notifyWhatsApp } from "../_shared/customer-notify.ts";
import { buyAmazonLabel, labelToPdf, parcelFor, shipFromAddress, shipmentRequest } from "../_shared/amazon-shipping.ts";
installEgress(); // sabit IP çıkışı (Yurtiçi canlı ortamı IP izni ister; bkz. docs/sabit-ip-kurulumu.md)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const TIME_BUDGET_MS = 100_000;
const TRACK_EVERY_MIN = 120;
const MAX_ATTEMPTS = 5;

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const short = (v: unknown, n = 300) => String(v ?? "").slice(0, n);

// ---------------- Ortak yardımcılar ----------------
const TR_MAP: Record<string, string> = { "ç": "c", "Ç": "C", "ğ": "g", "Ğ": "G", "ı": "i", "İ": "I", "ö": "o", "Ö": "O", "ş": "s", "Ş": "S", "ü": "u", "Ü": "U" };
const ascii = (s: unknown) => String(s ?? "").replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR_MAP[c] || c).replace(/[^\x20-\x7E]/g, "");
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const phoneTR = (p: unknown) => {
  const d = String(p ?? "").replace(/\D/g, "");
  if (d.startsWith("90") && d.length === 12) return "+" + d;
  if (d.startsWith("0") && d.length === 11) return "+9" + d;
  if (d.length === 10) return "+90" + d;
  return d ? "+" + d : "";
};
// İl plaka kodları (Geliver gibi servisler il kodu ister)
const PLATES = ["Adana", "Adıyaman", "Afyonkarahisar", "Ağrı", "Amasya", "Ankara", "Antalya", "Artvin", "Aydın", "Balıkesir", "Bilecik", "Bingöl", "Bitlis", "Bolu", "Burdur", "Bursa", "Çanakkale", "Çankırı", "Çorum", "Denizli", "Diyarbakır", "Edirne", "Elazığ", "Erzincan", "Erzurum", "Eskişehir", "Gaziantep", "Giresun", "Gümüşhane", "Hakkari", "Hatay", "Isparta", "Mersin", "İstanbul", "İzmir", "Kars", "Kastamonu", "Kayseri", "Kırklareli", "Kırşehir", "Kocaeli", "Konya", "Kütahya", "Malatya", "Manisa", "Kahramanmaraş", "Mardin", "Muğla", "Muş", "Nevşehir", "Niğde", "Ordu", "Rize", "Sakarya", "Samsun", "Siirt", "Sinop", "Sivas", "Tekirdağ", "Tokat", "Trabzon", "Tunceli", "Şanlıurfa", "Uşak", "Van", "Yozgat", "Zonguldak", "Aksaray", "Bayburt", "Karaman", "Kırıkkale", "Batman", "Şırnak", "Bartın", "Ardahan", "Iğdır", "Yalova", "Karabük", "Kilis", "Osmaniye", "Düzce"];
const normCity = (s: string) => ascii(s).toLowerCase().replace(/[^a-z]/g, "");
function plateOf(city: string): string {
  const n = normCity(city);
  if (n === "icel") return "33";
  const i = PLATES.findIndex((c) => normCity(c) === n);
  return i >= 0 ? String(i + 1).padStart(2, "0") : "";
}

// ---------------- Code128-B barkod + etiket PDF'i (kendi etiketini vermeyen firmalar için) ----------------
const C128 = ["212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111", "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232", "2331112"];
function code128B(text: string): number[] {
  const codes = [104];
  for (const ch of text) codes.push(Math.max(0, Math.min(94, ch.charCodeAt(0) - 32)));
  let sum = codes[0];
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103, 106);
  const widths: number[] = [];
  codes.forEach((c) => C128[c].split("").forEach((w) => widths.push(Number(w))));
  return widths; // sırayla çubuk / boşluk genişlikleri (modül cinsinden)
}

async function makeLabelPdf(o: {
  barcode: string; carrier: string; orderNo: string; senderName: string; senderAddr: string; senderPhone: string;
  recvName: string; recvAddr: string; recvPhone: string; product: string; qty: number; test: boolean;
}): Promise<Uint8Array> {
  // PDF kütüphanesi yalnız etiket gerektiğinde yüklenir (fonksiyon hızlı açılsın)
  const { PDFDocument, StandardFonts, rgb } = await import("npm:pdf-lib@1.17.1");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([283, 425]); // 100 x 150 mm
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  const fb = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const wrap = (s: string, max: number) => {
    const words = ascii(s).split(/\s+/); const lines: string[] = []; let cur = "";
    for (const w of words) { if ((cur + " " + w).trim().length > max) { if (cur) lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
    if (cur) lines.push(cur);
    return lines.slice(0, 4);
  };
  let y = 405;
  page.drawText(ascii(o.carrier).toUpperCase() + (o.test ? "  (TEST)" : ""), { x: 14, y, size: 14, font: fb, color: black });
  page.drawText("Siparis: " + ascii(o.orderNo), { x: 14, y: y - 16, size: 8, font: f });
  y -= 34;
  page.drawLine({ start: { x: 10, y }, end: { x: 273, y }, thickness: 1 });
  y -= 14;
  page.drawText("ALICI", { x: 14, y, size: 8, font: fb }); y -= 14;
  page.drawText(ascii(o.recvName).slice(0, 40), { x: 14, y, size: 12, font: fb }); y -= 14;
  for (const l of wrap(o.recvAddr, 48)) { page.drawText(l, { x: 14, y, size: 9, font: f }); y -= 11; }
  page.drawText("Tel: " + ascii(o.recvPhone), { x: 14, y, size: 9, font: f }); y -= 18;
  page.drawLine({ start: { x: 10, y }, end: { x: 273, y }, thickness: 0.5 }); y -= 12;
  page.drawText("GONDEREN", { x: 14, y, size: 7, font: fb }); y -= 11;
  page.drawText(ascii(o.senderName).slice(0, 48), { x: 14, y, size: 8, font: f }); y -= 10;
  for (const l of wrap(o.senderAddr, 60).slice(0, 2)) { page.drawText(l, { x: 14, y, size: 7, font: f }); y -= 9; }
  page.drawText("Tel: " + ascii(o.senderPhone), { x: 14, y, size: 7, font: f }); y -= 14;
  page.drawText(("Urun: " + ascii(o.product)).slice(0, 60) + "  x" + o.qty, { x: 14, y, size: 7, font: f });
  // Barkod
  const widths = code128B(o.barcode);
  const total = widths.reduce((a, b) => a + b, 0);
  const mod = Math.min(1.6, 250 / total);
  let x = (283 - total * mod) / 2;
  widths.forEach((w, i) => { if (i % 2 === 0) page.drawRectangle({ x, y: 40, width: w * mod, height: 70, color: black }); x += w * mod; });
  page.drawText(o.barcode, { x: (283 - fb.widthOfTextAtSize(o.barcode, 11)) / 2, y: 24, size: 11, font: fb });
  return await pdf.save();
}

// ---------------- Sağlayıcılar ----------------
type Ctx = { shipment: any; account: any; creds: any; order: any; product: any; sender: any; parcel: { desi: number; kg: number; count: number } };
type Created = { ref: string; tracking?: string | null; trackingUrl?: string | null; carrier?: string | null; labelPdf?: Uint8Array | null; cost?: number | null; currency?: string | null; raw?: unknown };
type Tracked = { status: "created" | "shipped" | "delivered" | "cancelled"; tracking?: string | null; trackingUrl?: string | null; carrier?: string | null; raw?: unknown };

// --- Yurtiçi (SOAP) ---
const YK_URL = { test: "http://testwebservices.yurticikargo.com:9090/KOPSWebServices/ShippingOrderDispatcherServices", live: "https://ws.yurticikargo.com/KOPSWebServices/ShippingOrderDispatcherServices" };
async function ykCall(mode: string, op: string, inner: string): Promise<string> {
  const body = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ship="http://yurticikargo.com.tr/ShippingOrderDispatcherServices"><soapenv:Header/><soapenv:Body><ship:${op}>${inner}</ship:${op}></soapenv:Body></soapenv:Envelope>`;
  // Bağlantı kopmalarına karşı 3 deneme (Yurtiçi aynı cargoKey'i ikinci kez oluşturmaz)
  let r: Response | null = null, lastErr: unknown = null;
  for (let i = 0; i < 3 && !r; i++) {
    try {
      r = await fetch(mode === "test" ? YK_URL.test : YK_URL.live, {
        method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' }, body,
        signal: AbortSignal.timeout(30000), // yanıt vermeyen sunucu fonksiyonu kilitlemesin
      });
    } catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 1500 * (i + 1))); }
  }
  if (!r) throw new Error("Yurtiçi'ne bağlanılamadı: " + short((lastErr as Error)?.message, 120));
  const text = await r.text();
  if (!r.ok && !text.includes("Envelope")) throw new Error(`Yurtiçi HTTP ${r.status}`);
  return text;
}
const tag = (xml: string, t: string) => (xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
const yurtici = {
  async verify(mode: string, c: any) {
    const x = await ykCall(mode, "queryShipment", `<wsUserName>${esc(c.wsUserName)}</wsUserName><wsPassword>${esc(c.wsPassword)}</wsPassword><wsLanguage>TR</wsLanguage><keys>SELTIGOVERIFY</keys><keyType>0</keyType><addHistoricalData>false</addHistoricalData><onlyTracking>true</onlyTracking>`);
    const flag = tag(x, "outFlag"), res = tag(x, "outResult");
    if (x.includes("Fault") || (flag && flag !== "0" && /şifre|kullanıcı|user|password|yetki/i.test(res))) throw new Error("Yurtiçi kullanıcı adı / şifre kabul edilmedi: " + short(res || tag(x, "faultstring"), 120));
  },
  async create(x: Ctx): Promise<Created> {
    const key = ("SLT" + x.shipment.id.replace(/-/g, "").slice(0, 14)).toUpperCase();
    const o = x.order;
    const inner = `<wsUserName>${esc(x.creds.wsUserName)}</wsUserName><wsPassword>${esc(x.creds.wsPassword)}</wsPassword><userLanguage>TR</userLanguage>` +
      `<ShippingOrderVO><cargoKey>${key}</cargoKey><invoiceKey>${key}</invoiceKey>` +
      `<receiverCustName>${esc(o.customer_name)}</receiverCustName><receiverAddress>${esc(o.customer_address)}</receiverAddress>` +
      `<cityName>${esc(o.customer_city)}</cityName><townName>${esc(o.customer_district)}</townName>` +
      `<receiverPhone1>${esc(String(o.customer_phone || "").replace(/\D/g, ""))}</receiverPhone1>` +
      `<desi>${x.parcel.desi}</desi><kg>${x.parcel.kg}</kg><cargoCount>1</cargoCount>` +
      `<description>${esc(ascii(x.product?.name || "").slice(0, 100))}</description></ShippingOrderVO>`;
    const res = await ykCall(x.account.mode, "createShipment", inner);
    const flag = tag(res, "outFlag"), detailErr = tag(res, "errMessage");
    if (flag !== "0" || detailErr) throw new Error("Yurtiçi gönderi oluşturulamadı: " + short(detailErr || tag(res, "outResult") || tag(res, "faultstring"), 200));
    return { ref: key, tracking: null, trackingUrl: null, carrier: "Yurtiçi Kargo", raw: { jobId: tag(res, "jobId") } };
  },
  async track(x: { shipment: any; account: any; creds: any }): Promise<Tracked> {
    const res = await ykCall(x.account.mode, "queryShipment", `<wsUserName>${esc(x.creds.wsUserName)}</wsUserName><wsPassword>${esc(x.creds.wsPassword)}</wsPassword><wsLanguage>TR</wsLanguage><keys>${esc(x.shipment.provider_ref)}</keys><keyType>0</keyType><addHistoricalData>false</addHistoricalData><onlyTracking>false</onlyTracking>`);
    const st = tag(res, "operationStatus");
    const docId = tag(res, "docId"), url = tag(res, "trackingUrl");
    const status = st === "DLV" ? "delivered" : st === "CNL" ? "cancelled" : (st === "IND" || st === "ISR" || docId) ? "shipped" : "created";
    return { status, tracking: docId || null, trackingUrl: url || null, carrier: "Yurtiçi Kargo", raw: { operationStatus: st, message: tag(res, "operationMessage") } };
  },
};

// --- Geliver (REST; test modu: "test": true, her GET durumu bir adım ilerletir) ---
const GELIVER = "https://api.geliver.io/api/v1";
async function gv(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(GELIVER + path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let d: any; try { d = text ? JSON.parse(text) : {}; } catch { d = { message: text }; }
  if (!r.ok || d?.result === false) throw new Error("Geliver: " + short(d?.message || d?.additionalMessage || `HTTP ${r.status}`, 200));
  return d?.data !== undefined ? d.data : d;
}
const GV_STATUS: Record<string, Tracked["status"]> = {};
const geliver = {
  async verify(_mode: string, c: any) { await gv(c.token, "GET", "/addresses?limit=1"); },
  async senderId(x: Ctx): Promise<string> {
    if (x.account.settings?.geliverSenderId) return x.account.settings.geliverSenderId;
    const s = x.sender;
    const a = await gv(x.creds.token, "POST", "/addresses", {
      name: s.name, email: s.email || undefined, phone: phoneTR(s.phone), address1: s.address, countryCode: "TR",
      cityName: s.city, cityCode: plateOf(s.city), districtName: s.district, zip: s.zip || "34000", isRecipientAddress: false,
    });
    const id = String(a?.id || "");
    if (!id) throw new Error("Geliver gönderici adresi oluşturulamadı");
    await db.from("shipping_accounts").update({ settings: { ...(x.account.settings || {}), geliverSenderId: id } }).eq("id", x.account.id);
    return id;
  },
  async create(x: Ctx): Promise<Created> {
    const token = x.creds.token;
    const o = x.order;
    const senderAddressID = await geliver.senderId(x);
    let sh = await gv(token, "POST", "/shipments", {
      senderAddressID, test: x.account.mode === "test",
      recipientAddress: {
        name: o.customer_name, phone: phoneTR(o.customer_phone), address1: o.customer_address, countryCode: "TR",
        cityName: o.customer_city, cityCode: plateOf(o.customer_city), districtName: o.customer_district, zip: o.customer_zip || undefined,
      },
      order: { orderNumber: String(o.id).slice(0, 30), sourceCode: "API", sourceIdentifier: "seltigo", totalAmount: String(o.unit_price ? Number(o.unit_price) * (o.quantity || 1) : ""), totalAmountCurrency: o.currency || "TRY" },
      length: "20", width: "15", height: String(Math.max(5, Math.round(x.parcel.desi * 3000 / 300))), distanceUnit: "cm",
      weight: String(x.parcel.kg), massUnit: "kg",
    });
    // Teklifler arka planda hazırlanır
    const t0 = Date.now();
    while (!(sh?.offers?.cheapest) && Date.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 1500));
      sh = await gv(token, "GET", `/shipments/${encodeURIComponent(sh.id)}`);
    }
    const offer = sh?.offers?.cheapest;
    if (!offer?.id) throw new Error("Geliver: bu adres için kargo teklifi alınamadı");
    const tx = await gv(token, "POST", "/transactions", { offerID: offer.id });
    const s2 = tx?.shipment || {};
    let labelPdf: Uint8Array | null = null;
    if (s2.labelURL) {
      const lr = await fetch(s2.labelURL, { headers: { Authorization: `Bearer ${token}` } });
      if (lr.ok) labelPdf = new Uint8Array(await lr.arrayBuffer());
    }
    return {
      ref: String(sh.id), tracking: s2.trackingNumber || s2.barcode || null, trackingUrl: s2.trackingUrl || null,
      carrier: offer.providerCode || s2.providerCode || "Geliver", labelPdf,
      cost: Number(offer.amountLocal ?? offer.amount) || null, currency: offer.currencyLocal || offer.currency || "TRY",
      raw: { offer: { id: offer.id, providerCode: offer.providerCode, amount: offer.amount }, transaction: tx?.id },
    };
  },
  async track(x: { shipment: any; account: any; creds: any }): Promise<Tracked> {
    const s = await gv(x.creds.token, "GET", `/shipments/${encodeURIComponent(x.shipment.provider_ref)}`);
    const code = String(s?.trackingStatus?.trackingStatusCode || "").toUpperCase();
    const status: Tracked["status"] = GV_STATUS[code] ||
      (/DELIVERED/.test(code) ? "delivered" : /CANCEL|RETURN/.test(code) ? "cancelled" : /TRANSIT|PICKED|OUT_FOR|SHIPPED|ACCEPT/.test(code) ? "shipped" : "created");
    return { status, tracking: s?.trackingNumber || s?.barcode || null, trackingUrl: s?.trackingUrl || null, carrier: s?.providerCode || null, raw: { code } };
  },
};

// --- Basit Kargo (REST; test ortamı yok, hesap onayı gerekir) ---
const BK = "https://basitkargo.com/api";
async function bk(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(BK + path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Basit Kargo: " + short(d?.message || d?.error || `HTTP ${r.status}`, 200));
  return d;
}
const basitkargo = {
  async verify(_mode: string, c: any) { await bk(c.token, "GET", "/firm/balance"); },
  async create(_x: Ctx): Promise<Created> {
    // Sipariş + barkod: POST /v2/order/barcode. Alan adları hesap açılınca resmi belgeden doğrulanacak (test ortamı yok).
    throw new Error("Basit Kargo ile gönderi oluşturma, hesap açılıp alanlar resmi belgeden doğrulanınca açılacak");
  },
  async track(_x: { shipment: any; account: any; creds: any }): Promise<Tracked> { return { status: "created" }; },
};

// --- Belge / test erişimi bekleyen firmalar (bilgiler kasada saklanır; gönderi açılınca otomatik başlar) ---
const pendingProvider = (name: string) => ({
  async verify(_mode: string, _c: any) { /* resmi belge ve test erişimi gelince doğrulanacak */ },
  async create(_x: Ctx): Promise<Created> { throw new Error(`${name} entegrasyonu için firmanın resmi web servis belgesi ve test erişimi bekleniyor`); },
  async track(_x: { shipment: any; account: any; creds: any }): Promise<Tracked> { return { status: "created" }; },
});

const PROVIDERS: Record<string, any> = {
  yurtici, geliver, basitkargo,
  aras: pendingProvider("Aras Kargo"), mng: pendingProvider("MNG Kargo"), ptt: pendingProvider("PTT Kargo"),
  surat: pendingProvider("Sürat Kargo"), hepsijet: pendingProvider("HepsiJet"),
};
const CARRIER_NAMES: Record<string, string> = {
  yurtici: "Yurtiçi Kargo", geliver: "Geliver", basitkargo: "Basit Kargo", aras: "Aras Kargo", mng: "MNG Kargo", ptt: "PTT Kargo", surat: "Sürat Kargo", hepsijet: "HepsiJet",
};

// --- Pazaryeri etiketi: Trendyol (ZPL -> PDF; Labelary) ---
async function trendyolLabel(sellerId: string, apiKey: string, apiSecret: string, cargoTrackingNumber: string): Promise<Uint8Array> {
  const auth = "Basic " + btoa(`${apiKey}:${apiSecret}`);
  const base = `https://apigw.trendyol.com/integration/sellers/${encodeURIComponent(sellerId)}/common-label`;
  const h = { Authorization: auth, "User-Agent": `${sellerId} - SelfIntegration`, "Content-Type": "application/json" };
  await fetch(`${base}/${encodeURIComponent(cargoTrackingNumber)}`, { method: "POST", headers: h, body: JSON.stringify({ format: "ZPL", boxQuantity: 1 }) });
  const r = await fetch(`${base}/${encodeURIComponent(cargoTrackingNumber)}`, { headers: h });
  const d = await r.json().catch(() => ({}));
  const zpl = d?.data?.[0]?.label || d?.label || "";
  if (!zpl) throw new Error("Trendyol etiketi alınamadı: " + short(JSON.stringify(d), 150));
  const pr = await fetch("https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0/", { method: "POST", headers: { Accept: "application/pdf", "Content-Type": "application/x-www-form-urlencoded" }, body: zpl });
  if (!pr.ok) throw new Error("Etiket PDF'e çevrilemedi");
  return new Uint8Array(await pr.arrayBuffer());
}

// ---------------- İş akışı ----------------
async function creds(accountId: string): Promise<any> {
  const { data, error } = await db.rpc("shipping_account_get_credentials", { p_account_id: accountId });
  if (error) throw new Error("Kasa: " + error.message);
  return data || {};
}

// Pazaryeri siparişini (marketplace_orders) kargo sağlayıcılarının beklediği sipariş biçimine çevirir
function mpOrderShape(mo: any) {
  const a = mo.buyer_address || {};
  return {
    id: mo.id, product_id: mo.product_id, quantity: mo.quantity, status: mo.status, customer_name: mo.buyer_name, customer_phone: mo.buyer_phone,
    customer_address: [a.line1, a.line2, a.line3].filter(Boolean).join(" ") || a.text || "", customer_city: a.city || "", customer_district: a.district || a.state || "",
    customer_zip: a.zip || "", customer_country: a.country || mo.buyer_country || "TR", _mp: mo,
  };
}
async function saveLabel(sh: any, pdf: Uint8Array) {
  const path = `${sh.user_id}/${sh.id}.pdf`;
  const up = await db.storage.from("shipping-labels").upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (up.error) throw new Error("Etiket kaydı: " + up.error.message);
  return path;
}

// Amazon "Buy Shipping": etiket Amazon'dan, ücret satıcının Amazon hesabından; gönderim Amazon'da kendiliğinden işlenir
async function createAmazonShipment(sh: any, mo: any) {
  const market = marketByCode(mo.marketplace_code);
  if (!market) throw new Error("Amazon pazarı bilinmiyor");
  const { data: cred } = await db.rpc("store_connection_get_credentials", { p_connection_id: mo.connection_id });
  if (!cred?.refresh_token) throw new Error("Amazon bağlantısı yok");
  const { data: conn } = await db.from("store_connections").select("environment").eq("id", mo.connection_id).maybeSingle();
  const { data: product } = await db.from("products").select("name, weight_kg, length_cm, width_cm, height_cm").eq("id", mo.product_id).maybeSingle();
  const { data: acc } = await db.from("shipping_accounts").select("settings").eq("user_id", sh.user_id).eq("is_default", true).maybeSingle();
  const from = shipFromAddress(mo.raw?.order, acc?.settings?.sender || {});
  if (!from) throw new Error("Gönderen adresi yok (Amazon gönderim adresi ya da kargo ayarlarında gönderen adresi gerekli)");
  const parcel = parcelFor(market, product, mo.quantity || 1);
  const label = await buyAmazonLabel({ region: cred.region || market.region, refreshToken: cred.refresh_token, sandbox: conn?.environment === "sandbox" },
    shipmentRequest({ amazonOrderId: mo.raw?.amazonOrderId || String(mo.external_order_id).split("/")[0], orderItemId: mo.raw?.orderItemId, quantity: mo.quantity || 1,
      shipFrom: from, market, ...parcel }));
  const path = await saveLabel(sh, await labelToPdf(label));
  const now = new Date().toISOString();
  await db.from("shipments").update({
    status: "shipped", provider_ref: label.shipmentId, tracking_number: label.trackingId, carrier: label.carrier, label_path: path, cost: label.cost, currency: label.currency,
    raw: { service: label.service }, last_error: null, next_attempt_at: new Date(Date.now() + 365 * 86400_000).toISOString(), updated_at: now,
  }).eq("id", sh.id);
  await db.from("marketplace_orders").update({ tracking_number: label.trackingId, carrier: label.carrier, tracking_pushed_at: now, status: "shipped", shipped_at: now }).eq("id", mo.id);
  return { created: true, ref: label.shipmentId, amazon: true };
}

async function createShipment(sh: any) {
  let mo: any = null;
  if (sh.marketplace_order_id) {
    const r = await db.from("marketplace_orders").select("*").eq("id", sh.marketplace_order_id).maybeSingle();
    mo = r.data;
    if (!mo) throw new Error("Sipariş bulunamadı");
    if (mo.status === "cancelled") { await db.from("shipments").update({ status: "cancelled" }).eq("id", sh.id); return { cancelled: true }; }
    if (sh.provider === "amazon") return await createAmazonShipment(sh, mo);
  }
  const { data: account } = await db.from("shipping_accounts").select("*").eq("id", sh.account_id).maybeSingle();
  if (!account) throw new Error("Kargo hesabı bulunamadı");
  const provider = PROVIDERS[account.provider];
  if (!provider) throw new Error("Desteklenmeyen kargo: " + account.provider);
  const order: any = mo ? mpOrderShape(mo) : (await db.from("store_orders").select("*").eq("id", sh.store_order_id).maybeSingle()).data;
  if (!order) throw new Error("Sipariş bulunamadı");
  if (order.status === "cancelled") { await db.from("shipments").update({ status: "cancelled" }).eq("id", sh.id); return { cancelled: true }; }
  const { data: product } = await db.from("products").select("name, weight_kg").eq("id", order.product_id).maybeSingle();
  const kg = Math.max(0.5, Number(product?.weight_kg || 1) * (order.quantity || 1));
  const sender = account.settings?.sender || {};
  const c = await creds(account.id);
  const ctx: Ctx = { shipment: sh, account, creds: c, order, product, sender, parcel: { desi: Math.max(1, Math.ceil(kg)), kg: Math.round(kg * 10) / 10, count: order.quantity || 1 } };
  const r: Created = await provider.create(ctx);

  // Etiket: sağlayıcınınki yoksa barkodlu kendi etiketimiz
  const pdf = r.labelPdf || await makeLabelPdf({
    barcode: r.ref, carrier: r.carrier || CARRIER_NAMES[account.provider] || account.provider, orderNo: String(order.id).slice(0, 8),
    senderName: sender.name || "", senderAddr: [sender.address, sender.district, sender.city].filter(Boolean).join(", "), senderPhone: sender.phone || "",
    recvName: order.customer_name, recvAddr: [order.customer_address, order.customer_district, order.customer_city, order.customer_zip].filter(Boolean).join(", "),
    recvPhone: order.customer_phone, product: product?.name || "", qty: order.quantity || 1, test: account.mode === "test",
  });
  const path = await saveLabel(sh, pdf);

  await db.from("shipments").update({
    status: "created", provider_ref: r.ref, tracking_number: r.tracking || null, tracking_url: r.trackingUrl || null,
    carrier: r.carrier || CARRIER_NAMES[account.provider], label_path: path, cost: r.cost ?? null, currency: r.currency ?? null,
    raw: r.raw ?? null, last_error: null, next_attempt_at: new Date(Date.now() + 30 * 60000).toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", sh.id);
  // Siparişe ve müşteri takip sayfasına
  const patch: Record<string, unknown> = { tracking_carrier: r.carrier || CARRIER_NAMES[account.provider] };
  if (r.tracking) patch.tracking_number = r.tracking;
  if (mo) {
    // Pazaryeri siparişi: takip numarası gelince amazon-orders Amazon'a "gönderildi" bildirir
    if (r.tracking) await db.from("marketplace_orders").update({ tracking_number: r.tracking, carrier: patch.tracking_carrier }).eq("id", mo.id);
  } else {
    await db.from("store_orders").update(patch).eq("id", order.id);
    // Kendi gönderdiği sipariş: takip numarası çıkınca müşteriye WhatsApp (CJ / AliExpress akışıyla aynı şablon)
    if (r.tracking && !order.whatsapp_notified_at) await notifyWhatsApp(db, sh.user_id, { ...order, tracking_number: r.tracking }, r.tracking).catch(() => null);
  }
  return { created: true, ref: r.ref };
}

async function trackShipment(sh: any) {
  if (sh.provider === "amazon") { // Amazon etiketi: takip Amazon siparişinde
    await db.from("shipments").update({ next_attempt_at: new Date(Date.now() + 365 * 86400_000).toISOString() }).eq("id", sh.id);
    return { skipped: "amazon" };
  }
  const { data: account } = await db.from("shipping_accounts").select("*").eq("id", sh.account_id).maybeSingle();
  if (!account) return { skipped: "no_account" };
  const t: Tracked = await PROVIDERS[account.provider].track({ shipment: sh, account, creds: await creds(account.id) });
  const now = new Date().toISOString();
  const upd: Record<string, unknown> = { updated_at: now, next_attempt_at: new Date(Date.now() + TRACK_EVERY_MIN * 60000).toISOString(), raw: { ...(sh.raw || {}), lastTrack: t.raw ?? null } };
  if (t.tracking) upd.tracking_number = t.tracking;
  if (t.trackingUrl) upd.tracking_url = t.trackingUrl;
  if (t.carrier) upd.carrier = t.carrier;
  if (t.status !== "created") upd.status = t.status;
  await db.from("shipments").update(upd).eq("id", sh.id);
  if (sh.marketplace_order_id) {
    const { data: mo } = await db.from("marketplace_orders").select("id, status, tracking_number, shipped_at, delivered_at").eq("id", sh.marketplace_order_id).maybeSingle();
    if (mo) {
      const p: Record<string, unknown> = {};
      if (t.tracking && t.tracking !== mo.tracking_number) p.tracking_number = t.tracking;
      if (t.carrier) p.carrier = t.carrier;
      if (t.status === "delivered" && !mo.delivered_at) { p.delivered_at = now; p.status = "delivered"; }
      if (Object.keys(p).length) await db.from("marketplace_orders").update(p).eq("id", mo.id);
    }
  }
  if (sh.store_order_id) {
    const { data: so } = await db.from("store_orders").select("id, status, shipped_at, delivered_at, tracking_number").eq("id", sh.store_order_id).maybeSingle();
    if (so) {
      const p: Record<string, unknown> = {};
      if (t.tracking && t.tracking !== so.tracking_number) p.tracking_number = t.tracking;
      if (t.carrier) p.tracking_carrier = t.carrier;
      if ((t.status === "shipped" || t.status === "delivered") && !so.shipped_at) { p.shipped_at = now; p.status = "shipped"; }
      if (t.status === "delivered" && !so.delivered_at) { p.delivered_at = now; p.status = "delivered"; }
      if (Object.keys(p).length) await db.from("store_orders").update(p).eq("id", so.id);
      const num = t.tracking || so.tracking_number;
      if (num && t.status !== "cancelled") {
        const { data: full } = await db.from("store_orders").select("*").eq("id", so.id).maybeSingle();
        if (full && !full.whatsapp_notified_at) await notifyWhatsApp(db, sh.user_id, full, num).catch(() => null);
      }
    }
  }
  return { status: t.status, tracking: t.tracking || null };
}

async function runQueue(onlyId?: string) {
  const started = Date.now();
  const results: unknown[] = [];
  let q = db.from("shipments").select("*").in("status", ["pending", "created", "shipped"]).lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true }).limit(20);
  if (onlyId) q = db.from("shipments").select("*").eq("id", onlyId).limit(1);
  const { data: list, error } = await q;
  if (error) throw error;
  for (const sh of list || []) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      if (sh.status === "pending") results.push({ id: sh.id, ...(await createShipment(sh)) });
      else results.push({ id: sh.id, ...(await trackShipment(sh)) });
    } catch (e) {
      const msg = short((e as Error).message);
      const attempts = (sh.attempts || 0) + 1;
      await db.from("shipments").update({
        attempts, last_error: msg, updated_at: new Date().toISOString(),
        ...(sh.status === "pending" && attempts >= MAX_ATTEMPTS ? { status: "error" } : {}),
        next_attempt_at: new Date(Date.now() + Math.min(240, 15 * attempts) * 60000).toISOString(),
      }).eq("id", sh.id);
      results.push({ id: sh.id, error: msg });
    }
  }
  return results;
}

// ---------------- İstek ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  try {
    // Sistem
    if (CRON_SECRET && String(body?.cronSecret || "").trim() === CRON_SECRET.trim()) {
      if (body?.action === "connect" && body?.userId) return json(await connect(String(body.userId), body));
      if (body?.action === "create" && body?.userId && body?.marketplaceOrderId) return json(await enqueueMp(String(body.userId), String(body.marketplaceOrderId), body?.accountId));
      if (body?.action === "create" && body?.userId && body?.storeOrderId) return json(await enqueue(String(body.userId), String(body.storeOrderId), body?.accountId));
      const results = await runQueue(body?.shipmentId ? String(body.shipmentId) : undefined);
      const reverified = body?.shipmentId ? [] : await reverifyPending();
      return json({ ok: true, processed: results.length, results, reverified });
    }
    // Satıcı
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const { data: u } = bearer.split(".").length === 3 ? await db.auth.getUser(bearer) : { data: { user: null } };
    const userId = u?.user?.id;
    if (!userId) return json({ error: "Bu işlem için giriş yapmalısın. / Please log in." }, 401);

    if (body?.action === "connect") return json(await connect(userId, body));
    if (body?.action === "disconnect") {
      const { error } = await db.from("shipping_accounts").delete().eq("id", String(body.accountId || "")).eq("user_id", userId);
      if (error) throw error;
      return json({ ok: true });
    }
    if (body?.action === "create" && body?.marketplaceOrderId) return json(await enqueueMp(userId, String(body.marketplaceOrderId), body?.accountId));
    if (body?.action === "create") return json(await enqueue(userId, String(body.storeOrderId || ""), body?.accountId));
    if (body?.action === "default") {
      const id = String(body.accountId || "");
      const { data: a } = await db.from("shipping_accounts").select("id").eq("id", id).eq("user_id", userId).maybeSingle();
      if (!a) return json({ error: "Kargo hesabı bulunamadı" }, 404);
      await db.from("shipping_accounts").update({ is_default: false }).eq("user_id", userId).neq("id", id);
      await db.from("shipping_accounts").update({ is_default: true }).eq("id", id);
      return json({ ok: true });
    }
    if (body?.action === "labels") return json(await mergedLabels(userId));
    if (body?.action === "label") {
      const { data: sh } = await db.from("shipments").select("label_path").eq("id", String(body.shipmentId || "")).eq("user_id", userId).maybeSingle();
      if (!sh?.label_path) return json({ error: "Etiket henüz hazır değil" }, 404);
      const { data: s } = await db.storage.from("shipping-labels").createSignedUrl(sh.label_path, 3600);
      return json({ ok: true, url: s?.signedUrl });
    }
    return json({ error: "Geçersiz işlem" }, 400);
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});

// Kargo hesabı bağla (bilgiler doğrulanır, kasaya konur)
async function connect(userId: string, b: any) {
  const provider = String(b.provider || "");
  if (!PROVIDERS[provider]) return { ok: false, error: "Desteklenmeyen kargo firması" };
  const mode = b.mode === "test" ? "test" : "live";
  const c = b.credentials && typeof b.credentials === "object" ? b.credentials : {};
  // Kargo sunucusuna ulaşılamazsa (yavaş test sunucusu vb.) hesap kaydedilir, doğrulama arka planda tekrar denenir (10 dk'lık görev)
  let verifyPending = false;
  try { await PROVIDERS[provider].verify(mode, c); } catch (e) {
    const msg = short((e as Error).message);
    if (!isNetworkError(msg)) return { ok: false, error: msg };
    verifyPending = true;
  }
  const settings: Record<string, unknown> = { sender: b.settings?.sender || {}, ...(verifyPending ? { verify_pending: true } : {}) };
  const { data: acc, error } = await db.from("shipping_accounts").upsert({
    user_id: userId, provider, mode, account_name: b.accountName || CARRIER_NAMES[provider], settings,
    status: "connected", last_error: null, updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,provider,mode" }).select("id").single();
  if (error) throw error;
  const { error: vErr } = await db.rpc("shipping_account_set_credentials", { p_account_id: acc.id, p_credentials: c });
  if (vErr) throw vErr;
  if (b.makeDefault !== false) {
    await db.from("shipping_accounts").update({ is_default: false }).eq("user_id", userId).neq("id", acc.id);
    await db.from("shipping_accounts").update({ is_default: true }).eq("id", acc.id);
  }
  return { ok: true, accountId: acc.id, ...(verifyPending ? { verifyPending: true, note: "Kargo sunucusu şu an yanıt vermiyor; bilgilerin kaydedildi, doğrulama arka planda tekrar denenecek." } : {}) };
}

function isNetworkError(msg: string): boolean {
  return /bağlanılamadı|timed out|timeout|ECONN|network|fetch failed|HTTP 5\d\d/i.test(msg);
}

// Doğrulaması bekleyen kargo hesapları: tekrar dene; bilgi yanlışsa hesap hataya düşer + satıcıya uyarı
async function reverifyPending() {
  const { data: accs } = await db.from("shipping_accounts").select("id, user_id, provider, mode, settings").eq("status", "connected").eq("settings->>verify_pending", "true").limit(10);
  const out: unknown[] = [];
  for (const a of accs || []) {
    try {
      await PROVIDERS[a.provider].verify(a.mode, await creds(a.id));
      const { verify_pending: _v, ...rest } = a.settings || {};
      await db.from("shipping_accounts").update({ settings: rest, last_error: null, updated_at: new Date().toISOString() }).eq("id", a.id);
      out.push({ id: a.id, verified: true });
    } catch (e) {
      const msg = short((e as Error).message);
      if (isNetworkError(msg)) { out.push({ id: a.id, pending: true }); continue; }
      await db.from("shipping_accounts").update({ status: "error", last_error: msg, updated_at: new Date().toISOString() }).eq("id", a.id);
      await db.rpc("assistant_enqueue", { p_user: a.user_id, p_kind: "connection", p_payload: { name: CARRIER_NAMES[a.provider] || a.provider }, p_dedupe: "ship:" + a.id });
      out.push({ id: a.id, error: msg });
    }
  }
  return out;
}

// Siparişe gönderi aç ve hemen oluştur
async function enqueue(userId: string, storeOrderId: string, accountId?: string) {
  const { data: so } = await db.from("store_orders").select("id").eq("id", storeOrderId).eq("user_id", userId).maybeSingle();
  if (!so) return { ok: false, error: "Sipariş bulunamadı" };
  let acc = accountId ? String(accountId) : "";
  if (!acc) {
    const { data: d } = await db.from("shipping_accounts").select("id").eq("user_id", userId).eq("is_default", true).maybeSingle();
    acc = d?.id || "";
  }
  if (!acc) return { ok: false, error: "Kargo hesabı bağlı değil" };
  const { data: a } = await db.from("shipping_accounts").select("id, provider, mode").eq("id", acc).eq("user_id", userId).maybeSingle();
  if (!a) return { ok: false, error: "Kargo hesabı bulunamadı" };
  let { data: sh } = await db.from("shipments").select("*").eq("store_order_id", storeOrderId).neq("status", "cancelled").maybeSingle();
  if (sh?.status === "error") {
    await db.from("shipments").update({ status: "pending", attempts: 0, last_error: null, account_id: a.id, provider: a.provider, test: a.mode === "test" }).eq("id", sh.id);
    sh = { ...sh, status: "pending", attempts: 0, account_id: a.id, provider: a.provider };
  }
  if (!sh) {
    const ins = await db.from("shipments").insert({ user_id: userId, store_order_id: storeOrderId, account_id: a.id, provider: a.provider, test: a.mode === "test" }).select("*").single();
    if (ins.error) throw ins.error;
    sh = ins.data;
  }
  const results = await runQueue(sh.id);
  return { ok: true, shipmentId: sh.id, result: results[0] ?? null };
}

// Pazaryeri siparişine gönderi aç (kargo hesabı yoksa Amazon pazarında Amazon etiketi) ve hemen oluştur
async function enqueueMp(userId: string, moId: string, accountId?: string) {
  const { data: mo } = await db.from("marketplace_orders").select("id, marketplace_code").eq("id", moId).eq("user_id", userId).maybeSingle();
  if (!mo) return { ok: false, error: "Sipariş bulunamadı" };
  let acc = accountId ? String(accountId) : "";
  if (!acc) {
    const { data: d } = await db.from("shipping_accounts").select("id").eq("user_id", userId).eq("is_default", true).maybeSingle();
    acc = d?.id || "";
  }
  const { data: a } = acc ? await db.from("shipping_accounts").select("id, provider, mode").eq("id", acc).eq("user_id", userId).maybeSingle() : { data: null };
  if (!a && !String(mo.marketplace_code).startsWith("amazon_")) return { ok: false, error: "Kargo hesabı bağlı değil" };
  let { data: sh } = await db.from("shipments").select("*").eq("marketplace_order_id", moId).neq("status", "cancelled").maybeSingle();
  if (sh?.status === "error") {
    await db.from("shipments").update({ status: "pending", attempts: 0, last_error: null }).eq("id", sh.id);
    sh = { ...sh, status: "pending", attempts: 0 };
  }
  if (!sh) {
    const ins = await db.from("shipments").insert({ user_id: userId, marketplace_order_id: moId, account_id: a?.id || null, provider: a?.provider || "amazon", test: a ? a.mode === "test" : false }).select("*").single();
    if (ins.error) throw ins.error;
    sh = ins.data;
  }
  const results = await runQueue(sh.id);
  return { ok: true, shipmentId: sh.id, result: results[0] ?? null };
}

// Henüz kargoya teslim edilmemiş gönderilerin etiketleri tek PDF'te (yazıcıya tek seferde)
async function mergedLabels(userId: string) {
  const { data: shs } = await db.from("shipments").select("id, label_path").eq("user_id", userId).eq("status", "created").not("label_path", "is", null).order("created_at").limit(200);
  if (!shs?.length) return { ok: false, error: "Bekleyen etiket yok" };
  const { PDFDocument } = await import("npm:pdf-lib@1.17.1");
  const merged = await PDFDocument.create();
  for (const s of shs) {
    const { data: f } = await db.storage.from("shipping-labels").download(s.label_path);
    if (!f) continue;
    try {
      const src = await PDFDocument.load(new Uint8Array(await f.arrayBuffer()));
      (await merged.copyPages(src, src.getPageIndices())).forEach((pg: any) => merged.addPage(pg));
    } catch (_) { /* bozuk dosya atlanır */ }
  }
  if (!merged.getPageCount()) return { ok: false, error: "Etiket dosyaları okunamadı" };
  const path = `${userId}/toplu-${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
  const up = await db.storage.from("shipping-labels").upload(path, await merged.save(), { contentType: "application/pdf", upsert: true });
  if (up.error) return { ok: false, error: up.error.message };
  const { data: signed } = await db.storage.from("shipping-labels").createSignedUrl(path, 3600);
  return { ok: true, url: signed?.signedUrl, count: merged.getPageCount() };
}

export { trendyolLabel }; // pazaryeri siparişleri akışı (Trendyol canlı bağlantısı gelince) için
