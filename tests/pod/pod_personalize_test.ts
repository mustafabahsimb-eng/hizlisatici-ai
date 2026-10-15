// Kişiselleştirme: isim ayrıştırma + isim katmanı çizimi (gerçek resvg-wasm ve Pacifico yazı tipiyle). Çizimler OUT klasörüne yazılır (görsel kontrol).
// Çalıştırma: deno test --no-check -A tests/pod/pod_personalize_test.ts  (OUT: POD_TEST_OUT ortam değişkeni)
import { assertEquals, assert } from "jsr:@std/assert@1.0.13";
Deno.env.set("SUPABASE_URL", "http://localhost"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "x");
const serve = Deno.serve; (Deno as any).serve = () => ({}) as any;
const m = await import("../../supabase/functions/pod-personalize/index.ts");
(Deno as any).serve = serve;
Deno.test("isimleri ayrıştır", () => {
  assertEquals(m.parseNames("Emma, Liam & Noah"), ["Emma", "Liam", "Noah"]);
  assertEquals(m.parseNames("Names: Ava\nMason and Lucas"), ["Ava", "Mason", "Lucas"]);
  assertEquals(m.parseNames("Zoë / José 💕"), ["Zoë", "José"]);
  assertEquals(m.parseNames(""), []);
  assertEquals(m.parseNames("a,b,c,d,e,f,g,h,i,j").length, 8);
});
Deno.test("satır düzeni", () => {
  assertEquals(m.layoutLines(["Emma", "Liam"]).length, 1);
  assertEquals(m.layoutLines(["Alexander", "Christopher", "Elizabeth", "Sophia"]).length, 2);
});
Deno.test("isim katmanı çizilir ve genişliğe sığar", async () => {
  const cfg = JSON.parse(await Deno.readTextFile(new URL("../../tools/pod-noel/mama_layout.json", import.meta.url)));
  const out = Deno.env.get("POD_TEST_OUT") || ".";
  for (const [k, names] of Object.entries({ short: ["Emma", "Liam", "Noah"], long: ["Alexander", "Christopher", "Elizabeth", "Sophia", "Benjamin"] })) {
    const r = await m.renderNames(names, cfg.ink.dark, cfg);
    assert(r.png.length > 1000); await Deno.writeFile(`${out}/names_${k}.png`, r.png);
    await Deno.writeTextFile(`${out}/names_${k}.json`, JSON.stringify({ heightPx: r.heightPx, y: m.yFrac(cfg.names.top_px + r.heightPx / 2, cfg) }));
  }
});
