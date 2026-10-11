// =========================================================
// Ürünleri diğer kanallara gönderme (ortak: "Link ver, mağazan hazır" ve Seltigo Asistan)
// Kanal kimlikleri: "mp:<store_connections.id>" (pazaryeri ilanı -> senkron kuyruğu), "ig:<social_channels.id>" (Instagram paylaşım kuyruğu), "wa" (WhatsApp / Meta kataloğu)
// Fiyat: Kendi Mağazam ilan fiyatı (TRY) pazaryeri para birimine çevrilir; pazaryeri kuralları ve prova adaptörde (sync-worker).
// =========================================================
const URL_ = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON = Deno.env.get("CRON_SECRET") ?? "";

export type Channels = { marketplaces: { id: string; code: string; label: string | null; test: boolean }[]; instagram: { id: string; name: string | null }[]; whatsappCatalog: boolean };

export async function connectedChannels(db: any, userId: string): Promise<Channels> {
  const { data: sc } = await db.from("store_connections").select("id, marketplace_code, label, environment").eq("user_id", userId).eq("status", "connected").is("deleted_at", null);
  const { data: ig } = await db.from("social_channels").select("id, account_name").eq("user_id", userId).eq("platform", "instagram").neq("active", false);
  const { data: mc } = await db.from("meta_catalogs").select("catalog_id").eq("user_id", userId).maybeSingle();
  return {
    marketplaces: (sc || []).filter((c: any) => c.marketplace_code !== "own_store").map((c: any) => ({ id: c.id, code: c.marketplace_code, label: c.label, test: c.environment === "sandbox" })),
    instagram: (ig || []).map((c: any) => ({ id: c.id, name: c.account_name })),
    whatsappCatalog: !!mc?.catalog_id,
  };
}

// Asistan ayarındaki "Varsayılan kanallar" (own_store, trendyol, hepsiburada, n11, amazon, instagram, whatsapp) -> bağlı kanal kimlikleri
export function channelIdsFromDefaults(ch: Channels, defaults: string[]): { ids: string[]; missing: string[] } {
  const ids: string[] = [], missing: string[] = [];
  for (const d of defaults || []) {
    if (d === "own_store") continue;
    if (d === "instagram") { if (ch.instagram.length) ids.push(...ch.instagram.map((c) => "ig:" + c.id)); else missing.push(d); continue; }
    if (d === "whatsapp") { if (ch.whatsappCatalog) ids.push("wa"); else missing.push(d); continue; }
    const match = ch.marketplaces.filter((m) => d === "amazon" ? m.code.startsWith("amazon_") : m.code === d + "_tr" || m.code === d);
    if (match.length) ids.push(...match.map((m) => "mp:" + m.id)); else missing.push(d);
  }
  return { ids, missing };
}

export async function distributeProducts(db: any, userId: string, productIds: number[], want: string[]) {
  const { data: mine } = await db.from("products").select("id").eq("user_id", userId).in("id", productIds).is("deleted_at", null);
  const ids: number[] = (mine || []).map((p: any) => Number(p.id));
  const out: Record<string, any> = {};
  if (!ids.length) return out;
  const ch = await connectedChannels(db, userId);
  const { data: own } = await db.from("listings").select("product_id, title, description, price, currency").eq("user_id", userId).eq("marketplace_code", "own_store").in("product_id", ids).is("deleted_at", null);
  const ownMap = new Map((own || []).map((l: any) => [Number(l.product_id), l]));
  // Kendi Mağazam'da ilanı olmayan ürün: ürün kaydındaki ad / açıklama / satış fiyatı (TRY'ye çevrilir)
  const noOwn = ids.filter((id) => !ownMap.has(id));
  if (noOwn.length) {
    const { data: ps } = await db.from("products").select("id, name, generated_title, generated_description, sale_price, cost_currency").in("id", noOwn);
    for (const p of ps || []) {
      let price = Number(p.sale_price) || 0;
      if (p.cost_currency && p.cost_currency !== "TRY" && price) { const { data: k } = await db.rpc("fx_rate", { p_from: p.cost_currency, p_to: "TRY", p_date: null }); if (k) price = Math.round(price * Number(k) * 100) / 100; }
      if (price > 0) ownMap.set(Number(p.id), { product_id: p.id, title: p.generated_title || p.name, description: p.generated_description || "", price, currency: "TRY" });
    }
  }
  for (const m of ch.marketplaces.filter((m) => want.includes("mp:" + m.id))) {
    const { data: mk } = await db.from("marketplaces").select("currency, language, default_commission_pct").eq("code", m.code).maybeSingle();
    const cur = mk?.currency || "TRY";
    let fx = 1;
    if (cur !== "TRY") { const { data: r } = await db.rpc("fx_rate", { p_from: "TRY", p_to: cur, p_date: null }); fx = Number(r) || 0; }
    if (!(fx > 0)) { out[m.label || m.code] = { error: "kur yok" }; continue; }
    const { data: have } = await db.from("listings").select("product_id").eq("connection_id", m.id).in("product_id", ids).is("deleted_at", null);
    const skip = new Set((have || []).map((x: any) => Number(x.product_id)));
    const rows = ids.filter((pid) => !skip.has(pid)).map((pid) => ownMap.get(pid)).filter(Boolean).map((l: any) => ({
      user_id: userId, product_id: l.product_id, source_product_id: l.product_id, connection_id: m.id, marketplace_code: m.code,
      language: mk?.language || "tr", currency: cur, title: l.title, description: l.description,
      price: Math.round(Number(l.price) * fx * 100) / 100, commission_pct: mk?.default_commission_pct ?? null,
      price_mode: "manual", status: "published", published_at: new Date().toISOString(),
    }));
    let n = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const { data, error } = await db.from("listings").insert(rows.slice(i, i + 100)).select("id");
      if (error) throw new Error(m.code + ": " + error.message);
      n += (data || []).length;
    }
    out[m.label || m.code] = { listings: n, existing: skip.size, test: m.test };
  }
  // Instagram: paylaşım kuyruğu, 30 dk arayla (Meta günlük sınırı ve takipçiyi boğmamak için); sırada olanların arkasına eklenir
  for (const c of ch.instagram.filter((c) => want.includes("ig:" + c.id))) {
    const { data: last } = await db.from("social_posts").select("scheduled_at").eq("channel_id", c.id).eq("status", "pending").order("scheduled_at", { ascending: false }).limit(1).maybeSingle();
    const start = Math.max(Date.now(), last?.scheduled_at ? new Date(last.scheduled_at).getTime() + 30 * 60_000 : 0);
    const rows = ids.slice(0, 48).map((pid, i) => ({ user_id: userId, product_id: pid, channel_id: c.id, platform: "instagram", status: "pending", kind: "product",
      scheduled_at: new Date(start + i * 30 * 60_000).toISOString() }));
    const { error } = await db.from("social_posts").insert(rows);
    out["Instagram" + (c.name ? " @" + c.name : "")] = error ? { error: String(error.message).slice(0, 200) } : { queued: rows.length, note: ids.length > 48 ? "İlk 48 ürün; kalanlar sonraki günlerde" : undefined };
  }
  // WhatsApp / Meta kataloğu (social-catalog, sistem çağrısı)
  if (want.includes("wa") && ch.whatsappCatalog) {
    try {
      const r = await fetch(`${URL_}/functions/v1/social-catalog`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON },
        body: JSON.stringify({ action: "sync", productIds: ids, cronSecret: CRON, userId }), signal: AbortSignal.timeout(120000),
      });
      const d = await r.json().catch(() => ({}));
      out["WhatsApp kataloğu"] = d?.error ? { error: d.error } : { synced: d?.count ?? ids.length };
    } catch (e) { out["WhatsApp kataloğu"] = { error: String((e as Error).message).slice(0, 200) }; }
  }
  return out;
}
