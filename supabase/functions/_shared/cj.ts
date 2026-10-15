// =========================================================
// CJ Dropshipping: paylaşılan giriş anahtarı (cj_tokens) + istek + anlaşmazlık (dispute) akışı
// getAccessToken saniyede 1 çağrı kabul eder; anahtar veritabanında paylaşılır (cj-order-worker ile aynı düzen).
// Anlaşmazlık: developers.cjdropshipping.com /api2.0/v1/disputes/ (disputeProducts -> disputeConfirmInfo -> create; getDisputeList)
// =========================================================
export const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";
const memo = new Map<string, string>();

export async function cjAccessToken(db: any, apiKey: string, f: typeof fetch = fetch): Promise<string | null> {
  if (!apiKey) return null;
  if (memo.has(apiKey)) return memo.get(apiKey)!;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const { data: row } = await db.from("cj_tokens").select("access_token, expires_at").eq("key_hash", hash).maybeSingle();
  if (row?.access_token && new Date(row.expires_at).getTime() > Date.now() + 86400000) { memo.set(apiKey, row.access_token); return row.access_token; }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await f(`${CJ_BASE}/authentication/getAccessToken`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }) });
      const d = await r.json().catch(() => ({}));
      const t = d?.data?.accessToken;
      if (t) {
        const exp = new Date(d.data.accessTokenExpiryDate || "");
        await db.from("cj_tokens").upsert({ key_hash: hash, access_token: t, expires_at: (isNaN(exp.getTime()) ? new Date(Date.now() + 14 * 86400000) : exp).toISOString(), updated_at: new Date().toISOString() });
        memo.set(apiKey, t);
        return t;
      }
    } catch (_) { /* tekrar */ }
    await new Promise((res) => setTimeout(res, 1100 * (i + 1)));
  }
  return null;
}

export async function cjKeyForUser(db: any, userId: string): Promise<string> {
  const { data } = await db.from("user_integrations").select("api_key").eq("user_id", userId).eq("platform", "cj").maybeSingle();
  return data?.api_key || Deno.env.get("CJ_API_KEY") || "";
}

export async function cjCall(token: string, path: string, init: RequestInit = {}, f: typeof fetch = fetch): Promise<any> {
  const r = await f(`${CJ_BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", "CJ-Access-Token": token, ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) });
  return await r.json().catch(() => ({ result: false, message: `HTTP ${r.status}` }));
}

// İade nedeni -> CJ anlaşmazlık nedeni (disputeConfirmInfo listesinden en uygunu)
export function pickDisputeReason(list: { disputeReasonId: number; reasonName: string }[], reasonCode: string) {
  const want: Record<string, RegExp> = {
    defective: /defect|quality|damag|broken|not work/i, damaged: /damag|broken|defect/i, wrong_item: /wrong|incorrect|different/i,
    not_as_described: /describ|different|quality/i, size: /size|wrong/i, late: /not received|late|delay/i,
  };
  const re = want[reasonCode];
  return (re && list.find((x) => re.test(x.reasonName))) || list.find((x) => /quality|defect/i.test(x.reasonName)) || list[0] || null;
}

// Kusurlu / yanlış ürün için CJ'den para iadesi (bakiyeye) talebi
export async function openCjDispute(token: string, p: { cjOrderId: string; businessId: string; reasonCode: string; message: string; imageUrls: string[]; quantity: number }, f: typeof fetch = fetch) {
  const prod = await cjCall(token, `/disputes/disputeProducts?orderId=${encodeURIComponent(p.cjOrderId)}`, {}, f);
  const items = (prod?.data?.productInfoList || []).filter((x: any) => x.canChoose !== false);
  if (!prod?.result || !items.length) return { ok: false, error: prod?.message || "Anlaşmazlık açılabilecek ürün yok" };
  const productInfoList = items.slice(0, 1).map((x: any) => ({ lineItemId: x.lineItemId, quantity: Math.min(p.quantity, Number(x.quantity) || 1), price: Number(x.price) || 0 }));
  const conf = await cjCall(token, "/disputes/disputeConfirmInfo", { method: "POST", body: JSON.stringify({ orderId: p.cjOrderId, productInfoList }) }, f);
  if (!conf?.result) return { ok: false, error: conf?.message || "Onay bilgisi alınamadı" };
  const reason = pickDisputeReason(conf.data?.disputeReasonList || [], p.reasonCode);
  if (!reason) return { ok: false, error: "Uygun anlaşmazlık nedeni yok" };
  const images: string[] = [];
  for (const u of p.imageUrls.slice(0, 5)) {
    const up = await cjCall(token, "/disputes/uploadFile", { method: "POST", body: JSON.stringify({ fileUrl: u }) }, f);
    if (up?.data?.url && up.data.fileType !== "VIDEO") images.push(up.data.url);
  }
  const body = { businessDisputeId: p.businessId.slice(0, 100), orderId: p.cjOrderId, disputeReasonId: reason.disputeReasonId, expectType: 1, refundType: 1,
    messageText: p.message.slice(0, 500), imageUrl: images, productInfoList };
  const cr = await cjCall(token, "/disputes/create", { method: "POST", body: JSON.stringify(body) }, f);
  if (!cr?.result) return { ok: false, error: cr?.message || "Anlaşmazlık açılamadı", request: body };
  return { ok: true, reason: reason.reasonName, maxAmount: conf.data?.maxAmount ?? null, request: body };
}
