// Supabase Edge Function: chat-to-sell
// Kullanıcının doğal dille yazdığı komutu (ürün ekle/sil/listele/soru sor) yorumlayıp
// hangi işlemin yapılacağını + kullanıcıya gösterilecek doğal dil yanıtı JSON olarak döner.
// Veritabanı işlemini GERÇEKTEN yapan taraf frontend'dir (add-product.html'deki mevcut
// kaydetme/silme mantığını kullanır) - bu fonksiyon sadece niyeti anlar.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function extractJson(fullText: string): any {
  let text = fullText.replace(/```json/gi, "").replace(/```/g, "");

  try {
    return JSON.parse(text.trim());
  } catch {
    // devam et
  }

  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;

  let candidate = text.slice(start, end + 1);
  candidate = Array.from(candidate)
    .map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch))
    .join("");

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { message, products } = await req.json().catch(() => ({}));
    if (!message) {
      return new Response(JSON.stringify({ error: "Mesaj gerekli" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const productList = Array.isArray(products) ? products : [];
    const productListText = productList.length > 0
      ? productList.map((p: any) => `- ${p.name} (id: ${p.id}, platform: ${p.platform || "-"})`).join("\n")
      : "(henüz hiç ürün yok)";

    const systemPrompt = `Sen HızlıSatıcı AI adlı bir e-ticaret uygulamasının sohbet asistanısın. Kullanıcı sana doğal dille (Türkçe) komut veriyor, sen bu komutun ne anlama geldiğini anlayıp yapılacak işlemi JSON olarak döneceksin. Veritabanı işlemini SEN yapmıyorsun, sadece hangi işlemin yapılacağını belirliyorsun - gerçek işlemi uygulama yapacak.

Kullanıcının şu anki ürün listesi:
${productListText}

Yapabileceğin işlemler (action alanına yaz):
- "add_product": kullanıcı yeni bir ürün eklemek istiyor. params.name alanına eklenecek ürünün adını yaz.
- "delete_product": kullanıcı bir ürünü silmek istiyor. Yukarıdaki listeden en uygun eşleşen ürünü bul, params.id alanına o ürünün id'sini yaz. Eşleşen ürün bulamazsan action'ı "none" yap ve reply'de açıkla.
- "list_products": kullanıcı ürünlerini/listesini görmek istiyor.
- "none": yukarıdakilerin hiçbiri değilse (selamlaşma, genel soru, anlaşılmayan komut vb.) - sadece reply ile doğal bir yanıt ver.

Kurallar:
- Yanıtın SADECE tek satırlık geçerli bir JSON nesnesi olsun, başka hiçbir metin ekleme.
- "reply" alanı HER ZAMAN dolu olmalı - kullanıcıya gösterilecek kısa, doğal, samimi bir Türkçe yanıt (1-2 cümle).
- Format: {"action": "add_product veya delete_product veya list_products veya none", "params": {"name": "..." } veya {"id": "..."} veya {}, "reply": "..."}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: "AI hatası: " + JSON.stringify(data).slice(0, 300) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const textBlocks = (data.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    const fullText = textBlocks.join("\n");

    const parsed = extractJson(fullText);

    if (!parsed) {
      return new Response(
        JSON.stringify({
          action: "none",
          params: {},
          reply: "Bunu tam anlayamadım, farklı bir şekilde söyler misin?",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});