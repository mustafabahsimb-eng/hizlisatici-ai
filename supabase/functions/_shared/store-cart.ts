// =========================================================
// Seltigo mağaza sepeti: fiyat HER ZAMAN sunucuda (Kendi Mağazam ilanı), seçenek fiyatı create-store-order ile aynı hesap,
// kupon (yüzde / tutar / ücretsiz kargo; tarih, en az tutar, kullanım sınırı), kargo seçeneği (ücretsiz kargo sınırı),
// kapıda ödeme ücreti. store-checkout kullanır.
// =========================================================
export type CartLine = { product_id: number; listing_id: string; variant_id: string | null; name: string; variant_label: string | null; qty: number; unit_price: number; image: string | null };
export type Quote = {
  ok: boolean; error?: string; lines: CartLine[]; currency: string; subtotal: number; discount: number; shipping: number; cod_fee: number; total: number;
  coupon: { id: string; code: string; kind: string } | null; coupon_error?: string; shipping_option: any; shipping_options: any[]; methods: string[];
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const OPTION_NAMES_TR: Record<string, string> = { size: "Beden", color: "Renk", colour: "Renk", material: "Malzeme", style: "Model", pattern: "Desen" };

export const DEFAULT_SHIPPING = [{ id: "standart", name: "Standart kargo", price: 0, free_over: null, days: "2-4 iş günü" }];

export function storeMethods(store: any, providers: { provider: string; enabled: boolean }[], paymentsOn: boolean): string[] {
  const conf = store.checkout || {};
  const want: string[] = Array.isArray(conf.methods) && conf.methods.length ? conf.methods : ["cod"];
  return want.filter((m) => {
    if (m === "cod") return true;
    if (m === "bank_transfer") return !!conf.iban;
    if (m === "iyzico" || m === "paytr") return paymentsOn && providers.some((p) => p.provider === m && p.enabled);
    return false;
  });
}

export async function quote(db: any, store: any, body: any, opts: { methods: string[] }): Promise<Quote> {
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 50);
  const shippingOptions = Array.isArray(store.shipping_options) && store.shipping_options.length ? store.shipping_options : DEFAULT_SHIPPING;
  const empty: Quote = { ok: false, lines: [], currency: "TRY", subtotal: 0, discount: 0, shipping: 0, cod_fee: 0, total: 0, coupon: null, shipping_option: null, shipping_options: shippingOptions, methods: opts.methods };
  if (!items.length) return { ...empty, error: "Sepet boş" };
  const pids = [...new Set(items.map((i: any) => Number(i.product_id)).filter((n: number) => n > 0))];
  const [{ data: listings }, { data: prods }, { data: vars }] = await Promise.all([
    db.from("listings").select("id, product_id, price, currency, title").eq("user_id", store.user_id).eq("marketplace_code", "own_store").eq("status", "published").is("deleted_at", null).in("product_id", pids),
    db.from("products").select("id, name, generated_title, image_url, stock_status, stock_qty, deleted_at, merged_into, store_visible, supplier_price").eq("user_id", store.user_id).in("id", pids),
    db.from("product_variants").select("id, product_id, attributes, cost, stock_qty, stock_status, image_url").in("product_id", pids).eq("is_default", false).eq("is_active", true).is("deleted_at", null),
  ]);
  const lines: CartLine[] = [];
  for (const it of items) {
    const pid = Number(it.product_id);
    const l = (listings || []).find((x: any) => x.product_id === pid);
    const p = (prods || []).find((x: any) => x.id === pid);
    if (!l || !p || p.deleted_at || p.merged_into || p.store_visible === false || p.stock_status === "tukendi") return { ...empty, error: `Ürün satışta değil (${pid})` };
    const options = (vars || []).filter((v: any) => v.product_id === pid && v.attributes && Object.keys(v.attributes).length);
    let v: any = null;
    if (options.length) {
      v = options.find((x: any) => x.id === String(it.variant_id || ""));
      if (!v) return { ...empty, error: `Seçenek seçilmedi: ${l.title || p.name}` };
      if (v.stock_status === "tukendi" || (v.stock_qty != null && Number(v.stock_qty) <= 0)) return { ...empty, error: `Seçenek tükendi: ${l.title || p.name}` };
    }
    const qty = Math.min(99, Math.max(1, Math.floor(Number(it.qty) || 1)));
    const stockLeft = v ? v.stock_qty : p.stock_qty;
    if (stockLeft != null && Number(stockLeft) < qty) return { ...empty, error: `Stokta ${stockLeft} adet var: ${l.title || p.name}` };
    let price = Number(l.price);
    const pc = Number(p.supplier_price), vc = Number(v?.cost);
    if (v && price > 0 && pc > 0 && vc > 0) price = r2(price * (vc / pc));
    if (!(price > 0)) return { ...empty, error: `Fiyatı olmayan ürün: ${l.title || p.name}` };
    lines.push({
      product_id: pid, listing_id: l.id, variant_id: v?.id || null, name: l.title || p.generated_title || p.name, qty, unit_price: price, image: v?.image_url || p.image_url || null,
      variant_label: v ? Object.entries(v.attributes).map(([k, x]) => `${OPTION_NAMES_TR[k.toLowerCase()] || k}: ${x}`).join(" · ").slice(0, 200) : null,
    });
  }
  const currency = (listings || [])[0]?.currency || "TRY";
  const subtotal = r2(lines.reduce((s, x) => s + x.unit_price * x.qty, 0));
  // Kargo
  const so = shippingOptions.find((s: any) => s.id === body.shipping_option) || shippingOptions[0];
  let shipping = so ? (so.free_over && subtotal >= Number(so.free_over) ? 0 : Number(so.price) || 0) : 0;
  // Kupon
  let discount = 0, coupon: Quote["coupon"] = null, coupon_error: string | undefined;
  const code = String(body.coupon || "").trim().toUpperCase();
  if (code) {
    const { data: cp } = await db.from("store_coupons").select("*").eq("user_id", store.user_id).ilike("code", code).maybeSingle();
    const nowT = Date.now();
    if (!cp || !cp.active) coupon_error = "Kupon geçersiz";
    else if (cp.starts_at && new Date(cp.starts_at).getTime() > nowT) coupon_error = "Kupon henüz başlamadı";
    else if (cp.ends_at && new Date(cp.ends_at).getTime() < nowT) coupon_error = "Kuponun süresi doldu";
    else if (cp.max_uses != null && cp.used_count >= cp.max_uses) coupon_error = "Kupon kullanım sınırı doldu";
    else if (subtotal < Number(cp.min_total || 0)) coupon_error = `Kupon en az ${cp.min_total} ${currency} alışverişte geçerli`;
    else {
      coupon = { id: cp.id, code: cp.code, kind: cp.kind };
      if (cp.kind === "percent") discount = r2(subtotal * Math.min(100, Number(cp.value)) / 100);
      else if (cp.kind === "amount") discount = Math.min(subtotal, r2(Number(cp.value)));
      else if (cp.kind === "free_shipping") shipping = 0;
    }
  }
  const method = opts.methods.includes(body.payment_method) ? body.payment_method : opts.methods[0];
  const cod_fee = method === "cod" ? r2(Number(store.checkout?.cod_fee) || 0) : 0;
  const total = r2(Math.max(0, subtotal - discount) + shipping + cod_fee);
  return { ok: true, lines, currency, subtotal, discount, shipping: r2(shipping), cod_fee, total, coupon, coupon_error, shipping_option: so || null, shipping_options: shippingOptions, methods: opts.methods };
}
