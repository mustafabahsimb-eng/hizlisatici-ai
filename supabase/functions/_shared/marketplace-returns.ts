// =========================================================
// Pazaryeri iadeleri (talep listesi + onay)
//   Trendyol: GET /integration/order/sellers/{id}/claims (claimItemStatus), PUT .../claims/{claimId}/items/approve { claimLineItemIdList, params }
//             Kaynak: developers.trendyol.com getClaims / approveClaimLineItems (stage: stageapigw)
//   n11     : SOAP https://api.n11.com/ws/ReturnService.wsdl  ClaimReturnList / ClaimReturnApprove (developer.n11.com İade Talepleri Servisi)
// Onay = pazaryeri müşteriye parayı iade eder; ürün satıcıya geri döndükten sonra (Trendyol "WaitingInAction") yapılır.
// =========================================================
export type NormReturn = {
  externalId: string; claimRef: string; lineRefs: string[]; orderNo: string; status: "requested" | "received" | "refunded" | "rejected" | "cancelled";
  reasonCode: string; reasonText: string; quantity: number; amount: number | null; barcode?: string | null; sku?: string | null; productName?: string | null;
  customerName?: string | null; createdAt: string; raw?: unknown;
};
type Ctx = { env: "live" | "sandbox"; creds: any; since: Date; fetch?: typeof fetch };
const basic = (a: string, b: string) => "Basic " + btoa(`${a}:${b}`);
const iso = (v: unknown) => { const n = Number(v); const d = Number.isFinite(n) && n > 1e9 ? new Date(n) : new Date(String(v || "")); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); };

export function reasonOf(text: string): string {
  const t = String(text || "").toLowerCase();
  if (/beden|size|küçük|büyük|dar|bol/.test(t)) return "size";
  if (/kusur|defo|bozuk|çalışm|arıza|defect/.test(t)) return "defective";
  if (/hasar|kırık|ezik|yırt|damag|broken/.test(t)) return "damaged";
  if (/yanlış|farklı ürün|wrong/.test(t)) return "wrong_item";
  if (/açıklama|görsel|beklenti|describ|benzemiyor/.test(t)) return "not_as_described";
  if (/vazgeç|istemiyorum|fikrim|changed/.test(t)) return "changed_mind";
  if (/geç|late|gecik/.test(t)) return "late";
  return "other";
}

export const trendyolReturns = {
  host: (ctx: Ctx) => (ctx.env === "sandbox" ? "https://stageapigw.trendyol.com" : "https://apigw.trendyol.com"),
  async list(ctx: Ctx): Promise<NormReturn[]> {
    const { sellerId, apiKey, apiSecret } = ctx.creds;
    const f = ctx.fetch || fetch;
    const out: NormReturn[] = [];
    for (let page = 0; page < 30; page++) {
      const q = new URLSearchParams({ startDate: String(ctx.since.getTime()), endDate: String(Date.now()), page: String(page), size: "200" });
      const r = await f(`${this.host(ctx)}/integration/order/sellers/${encodeURIComponent(sellerId)}/claims?${q}`, {
        headers: { Authorization: basic(apiKey, apiSecret), "User-Agent": `${sellerId} - SelfIntegration` }, signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw Object.assign(new Error(`trendyol claims ${r.status}`), { status: r.status });
      const d = await r.json();
      for (const c of d?.content || []) {
        for (const it of c.items || []) {
          const cis: any[] = it.claimItems || [];
          if (!cis.length) continue;
          const st = String(cis[0]?.claimItemStatus?.name || "");
          const reasonText = [cis[0]?.customerClaimItemReason?.name, cis[0]?.customerNote].filter(Boolean).join(" — ");
          out.push({
            externalId: `${c.id || c.claimId}/${it.orderLine?.id}`, claimRef: String(c.id || c.claimId), lineRefs: cis.map((x) => String(x.id)), orderNo: String(c.orderNumber || ""),
            status: /accepted/i.test(st) ? "refunded" : /rejected/i.test(st) ? "rejected" : /cancel/i.test(st) ? "cancelled" : /waitinginaction/i.test(st) ? "received" : "requested",
            reasonCode: reasonOf(reasonText), reasonText, quantity: cis.length, amount: it.orderLine?.price != null ? Number(it.orderLine.price) * cis.length : null,
            barcode: it.orderLine?.barcode || null, sku: it.orderLine?.merchantSku || null, productName: it.orderLine?.productName || null,
            customerName: [c.customerFirstName, c.customerLastName].filter(Boolean).join(" ") || null, createdAt: iso(c.claimDate), raw: { claimId: c.id || c.claimId, status: st },
          });
        }
      }
      if (page + 1 >= Number(d?.totalPages || 1)) break;
    }
    return out;
  },
  async approve(ctx: Ctx, r: { claimRef: string; lineRefs: string[] }) {
    const { sellerId, apiKey, apiSecret } = ctx.creds;
    const f = ctx.fetch || fetch;
    const res = await f(`${this.host(ctx)}/integration/order/sellers/${encodeURIComponent(sellerId)}/claims/${encodeURIComponent(r.claimRef)}/items/approve`, {
      method: "PUT", headers: { Authorization: basic(apiKey, apiSecret), "User-Agent": `${sellerId} - SelfIntegration`, "Content-Type": "application/json" },
      body: JSON.stringify({ claimLineItemIdList: r.lineRefs, params: {} }), signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`trendyol approve ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};

const xmlEsc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tagAll = (xml: string, t: string) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${t}>([\\s\\S]*?)</(?:\\w+:)?${t}>`, "g"))].map((m) => m[1]);
const tag = (xml: string, t: string) => tagAll(xml, t)[0] ?? "";
const ddmmyyyy = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

export const n11Returns = {
  url: "https://api.n11.com/ws/ReturnService/",
  async soap(ctx: Ctx, op: string, inner: string) {
    const f = ctx.fetch || fetch;
    const body = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sch="http://www.n11.com/ws/schemas"><soapenv:Header/><soapenv:Body><sch:${op}Request>` +
      `<auth><appKey>${xmlEsc(ctx.creds.apiKey)}</appKey><appSecret>${xmlEsc(ctx.creds.apiSecret)}</appSecret></auth>${inner}</sch:${op}Request></soapenv:Body></soapenv:Envelope>`;
    const r = await f(this.url, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' }, body, signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    if (tag(text, "status") === "failure") throw new Error("n11 " + op + ": " + (tag(text, "errorMessage") || tag(text, "message")).slice(0, 200));
    return text;
  },
  async list(ctx: Ctx): Promise<NormReturn[]> {
    const out: NormReturn[] = [];
    for (const status of ["REQUESTED", "APPROVED", "DENIED"]) {
      for (let page = 0; page < 20; page++) {
        const xml = await this.soap(ctx, "ClaimReturnList", `<searchData><status>${status}</status><period><startDate>${ddmmyyyy(ctx.since)}</startDate><endDate>${ddmmyyyy(new Date())}</endDate></period></searchData><pagingData><currentPage>${page}</currentPage></pagingData>`);
        const items = tagAll(xml, "claimReturn");
        for (const c of items) {
          const st = tag(c, "status");
          const reasonText = [tag(c, "returnReasonType"), tag(c, "returnReasonDescription")].filter(Boolean).join(" — ");
          const qty = Number(tag(c, "quantity")) || 1;
          out.push({
            externalId: tag(c, "claimReturnId"), claimRef: tag(c, "claimReturnId"), lineRefs: [tag(c, "claimReturnId")], orderNo: tag(c, "orderNumber"),
            status: st === "APPROVED" || st === "MANUAL_REFUND" ? "refunded" : st === "DENIED" ? "rejected" : st === "CANCELLED" ? "cancelled" : "requested",
            reasonCode: reasonOf(reasonText), reasonText, quantity: qty, amount: Number(tag(c, "finalPrice") || tag(c, "unitPrice")) || null,
            productName: tag(c, "productName") || null, sku: null, barcode: null, customerName: tag(c, "buyerName") || null, createdAt: iso(tag(c, "requestDate")),
            raw: { claimReturnId: tag(c, "claimReturnId"), status: st, tracking: tag(c, "trackingNumber") },
          });
        }
        const pageCount = Number(tag(xml, "pageCount")) || 1;
        if (!items.length || page + 1 >= pageCount) break;
      }
    }
    return out;
  },
  async approve(ctx: Ctx, r: { claimRef: string }) {
    await this.soap(ctx, "ClaimReturnApprove", `<claimReturnId>${xmlEsc(r.claimRef)}</claimReturnId>`);
  },
};

export function returnsAdapterFor(code: string) {
  if (code === "trendyol_tr") return trendyolReturns;
  if (code === "n11_tr") return n11Returns;
  return null;
}
