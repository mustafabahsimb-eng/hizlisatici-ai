"""Tasarımları giysi renkleri üzerinde küçük önizleme (kontrol için)."""
import os, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
D = Path(os.environ["LOCALAPPDATA"]) / "seltigo-pod" / "designs"
BG = {"sand": "#D8C7A8", "black": "#1E1E1E", "white": "#F4F4F2", "light pink": "#F2CFD6", "forest green": "#2F4A3A"}
INK = {"sand": "dark", "white": "dark", "light pink": "dark", "black": "light", "forest green": "light"}
def tile(key, color, t=420):
    im = Image.open(D / f"{key}_{INK[color]}.png"); im.thumbnail((t, int(t*1.2)))
    bg = Image.new("RGBA", im.size, BG[color]); bg.alpha_composite(im); return bg.convert("RGB")
if __name__ == "__main__":
    keys = sorted({p.stem.rsplit("_", 1)[0] for p in D.glob("*_dark.png")}); colors = sys.argv[2].split(",") if len(sys.argv) > 2 else ["sand", "black"]
    t = 300; cw = t*len(colors) + 10; f = ImageFont.truetype("arial.ttf", 18); cols = 5
    out = Image.new("RGB", (cols*cw, ((len(keys)+cols-1)//cols)*(int(t*1.2)+30)), "white"); d = ImageDraw.Draw(out)
    for i, k in enumerate(keys):
        x, y = (i % cols)*cw, (i//cols)*(int(t*1.2)+30)
        for j, c in enumerate(colors): out.paste(tile(k, c, t), (x + j*t, y + 24))
        d.text((x+4, y+2), k, fill="red", font=f)
    out.save(sys.argv[1], quality=85)
