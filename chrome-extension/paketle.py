"""Seltigo Chrome eklentisini Chrome Web Mağazası'na yüklenecek zip olarak paketler.

Kullanım:  python chrome-extension/paketle.py   ->  seltigo-chrome-<sürüm>.zip (depo kökünde; depoya eklenmez)
Pakete yalnız eklentinin çalışma dosyaları girer (bu betik ve belgeler girmez).
"""
import json
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
INCLUDE = ["manifest.json", "background.js", "extract.js", "popup.html", "popup.css", "popup.js", "icons", "_locales"]


def main():
    version = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))["version"]
    out = HERE.parent / f"seltigo-chrome-{version}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in INCLUDE:
            p = HERE / name
            files = [p] if p.is_file() else sorted(x for x in p.rglob("*") if x.is_file())
            for f in files:
                z.write(f, f.relative_to(HERE).as_posix())
    print(out)


if __name__ == "__main__":
    main()
