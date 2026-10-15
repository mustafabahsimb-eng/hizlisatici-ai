"""Noel sweatshirt koleksiyonu: ürün tanımları (İngilizce SEO başlık, 13 etiket, açıklama), giysi ve fiyat ayarları.
Çıktı: collection.json (yükleyici printify_yukle.py ve önizleme sayfası bunu okur)."""
import json
from pathlib import Path
from pricing import price_for, FEES, MIN_MARGIN

GARMENT = {
    "chosen": "gildan-18000",
    "gildan-18000": {"name": "Gildan 18000 Heavy Blend Crewneck Sweatshirt", "brand": "Gildan", "model": "18000",
                     # Tahmini (Printify sitesi, Ekim 2026): taban 15,24 $ (Premium 11,22 $); ABD kargo ilk ürün ~7,99 $ (tahmin).
                     # Token gelince yükleyici gerçek maliyeti Printify'dan okur ve fiyatı yeniden hesaplar.
                     "est_base": {"S-XL": 15.24, "2XL": 17.74, "3XL": 19.74}, "est_base_premium": {"S-XL": 11.22, "2XL": 13.72, "3XL": 15.72}},
    "comfort-colors-1566": {"name": "Comfort Colors 1566 Garment-Dyed Crewneck Sweatshirt", "brand": "Comfort Colors", "model": "1566",
                     "est_base": {"S-XL": 31.29, "2XL": 34.29, "3XL": 36.29}, "est_base_premium": {"S-XL": 23.85, "2XL": 26.85, "3XL": 28.85}},
    "est_shipping_us": 7.99,
    "colors": ["Sand", "Black", "White", "Light Pink", "Forest Green"],
    "dark_garments": ["Black", "Forest Green"],     # bunlara 'light' mürekkepli baskı dosyası gider
    "sizes": ["S", "M", "L", "XL", "2XL", "3XL"],
    # Hızlı ABD üretici tercihi (Printify API puan vermez; bilinen yüksek puanlı ABD üreticileri sırayla, hepsi 5 renk + S-3XL'i karşılamalı)
    "provider_preference": ["SwiftPOD", "Monster Digital", "Print Geek", "Fulfill Engine", "Printify Choice"],
}

COMMON_DESC = """{hook}

{body}

PRODUCT DETAILS
• Gildan 18000 Heavy Blend unisex crewneck sweatshirt
• 50% cotton, 50% polyester — soft, warm, medium-heavy fabric
• Classic loose fit, ribbed collar, cuffs and waistband
• Unisex sizing S–3XL (see the size chart in the photos; size up for an oversized look)
• Colors: Sand, Black, White, Light Pink, Forest Green

PRINTING & SHIPPING
• Printed on demand in the USA with direct-to-garment printing
• Production 2–5 business days, then shipped with tracking
• Order by early December for Christmas delivery in the US

CARE
• Machine wash cold, inside out, gentle cycle
• Tumble dry low or hang dry; do not iron directly on the print

Every piece is made just for you, so returns are not accepted — but if anything arrives damaged or misprinted, message us and we will make it right."""

def desc(hook, body): return COMMON_DESC.format(hook=hook, body=body)

MLT_TAGS_BASE = ["most likely to", "family christmas", "matching sweatshirt", "christmas sweatshirt", "family pajama set", "holiday crewneck",
                 "funny christmas", "christmas gift", "group christmas", "xmas sweater", "cousin crew shirt"]
MLT = [
    ("mlt-cookies", "Eat All The Cookies", "cookie lover gift", "the cookie monster of the family (we all know who)"),
    ("mlt-movies", "Watch Holiday Movies All Day", "holiday movie fan", "the one who never leaves the couch in December"),
    ("mlt-naughty", "Be On The Naughty List", "naughty list shirt", "the family troublemaker"),
    ("mlt-burn", "Burn The Cookies", "baking gift", "the baker whose cookies come out a little too crispy"),
    ("mlt-presents", "Shake Every Present", "gift shaker shirt", "the one who can't wait until Christmas morning"),
    ("mlt-asleep", "Fall Asleep By The Fire", "cozy christmas", "the first one asleep after dinner"),
    ("mlt-snowball", "Throw The First Snowball", "snowball fight", "the one who always starts it"),
    ("mlt-carols", "Sing Carols Off Key", "christmas carols", "the loudest (and most off-key) singer at the party"),
]

def build():
    items = []
    for key, phrase, tag12, who in MLT:
        items.append({
            "key": key, "group": "Most Likely To", "season": "christmas", "personalized": False,
            "title": f"Most Likely To {phrase} Christmas Sweatshirt, Matching Family Christmas Crewneck, Funny Holiday Group Shirt, Xmas Gift",
            "tags": MLT_TAGS_BASE + [tag12, "gift for mom"],
            "description": desc(f"Most likely to {phrase.lower()}? Tag {who} with this cozy Christmas crewneck.",
                                "Part of our Most Likely To Christmas collection — mix and match different sayings for the whole family, cousins, "
                                "friends or your office party. Same retro design style across the set, so your group photos look perfect.\n\n"
                                "Perfect as a family Christmas gift, a matching outfit for Christmas morning, a Secret Santa present or a gift for mom, dad, sister or grandma."),
        })
    items += [
        {"key": "gingerbread-season", "group": "Retro & Pink Christmas", "season": "christmas", "personalized": False,
         "title": "Gingerbread Season Sweatshirt, Retro Christmas Crewneck, Cute Gingerbread Man Holiday Sweater, Christmas Gift for Her",
         "tags": ["gingerbread", "retro christmas", "christmas sweatshirt", "gingerbread man", "holiday crewneck", "cute christmas", "christmas gift",
                  "gift for her", "baking lover gift", "cookie season", "xmas sweater", "winter sweatshirt", "vintage christmas"],
         "description": desc("Gingerbread season is the best season. A cozy retro Christmas crewneck with a hand-drawn style gingerbread man.",
                             "Bring warm cookie vibes to cookie swaps, holiday baking days and Christmas markets. A sweet Christmas gift for her, "
                             "for mom, for your best friend or for any baking lover.")},
        {"key": "pink-merry", "group": "Retro & Pink Christmas", "season": "christmas", "personalized": False,
         "title": "Pink Christmas Tree Sweatshirt, Merry Christmas Retro Crewneck, Vintage Pink Holiday Sweater, Christmas Gift for Her",
         "tags": ["pink christmas", "merry christmas", "christmas sweatshirt", "pink christmas tree", "retro christmas", "vintage christmas",
                  "holiday crewneck", "christmas gift", "gift for her", "girly christmas", "xmas sweater", "winter sweatshirt", "preppy christmas"],
         "description": desc("Merry Christmas, the pink way. A vintage-inspired pink Christmas tree with retro lettering.",
                             "Made for pink Christmas lovers, holiday parties, cookie exchanges and cozy nights in. A cute Christmas gift for her, "
                             "your sister, daughter or best friend.")},
        {"key": "mama-patchwork", "group": "Personalized Mama", "season": "evergreen", "personalized": True, "word": "Mama",
         "personalization": {"instructions": "Enter your kids' names separated by commas (up to 8 names, e.g. Emma, Liam, Noah). Names are printed exactly as written.",
                             "char_max": 120, "required": True},
         "title": "Personalized Mama Sweatshirt with Kids Names, Faux Patchwork Mama Crewneck, Custom Mom Gift, Mothers Day Christmas Gift",
         "tags": ["mama sweatshirt", "custom mama shirt", "kids names shirt", "personalized mom", "gift for mom", "mama crewneck", "patchwork mama",
                  "mothers day gift", "new mom gift", "custom mom gift", "mom christmas gift", "mama with names", "grandma gift"],
         "description": desc("A cozy Mama crewneck with a faux patchwork quilt look — personalized with your kids' names.",
                             "HOW TO PERSONALIZE\n1. Choose size and color\n2. In the personalization box, type the kids' names separated by commas\n"
                             "3. We print the names exactly as written, in a soft script under the Mama letters\n\n"
                             "The patchwork is a printed design (not real fabric). A heartfelt gift for Christmas, Mother's Day, birthdays or new moms.")},
    ]
    for key, animal, phrase, extra in [("animal-frog", "frog", "Stay Cozy", "frog lover gift"), ("animal-cat", "cat", "Nap Season", "cat lover gift"),
                                      ("animal-bird", "robin bird", "Cozy Mode", "bird lover gift")]:
        items.append({"key": key, "group": "Retro Beanie Animals", "season": "evergreen", "personalized": False,
                      "title": f"Retro {animal.title()} in Beanie Sweatshirt, {phrase} Crewneck, Cute {animal.split()[0].title()} Sweater, Cozy Winter Gift",
                      "tags": [f"{animal.split()[0]} sweatshirt", f"cute {animal.split()[0]}", extra, "retro sweatshirt", "beanie animal", "cozy sweatshirt",
                               "winter crewneck", "cute animal shirt", "gift for her", "aesthetic crewneck", phrase.lower(), "trendy sweatshirt", "fall sweatshirt"],
                      "description": desc(f"A cute retro {animal} in a cozy knit beanie — {phrase.lower()} all year long.",
                                          f"Soft, warm and a little bit funny. A sweet gift for any {animal.split()[0]} lover, for cozy weekends, "
                                          "coffee runs and chilly evenings.")})
    items.append({"key": "bookish-soul", "group": "Book Lover", "season": "evergreen", "personalized": False,
                  "title": "Bookish Soul Sweatshirt, Book Lover Crewneck, Retro Book Stack Sweater, Reading Gift for Readers, Librarian Teacher Gift",
                  "tags": ["bookish sweatshirt", "book lover gift", "reading sweatshirt", "bookworm gift", "librarian gift", "teacher gift", "book club gift",
                           "retro book stack", "bookish gift", "reader gift", "cozy reading", "book crewneck", "literary gift"],
                  "description": desc("For the bookish soul who is always reading. A retro stack of books with a cozy mug on top.",
                                      "Perfect for book club nights, library days and lazy weekends with a good story. A thoughtful gift for readers, "
                                      "librarians, teachers and bookworms.")})
    for it in items:
        assert len(it["title"]) <= 140, (it["key"], len(it["title"]))
        it["tags"] = [t[:20] for t in it["tags"]][:13]; assert len(it["tags"]) == 13 and len(set(it["tags"])) == 13, it["key"]
    return items

def estimate_prices(garment_key, premium=False):
    g = GARMENT[garment_key]; base = g["est_base_premium" if premium else "est_base"]; out = {}
    for tier, b in base.items():
        cost = round(b + GARMENT["est_shipping_us"], 2); out[tier] = {"cost": cost, **price_for(cost)}
    return out

if __name__ == "__main__":
    items = build()
    comp = {k: {"standard": estimate_prices(k), "premium": estimate_prices(k, True), "name": GARMENT[k]["name"]} for k in ("gildan-18000", "comfort-colors-1566")}
    data = {"garment": GARMENT, "fees": FEES, "min_margin": MIN_MARGIN, "comparison": comp, "items": items}
    Path(__file__).with_name("collection.json").write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    print(len(items), "ürün")
    for k, v in comp.items(): print(k, {t: (x["cost"], x["price"], x["with_ads"]["net"]) for t, x in v["standard"].items()})
