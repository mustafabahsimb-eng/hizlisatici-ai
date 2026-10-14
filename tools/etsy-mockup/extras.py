"""(b) tasarımın düz görseli, (c) '5 Print Sizes Included' bilgi görseli (stile uygun renk ve yazı tipi)."""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
D = Path(__file__).parent; FD = D/"fonts"
P = Path(r"C:\Projeler\hizlisatici-ai\bahsistore_etsy_paket\bahsistore_etsy_paket")
L = json.loads((P/"ilanlar.json").read_text(encoding="utf-8"))["listings"]
STY = {  # zemin, yazı, vurgu, başlık yazı tipi, başlık ağırlığı
 "cream_serif": ("#F3EEE6", "#2B2A28", "#B08D57", "Lora[wght].ttf", 500),
 "charcoal_serif": ("#262523", "#F2EEE6", "#C9A66B", "Lora[wght].ttf", 500),
 "sage_sans": ("#C5CFBC", "#2F3A2E", "#5E6B57", "Poppins-Medium.ttf", None),
 "terracotta_italic": ("#C47A5A", "#FFF6EF", "#F3D9C6", "Lora-Italic[wght].ttf", 500),
 "white_bold_left": ("#FAFAF8", "#111111", "#8A8A8A", "Poppins-ExtraBold.ttf", None)}
SIZES = [("2:3 RATIO", (2, 3), "4x6 · 6x9 · 8x12 · 12x18\n16x24 · 20x30 · 24x36 in"), ("3:4 RATIO", (3, 4), "6x8 · 9x12 · 12x16\n18x24 in"),
         ("4:5 RATIO", (4, 5), "4x5 · 8x10 · 16x20 in"), ("11x14", (11, 14), "11x14 in"), ("ISO RATIO", (1, 1.414), "A1 · A2 · A3 · A4 · A5")]
def font(name, size, wght=None):
    f = ImageFont.truetype(str(FD/name), size)
    if wght:
        try: f.set_variation_by_axes([wght])
        except Exception: pass
    return f
def sizes_image(style, is_set, out):
    bg, fg, ac, tf, tw = STY[style]; W = 2400
    im = Image.new("RGB", (W, W), bg); d = ImageDraw.Draw(im)
    body = "Poppins-Regular.ttf"; bodyb = "Poppins-SemiBold.ttf"
    t = font(tf, 150, tw); title = "5 Print Sizes Included"
    tw_ = d.textlength(title, font=t); d.text(((W - tw_) / 2, 190), title, font=t, fill=fg)
    d.line([(W/2 - 90, 420), (W/2 + 90, 420)], fill=ac, width=5)
    sub = font(body, 52); st = "4 prints in every size  ·  5 ZIP files" if is_set else "High-resolution JPG files  ·  300 DPI"
    d.text(((W - d.textlength(st, font=sub)) / 2, 470), st, font=sub, fill=ac if style != "white_bold_left" else "#555555")
    # 5 oran: üstte 3, altta 2; aynı yükseklikte dikdörtgen
    lab, small = font(bodyb, 50), font(body, 46)
    rows = [SIZES[:3], SIZES[3:]]; boxh = 470
    for r, row in enumerate(rows):
        y = 680 + r * 830; colw = W / 3 if r == 0 else W / 3
        x0 = (W - colw * len(row)) / 2
        for i, (name, (a, b), txt) in enumerate(row):
            cx = x0 + colw * (i + 0.5); bw = boxh * a / b
            line = 6 if style != "white_bold_left" else 9
            d.rectangle([cx - bw/2, y, cx + bw/2, y + boxh], outline=fg, width=line)
            d.rectangle([cx - bw/2 + 26, y + 26, cx + bw/2 - 26, y + boxh - 26], outline=ac, width=2)
            d.text((cx - d.textlength(name, font=lab)/2, y + boxh + 40), name, font=lab, fill=fg)
            for k, ln in enumerate(txt.split("\n")):
                d.text((cx - d.textlength(ln, font=small)/2, y + boxh + 115 + k * 56), ln, font=small, fill=fg)
    foot = font(body, 46); ft = "INSTANT DIGITAL DOWNLOAD  ·  PRINT AT HOME OR AT A PRINT SHOP"
    d.text(((W - d.textlength(ft, font=foot)) / 2, W - 150), ft, font=foot, fill=ac if style != "white_bold_left" else "#555555")
    im.save(out, quality=93)
def flat_image(l, out):
    f = P/l["folder"]
    if l["type"] == "set": im = Image.open(f/"fotograflar"/"onizleme_set.jpg").convert("RGB")
    else:
        src = next((f/"dosyalar").glob("*_2x3-ratio.jpg")); im = Image.open(src).convert("RGB"); im = im.resize((2000, 3000), Image.LANCZOS)
    im.save(out, quality=93)
if __name__ == "__main__":
    o = D/"out"; o.mkdir(exist_ok=True)
    for l in L:
        n = l["no"]; sizes_image(l["style"], l["type"] == "set", o/f"{n:02d}_3_sizes.jpg"); flat_image(l, o/f"{n:02d}_2_flat.jpg")
        Image.open(D/"covers"/f"{n:02d}.jpg").save(o/f"{n:02d}_1_cover.jpg", quality=93)
    print("ok")
