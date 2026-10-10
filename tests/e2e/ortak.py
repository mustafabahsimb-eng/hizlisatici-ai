"""Seltigo tarayıcı testleri - ortak yardımcılar.

Test kullanıcısının bilgileri depoda DEĞİL, bu bilgisayarda durur:
  %LOCALAPPDATA%\\seltigo-e2e\\test-user.env  (E2E_EMAIL, E2E_PASSWORD)
Kurulum: %LOCALAPPDATA%\\seltigo-e2e\\venv içinde playwright==1.63.0 + chromium.
Çalıştırma: <venv>\\Scripts\\python tests\\e2e\\<test>.py [ekran_goruntusu_klasoru]
"""
import os
import sys
from pathlib import Path

SITE = os.environ.get("SELTIGO_SITE", "https://mustafabahsimb-eng.github.io/hizlisatici-ai")


def test_user():
    env = Path(os.environ["LOCALAPPDATA"]) / "seltigo-e2e" / "test-user.env"
    values = {}
    for line in env.read_text(encoding="utf-8").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip()
    return values["E2E_EMAIL"], values["E2E_PASSWORD"]


def shots_dir():
    d = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd() / "e2e-shots"
    d.mkdir(parents=True, exist_ok=True)
    return d


def login(page):
    """Test kullanıcısıyla giriş yapar, panel açılana kadar bekler."""
    email, password = test_user()
    page.goto(f"{SITE}/index.html")
    page.fill("#email", email)
    page.fill("#password", password)
    page.click("#submitBtn")
    page.wait_for_url("**/dashboard.html", timeout=30000)


class Checks:
    """Basit doğrulama listesi: sonunda özet yazar, hata varsa çıkış kodu 1."""

    def __init__(self):
        self.results = []

    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok), detail))
        print(("GEÇTİ " if ok else "KALDI ") + name + (f" — {detail}" if detail else ""), flush=True)

    def finish(self):
        failed = [r for r in self.results if not r[1]]
        print(f"\nSonuç: {len(self.results) - len(failed)}/{len(self.results)} geçti")
        sys.exit(1 if failed else 0)
