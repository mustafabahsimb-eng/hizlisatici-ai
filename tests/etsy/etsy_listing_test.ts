// Etsy ilan gönderme — taklit (mock) testler. Etsy'nin test ortamı yok; istekler resmi OpenAPI tanımındaki yol ve alanlarla doğrulanır.
// Çalıştırma: deno test --allow-env --allow-net tests/etsy/etsy_listing_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";

Deno.env.set("ETSY_SHARED_SECRET", "abcde12345");
Deno.env.set("ETSY_KEYSTRING", "testkeystring123");
const E = await import("../../supabase/functions/_shared/etsy.ts");
const L = await import("../../supabase/functions/_shared/etsy-listing.ts");

type Call = { method: string; path: string; headers: Headers; form: URLSearchParams | null; multipart: FormData | null; json: any };
let calls: Call[] = [];
let nextId = 1000;
let fail429 = 0;
const listings: Record<string, any> = {};
const real = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method || "GET").toUpperCase();
  const b = init?.body;
  const c: Call = { method, path: url.pathname, headers: new Headers(init?.headers), form: typeof b === "string" && !b.startsWith("{") ? new URLSearchParams(b) : null,
    multipart: b instanceof FormData ? b : null, json: typeof b === "string" && b.startsWith("{") ? JSON.parse(b) : null };
  calls.push(c);
  const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
  if (url.hostname === "img.test") return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } });
  if (fail429 > 0) { fail429--; return j({ error: "Too many requests" }, 429); }
  const p = url.pathname.replace("/v3/application", "");
  if (p === "/seller-taxonomy/nodes") return j({ count: 1, results: [{ id: 66, name: "Art & Collectibles", children: [{ id: 117, name: "Prints", children: [{ id: 2078, name: "Digital Prints", children: [] }] }] }] });
  let m;
  if ((m = /^\/shops\/(\d+)\/listings$/.exec(p)) && method === "POST") { const id = String(nextId++); listings[id] = { listing_id: Number(id), state: "draft", url: `https://www.etsy.com/listing/${id}/x` }; return j({ ...listings[id], title: c.form?.get("title") }, 201); }
  if ((m = /^\/shops\/\d+\/listings\/(\d+)$/.exec(p)) && method === "PATCH") { const st = c.form?.get("state"); if (st) listings[m[1]].state = st; return j(listings[m[1]]); }
  if (/^\/shops\/\d+\/listings\/\d+\/images$/.test(p)) return j({ listing_image_id: nextId++, rank: Number(c.multipart?.get("rank")) }, 201);
  if (/^\/shops\/\d+\/listings\/\d+\/files$/.test(p) && method === "POST") return j({ listing_file_id: nextId++, filename: c.multipart?.get("name") }, 201);
  if (/^\/shops\/\d+\/listings\/\d+\/files\/\d+$/.test(p) && method === "DELETE") return new Response(null, { status: 204 });
  if ((m = /^\/listings\/(\d+)\/inventory$/.exec(p)) && method === "GET") return j({ products: [{ sku: "", property_values: [], offerings: [{ price: { amount: 500, divisor: 100 }, quantity: 999, is_enabled: true }] }], price_on_property: [], quantity_on_property: [], sku_on_property: [] });
  if (/^\/listings\/\d+\/inventory$/.test(p) && method === "PUT") return j({ products: c.json.products });
  if (/^\/shops\/\d+\/shipping-profiles$/.test(p)) return j({ count: 0, results: [] });
  if (p === "/listings/777" && method === "GET") return j({ listing_id: 777, state: "active", url: "https://www.etsy.com/listing/777/x" });
  if (/^\/listings\/777\/images$/.test(p) && method === "GET") return j({ count: 2, results: [{ listing_image_id: 1 }, { listing_image_id: 2 }] });
  if (/^\/shops\/\d+\/listings\/777\/files$/.test(p) && method === "GET") return j({ count: 5, results: [11, 12, 13, 14, 15].map((id) => ({ listing_file_id: id })) });
  if (/^\/shops\/\d+\/listings\/\d+\/images\/\d+$/.test(p) && method === "DELETE") return new Response(null, { status: 204 });
  return j({ error: "no route " + p }, 404);
}) as typeof fetch;

function fakeDb() {
  const cache: Record<string, any> = {};
  return {
    cache,
    from: (t: string) => {
      let k = "";
      const api: any = {
        select: () => api, eq: (_c: string, v: string) => { k = v; return api; },
        maybeSingle: async () => ({ data: t === "app_cache" && cache[k] ? cache[k] : null }),
        upsert: async (row: any) => { cache[row.key] = row; return { error: null }; },
      };
      return api;
    },
  };
}
const files = [{ id: "f1", path: "u/1/a.pdf", name: "print-8x10.pdf", rank: 1 }, { id: "f2", path: "u/1/b.pdf", name: "print-A4.pdf", rank: 2 }];
const base = (over: any = {}) => ({
  db: fakeDb(), ctx: { token: "tok" }, shopId: "555",
  listing: { id: "l1", title: "Botanical Wall Art: Fern Print % Digital % Download", description: "<p>Printable art</p>", price: 4.99, keywords: ["botanical print", "fern wall art printable download", "digital download!!", "botanical print"], validation: null },
  product: { id: 1, product_type: "digital", name: "Fern" },
  images: [{ url: "https://img.test/1.jpg" }, { url: "https://img.test/2.jpg" }], files, publish: false,
  download: async (_p: string) => new Blob([new Uint8Array([37, 80, 68, 70])], { type: "application/pdf" }),
  ...over,
});

Deno.test("x-api-key: anahtar:gizli anahtar", () => {
  assertEquals(E.etsyApiKey(), "testkeystring123:abcde12345");
});

Deno.test("Etiket / başlık kuralları", () => {
  const t = E.cleanTags(["botanical print", "fern wall art printable download", "digital download!!", "Botanical Print", ...Array.from({ length: 20 }, (_, i) => "tag" + i)]);
  assert(t.length === 13 && t.every((x) => x.length <= 20));
  assertEquals(t[0], "botanical print");
  assertEquals(t[2], "digital download");
  assertEquals(t.filter((x) => x.toLowerCase() === "botanical print").length, 1);
  assertEquals(E.cleanTitle("A % B % C: D: E & F & G"), "A % B  C: D E & F  G".replace(/\s+/g, " "));
});

Deno.test("Kategori: Digital Prints ağaçtan bulunur ve önbelleğe alınır", async () => {
  calls = [];
  const db = fakeDb();
  assertEquals(await E.etsyTaxonomyId(db, { token: "t" }), 2078);
  assertEquals(await E.etsyTaxonomyId(db, { token: "t" }), 2078);
  assertEquals(calls.filter((c) => c.path.endsWith("/seller-taxonomy/nodes")).length, 1, "ikinci kez Etsy'ye sorulmadı");
});

Deno.test("Yeni dijital ilan: taslak (download, Digital Prints, i_did, 2020_2026, is_supply=false) + görseller + dosyalar, YAYINLANMAZ", async () => {
  calls = [];
  const r = await L.submitEtsyListing(base());
  const create = calls.find((c) => c.method === "POST" && /\/shops\/555\/listings$/.test(c.path))!;
  const f = create.form!;
  assertEquals(f.get("type"), "download");
  assertEquals(f.get("who_made"), "i_did");
  assertEquals(f.get("when_made"), "2020_2026");
  assertEquals(f.get("is_supply"), "false");
  assertEquals(f.get("taxonomy_id"), "2078");
  assertEquals(f.get("price"), "4.99");
  assertEquals(f.get("quantity"), "999");
  assertEquals(f.get("description"), "Printable art");
  assert(!f.get("title")!.includes("%  ") && f.get("title")!.split("%").length - 1 <= 1, "başlıkta % en fazla bir kez");
  assertEquals(create.headers.get("x-api-key"), "testkeystring123:abcde12345");
  assertEquals(create.headers.get("authorization"), "Bearer tok");
  assertEquals(calls.filter((c) => /\/images$/.test(c.path)).length, 2);
  const fileCalls = calls.filter((c) => /\/files$/.test(c.path));
  assertEquals(fileCalls.length, 2);
  assertEquals(fileCalls[0].multipart!.get("name"), "print-8x10.pdf");
  assertEquals(fileCalls[1].multipart!.get("rank"), "2");
  assert(!calls.some((c) => c.method === "PATCH"), "taslak: yayınlama isteği yok");
  assertEquals(r.state, "draft");
  assert(r.ok);
  assertEquals(r.etsy.files.length, 2);
});

Deno.test("\"Gönder ve yayınla\": state=active", async () => {
  calls = [];
  const r = await L.submitEtsyListing(base({ publish: true }));
  const pub = calls.find((c) => c.method === "PATCH" && c.form?.get("state") === "active");
  assert(pub, "yayınlama isteği");
  assertEquals(r.state, "active");
});

Deno.test("Var olan ilan: güncelleme + fiyat/adet; yüklenenler tekrar yüklenmez; silinen dosya Etsy'den silinir; sonradan yayınla", async () => {
  const first = await L.submitEtsyListing(base());
  calls = [];
  const second = await L.submitEtsyListing(base({ listing: { ...base().listing, price: 6.5, validation: { etsy: first.etsy } }, files: [files[0]], publish: true }));
  assert(!calls.some((c) => c.method === "POST" && /\/listings$/.test(c.path)), "yeni taslak açılmadı");
  assert(!calls.some((c) => /\/images$/.test(c.path)), "görseller tekrar yüklenmedi");
  assertEquals(calls.filter((c) => c.method === "DELETE" && /\/files\/\d+$/.test(c.path)).length, 1, "silinen dosya Etsy'den silindi");
  const inv = calls.find((c) => c.method === "PUT" && /\/inventory$/.test(c.path))!;
  assertEquals(inv.json.products[0].offerings[0].price, 6.5);
  assertEquals(second.state, "active");
  assertEquals(second.etsy.files.length, 1);
});

Deno.test("Eksikler: dijitalde dosya yoksa / görsel yoksa gönderilmez; fiziksel üründe kargo profili şart", async () => {
  calls = [];
  let r = await L.submitEtsyListing(base({ files: [] }));
  assert(!r.ok && r.errors.some((e: string) => e.includes("indirilebilir dosya")));
  r = await L.submitEtsyListing(base({ images: [] }));
  assert(!r.ok && r.errors.some((e: string) => e.includes("görsel")));
  assertEquals(calls.length, 0, "eksikte Etsy'ye hiç gidilmedi");
  r = await L.submitEtsyListing(base({ product: { id: 2, product_type: "physical", stock_qty: 3 } }));
  assert(!r.ok && r.errors[0].includes("kargo profili"));
});

Deno.test("Kota (429): beklenip tekrar denenir", async () => {
  calls = [];
  fail429 = 2;
  const r = await L.submitEtsyListing(base({ images: [{ url: "https://img.test/1.jpg" }], files: [files[0]] }));
  assert(r.ok, r.errors.join());
});

Deno.test("Otomatik yenileme: yeni ilanda should_auto_renew=true; ayar yoksa false", async () => {
  calls = [];
  await L.submitEtsyListing(base({ listing: { ...base().listing, attributes: { etsy_auto_renew: true } } }));
  assertEquals(calls.find((c) => c.method === "POST" && /\/listings$/.test(c.path))!.form!.get("should_auto_renew"), "true");
  calls = [];
  await L.submitEtsyListing(base());
  assertEquals(calls.find((c) => c.method === "POST" && /\/listings$/.test(c.path))!.form!.get("should_auto_renew"), "false");
});

Deno.test("Devralınan yayındaki ilan: eski 2 görsel ve 5 dosya yenileriyle değişir; ilan hiçbir an görselsiz/dosyasız kalmaz; bir kez", async () => {
  calls = [];
  const files5 = [1, 2, 3, 4, 5].map((k) => ({ id: "n" + k, path: "u/" + k, name: `new-${k}.jpg`, rank: k }));
  const lst = { ...base().listing, attributes: { etsy_replace_media: true, etsy_auto_renew: true }, validation: { etsy: { listing_id: "777", images: [], files: [] } } };  // durum bilinmiyor -> Etsy'den okunur
  const r = await L.submitEtsyListing(base({ listing: lst, files: files5, publish: true }));
  assert(r.ok, r.errors.join());
  const seq = calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace(/.*\/listings\/777/, "")}`);
  assert(seq[0].startsWith("PATCH") && calls[0].form!.get("should_auto_renew") === "true", "güncelleme + otomatik yenileme");
  const firstImgDel = seq.findIndex((x) => /DELETE \/images\//.test(x)), lastImgUp = seq.map((x) => /POST \/images$/.test(x)).lastIndexOf(true);
  assert(lastImgUp >= 0 && firstImgDel > lastImgUp, "eski görseller yeniler yüklendikten sonra silinir");
  assertEquals(seq.filter((x) => /DELETE \/images\//.test(x)).length, 2);
  // dosya sayısı hiçbir an 5'i aşmaz ve 4'ün altına düşmez
  let n = 5; for (const x of seq) { if (/DELETE \/files\//.test(x)) n--; if (/POST \/files$/.test(x)) n++; assert(n <= 5 && n >= 4, "dosya sayısı " + n); }
  assertEquals(seq.filter((x) => /DELETE \/files\//.test(x)).length, 5);
  assert(!seq.some((x) => /state/.test(x)) && r.state === "active", "zaten yayında: tekrar yayınlama yok");
  assert(r.etsy.media_replaced_at, "bir kez yapıldı olarak işaretlendi");
  calls = [];
  await L.submitEtsyListing(base({ listing: { ...lst, validation: { etsy: r.etsy } }, files: files5 }));
  assert(!calls.some((c) => c.method === "DELETE"), "ikinci gönderimde silme yok");
});

Deno.test("Kapak değişti: yeni kapak rank 1'e yüklenir, eskisi SONRA silinir; diğer görseller dokunulmaz", async () => {
  const first = await L.submitEtsyListing(base());
  calls = [];
  const imgs = [{ url: "https://img.test/kapak-yeni.jpg" }, { url: "https://img.test/2.jpg" }];
  const r = await L.submitEtsyListing(base({ listing: { ...base().listing, validation: { etsy: first.etsy } }, images: imgs }));
  const seq = calls.filter((c) => /\/images/.test(c.path)).map((c) => c.method);
  assertEquals(seq, ["POST", "DELETE"], "önce yükle, sonra sil");
  assertEquals(calls.find((c) => c.method === "POST" && /\/images$/.test(c.path))!.multipart!.get("rank"), "1");
  assertEquals(r.etsy.images.map((x: any) => x.src).sort(), imgs.map((x) => x.url).sort());
});

Deno.test({ name: "son", fn() { globalThis.fetch = real; } });
