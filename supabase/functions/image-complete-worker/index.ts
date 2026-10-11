// =========================================================
// Seltigo - image-complete-worker (görsel tamamlama, arka planda)
// Toplu Ürün Yükleme görseli / özelliği eksik ürünler için image_jobs açar; bu görev 2 dakikada bir işler.
// Satıcı beklemez; bir yükleme partisi (image_job_batches) bitince panelde bildirim çıkar.
// Sıra (rastgele / telifli görsel alınmaz; her görselin kaynağı kaydedilir):
//   1) markanın resmi sitesi: basın / medya kiti -> ürün sayfası (görsel + teknik özellik + açıklama)
//   2) toptancının sitesi (dosyada yazan web adresi)
//   3) CJ / AliExpress eşleşmesi (sıkı ad benzerliği)
//   4) bulunamazsa ürün "Görsel eksik" (products.image_missing)
// Çağıranlar: zamanlanmış görev (CRON_SECRET), sistem denemesi { cronSecret, jobId }.
// =========================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const PARALLEL = 2;              // aynı anda işlenen ürün (her biri internet aramasıyla 30-90 sn)
const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 10;        // yarıda kalan (zaman aşımı) işler tekrar kuyruğa
const BRAND_SITE_DAYS = 30;

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const short = (v: unknown, n = 200) => String(v ?? "").slice(0, n);

async function lookup(userId: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/product-lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ ...payload, cronSecret: CRON_SECRET, userId, language: "tr" }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.error) throw new Error(short(d?.error || `HTTP ${r.status}`));
  return d;
}

// Markanın resmi sitesi (ortak önbellekle)
async function brandSite(userId: string, brand: string, sample: { code: string; name: string }): Promise<string> {
  const key = brand.trim().toLocaleLowerCase("tr");
  if (!key) return "";
  const { data: c } = await db.from("brand_sites").select("site, checked_at").eq("brand_key", key).maybeSingle();
  if (c && Date.now() - new Date(c.checked_at).getTime() < BRAND_SITE_DAYS * 86400000) return c.site || "";
  let site = "";
  try { site = String((await lookup(userId, { action: "site", brand, samples: [sample] })).site || ""); } catch (_) { site = ""; }
  await db.from("brand_sites").upsert({ brand_key: key, site: site || null, checked_at: new Date().toISOString() });
  return site;
}

async function processJob(job: any) {
  const { data: p } = await db.from("products")
    .select("id, user_id, name, generated_title, model_code, brand, image_url, specs, generated_description, deleted_at")
    .eq("id", job.product_id).maybeSingle();
  if (!p || p.deleted_at) return { kind: "skipped" };
  const { count: imgCount } = await db.from("product_images").select("id", { count: "exact", head: true })
    .eq("product_id", p.id).is("deleted_at", null);
  let needImg = !p.image_url && !imgCount;
  const needSpecs = !(Array.isArray(p.specs) && p.specs.length);
  const needDesc = !String(p.generated_description || "").trim();
  if (!needImg && !needSpecs) return { kind: "has_image" };

  const { data: rules } = await db.from("import_rules").select("rules").eq("user_id", p.user_id).maybeSingle();
  const r = rules?.rules || {};
  const brand = String(p.brand || r.brand || "").trim();
  const name = String(p.name || p.generated_title || "");
  const code = String(p.model_code || "");
  let images: string[] = [], kind = "", srcUrl = "";
  const patch: Record<string, unknown> = {};

  // 1) Markanın resmi sitesi
  const bSite = brand ? await brandSite(p.user_id, brand, { code, name }) : String(r.site || "");
  if (bSite) {
    if (needImg) {
      try {
        const m = await lookup(p.user_id, { action: "media", site: bSite, brand, code, name });
        if (m.found && m.images?.length) { images = m.images; kind = "brand_media_kit"; srcUrl = m.url; needImg = false; }
      } catch (_) { /* sonraki adım */ }
    }
    let f: any = null;
    try { f = await lookup(p.user_id, { action: "find", site: bSite, brand, code, name }); } catch (_) { f = null; }
    if (!(f?.found) && needImg) {
      // İnternet araması değişken sonuç verebiliyor: bir kez daha
      try { f = await lookup(p.user_id, { action: "find", site: bSite, brand, code, name, skipSiteSearch: true }); } catch (_) { f = null; }
    }
    if (f?.found && f.item) {
      if (needImg && f.item.images?.length) { images = f.item.images; kind = "brand_site"; srcUrl = f.url; needImg = false; }
      if (needSpecs && f.item.specs?.length) patch.specs = f.item.specs.slice(0, 80);
      if (needDesc && f.item.description) patch.generated_description = String(f.item.description).slice(0, 8000);
      if (!p.brand && f.item.brand) patch.brand = String(f.item.brand).slice(0, 80);
    }
  }
  // 2) Toptancının sitesi
  if (needImg && job.wholesaler_site && job.wholesaler_site !== bSite) {
    try {
      const w = await lookup(p.user_id, { action: "find", site: job.wholesaler_site, brand, code, name });
      if (w.found && w.item?.images?.length) {
        images = w.item.images; kind = "wholesaler"; srcUrl = w.url; needImg = false;
        if (needSpecs && !patch.specs && w.item.specs?.length) patch.specs = w.item.specs.slice(0, 80);
        if (needDesc && !patch.generated_description && w.item.description) patch.generated_description = String(w.item.description).slice(0, 8000);
      }
    } catch (_) { /* sonraki adım */ }
  }
  // 3) CJ / AliExpress
  if (needImg) {
    try {
      const mk = await lookup(p.user_id, { action: "market", brand, code, name });
      if (mk.found && mk.images?.length) { images = mk.images; kind = mk.kind; srcUrl = mk.url; needImg = false; }
    } catch (_) { /* bulunamadı */ }
  }

  // Kaydet
  if (images.length) {
    const rows = images.slice(0, 12).map((url, i) => ({
      product_id: p.id, user_id: p.user_id, url, position: (imgCount || 0) + i, source: "supplier",
      source_kind: kind, source_url: srcUrl || null,
    }));
    const { error } = await db.from("product_images").insert(rows);
    if (error) throw new Error("Görsel kaydı: " + error.message);
    if (!p.image_url) patch.image_url = images[0];
    patch.image_missing = false;
  } else if (!p.image_url && !imgCount) {
    patch.image_missing = true;
  }
  if (Object.keys(patch).length) {
    const { error } = await db.from("products").update(patch).eq("id", p.id);
    if (error) throw new Error("Ürün kaydı: " + error.message);
  }
  return { kind: images.length ? kind : (patch.image_missing ? "missing" : "specs_only") };
}

async function finishJob(job: any, kind: string) {
  await db.from("image_jobs").update({ status: "done", result_kind: kind, finished_at: new Date().toISOString() }).eq("id", job.id);
  await refreshBatch(job.batch_id);
}
async function refreshBatch(batchId: string) {
  const { data: jobs } = await db.from("image_jobs").select("status, result_kind").eq("batch_id", batchId);
  const list = jobs || [];
  const open = list.filter((j) => j.status === "pending" || j.status === "running").length;
  const found = list.filter((j) => j.status === "done" && !["missing", "skipped", "has_image", "specs_only"].includes(j.result_kind || "")).length;
  const missing = list.filter((j) => (j.status === "done" && j.result_kind === "missing") || j.status === "failed").length;
  await db.from("image_job_batches").update({
    found, missing, ...(open ? {} : { status: "done", finished_at: new Date().toISOString() }),
  }).eq("id", batchId);
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  if (!CRON_SECRET || String(body?.cronSecret || "").trim() !== CRON_SECRET.trim()) return json({ error: "unauthorized" }, 401);
  const started = Date.now();
  try {
    // Yarıda kalan işler kuyruğa döner
    const stale = new Date(Date.now() - STALE_MINUTES * 60000).toISOString();
    await db.from("image_jobs").update({ status: "pending" }).eq("status", "running").lt("started_at", stale);

    let q = db.from("image_jobs").select("*").eq("status", "pending").lte("next_attempt_at", new Date().toISOString())
      .order("created_at", { ascending: true }).limit(PARALLEL);
    if (body?.jobId) q = db.from("image_jobs").select("*").eq("id", Number(body.jobId)).limit(1);
    const { data: jobs, error } = await q;
    if (error) throw error;

    const results = await Promise.all((jobs || []).map(async (job: any) => {
      // Sahiplen (aynı işi iki görev almasın)
      const { data: claimed } = await db.from("image_jobs")
        .update({ status: "running", started_at: new Date().toISOString(), attempts: (job.attempts || 0) + 1 })
        .eq("id", job.id).in("status", ["pending"]).select("id");
      if (!claimed?.length && !body?.jobId) return { id: job.id, skipped: true };
      try {
        const r = await processJob(job);
        await finishJob(job, r.kind);
        return { id: job.id, kind: r.kind };
      } catch (e) {
        const msg = short((e as Error).message);
        const last = (job.attempts || 0) + 1 >= MAX_ATTEMPTS;
        await db.from("image_jobs").update(last
          ? { status: "failed", error: msg, finished_at: new Date().toISOString() }
          : { status: "pending", error: msg, next_attempt_at: new Date(Date.now() + 10 * 60000).toISOString() }).eq("id", job.id);
        if (last) await refreshBatch(job.batch_id);
        return { id: job.id, error: msg };
      }
    }));
    return json({ ok: true, processed: results.length, results, ms: Date.now() - started });
  } catch (e) {
    return json({ ok: false, error: short((e as Error).message) }, 500);
  }
});
