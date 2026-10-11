"""Katalog / fiyat listesi yükleme: her türlü dosya, şablonsuz.

Önce örnek dosyaları üretir (katalog_dosyalari.py). Her dosya ayrı ayrı yüklenir ve önizleme kontrol edilir:
- ürün adları ve fiyatları okunmuş mu
- (görselli dosyalarda) her ürünün görseli DOĞRU ürünün fotoğrafı mı: görselin ortasındaki renk,
  o ürünün çizildiği renge yakın olmalı (yanlış eşleşme başka renk verir).
Ürün KAYDEDİLMEZ (yalnız önizleme).
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks
import katalog_dosyalari as K

COLORS = {code: color for code, _, _, color, _ in K.PRODUCTS}
NAMES = {code: name for code, name, _, _, _ in K.PRODUCTS}
PRICES = {code: float(p.replace(",", ".")) for code, _, p, _, _ in K.PRODUCTS}


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def code_of(name):
    for code, n in NAMES.items():
        if n.split()[0].lower() in name.lower() and n.split()[1].lower()[:4] in name.lower():
            return code
    return None


def load(page, files):
    page.goto(f"{SITE}/toplu-yukleme.html")
    page.wait_for_selector("#srcUrl")
    page.get_by_text("📄 Katalog / fiyat listesi yükle").click()
    page.set_input_files("#fileInput", [str(f) for f in files])
    page.wait_for_function("() => typeof items !== 'undefined' && !running && (items.length > 0 || /Hata|Error|bulunamadı/i.test(document.getElementById('progressText').textContent))", timeout=300000)
    if not page.evaluate("items.length"):
        print("   okuma hatası:", page.inner_text("#progressText"))
    return page.evaluate("""async () => {
        const out = [];
        for (const it of items) {
          let rgb = null;
          if (it.images && it.images[0]) {
            const img = new Image(); img.crossOrigin = 'anonymous';
            await new Promise(r => { img.onload = r; img.onerror = r; img.src = it.images[0]; });
            if (img.naturalWidth) {
              const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
              const x = c.getContext('2d'); x.drawImage(img, 0, 0);
              const d = x.getImageData(Math.floor(c.width / 2), Math.floor(c.height * 0.55), 1, 1).data;
              rgb = [d[0], d[1], d[2]];
            }
          }
          out.push({ name: it.name, code: it.model_code, price: it.price, nimg: (it.images || []).length, rgb });
        }
        return out;
    }""")


def main():
    shots = shots_dir()
    fx = Path(shots) / "katalog"
    K.main.__globals__["sys"].argv = ["x", str(fx)]
    K.main()
    c = Checks()
    cases = [
        ("Kodsuz resimli katalog PDF", [fx / "katalog_kodsuz.pdf"], 6, True),
        ("Kodlu katalog PDF", [fx / "katalog_kodlu.pdf"], 6, True),
        ("Taranmış PDF (tek görüntü, OCR)", [fx / "taranmis.pdf"], 3, True),
        ("Ekran görüntüsü", [fx / "ekran.png"], 3, True),
        ("Alışılmadık başlıklı CSV", [fx / "tablo.csv"], 6, False),
    ]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        login(page)
        page.goto(f"{SITE}/toplu-yukleme.html")
        page.wait_for_selector("#srcUrl")
        tab = page.get_by_text("📄 Katalog / fiyat listesi yükle")
        c.check("Sekme adı '📄 Katalog / fiyat listesi yükle'", tab.count() == 1)
        acc = page.get_attribute("#fileInput", "accept") or ""
        c.check("Her türlü dosya kabul ediliyor (PDF, tablo, görüntü)", all(x in acc for x in [".pdf", ".xlsx", ".csv", "image/*"]), acc)
        c.check("Sekmede ve dosya alanında 'Excel' kelimesi geçmiyor",
                "excel" not in (tab.inner_text() + page.inner_text("#filePanel")).lower())

        only = __import__("os").environ.get("KATALOG_ONLY")
        for title, files, n_expected, with_img in cases:
            if only and only not in title:
                continue
            got = load(page, files)
            page.screenshot(path=str(shots / f"katalog_{files[0].stem}.png"), full_page=False)
            found = {}
            for g in got:
                code = (g["code"] or "").upper() if (g["code"] or "").upper() in NAMES else code_of(g["name"] or "")
                if code:
                    found[code] = g
            c.check(f"{title}: {n_expected} ürün okundu", len(found) >= n_expected, f"{len(got)} satır, tanınan {len(found)}")
            okp = [k for k, g in found.items() if g["price"] and abs(float(g["price"]) - PRICES[k]) < 0.01]
            c.check(f"{title}: fiyatlar doğru", len(okp) == len(found) and found, f"{len(okp)}/{len(found)}")
            if with_img:
                right, wrong = [], []
                for k, g in found.items():
                    if not g["rgb"]:
                        continue
                    exp = hex_rgb(COLORS[k])
                    dist = sum(abs(a - b) for a, b in zip(g["rgb"], exp))
                    (right if dist < 90 else wrong).append(f"{k}:{g['rgb']}")
                c.check(f"{title}: görseller doğru ürünlerde", len(right) >= n_expected - 0 and not wrong,
                        f"doğru {len(right)}, yanlış {wrong}")
        c.check("Sayfada JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
