"""Sabit IP sunucusu için Hetzner "Cloud config" metnini üretir (yalnız bu bilgisayarda).

Çıktı: %LOCALAPPDATA%\\seltigo-sabit-ip\\cloud-init.yaml  (proxy şifresini içerir, depoya GİRMEZ)
Şifre: %LOCALAPPDATA%\\seltigo-sabit-ip\\proxy.env (EGRESS_PROXY_PASSWORD=...). Yoksa üretilir;
aynı değer Supabase secret EGRESS_PROXY_PASSWORD olarak da kayıtlı olmalı:
    supabase secrets set --env-file "%LOCALAPPDATA%\\seltigo-sabit-ip\\proxy.env" --project-ref ytucdrrgxsjhrqmaxckt

Kurulum betiği GitHub'daki sabit bir commit'ten indirilir (sonradan değişen kod sunucuya
kendiliğinden girmesin). İzinli alan adları listesi ise main dalından 15 dakikada bir güncellenir.
Kullanım:  python infra/sabit-ip/hazirla.py   (commit + push yapıldıktan sonra)
"""
import os
import pathlib
import secrets
import subprocess

REPO = "mustafabahsimb-eng/hizlisatici-ai"
OUT_DIR = pathlib.Path(os.environ["LOCALAPPDATA"]) / "seltigo-sabit-ip"


def password() -> str:
    env = OUT_DIR / "proxy.env"
    if not env.exists():
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        env.write_text("EGRESS_PROXY_PASSWORD=" + secrets.token_urlsafe(32) + "\n", encoding="utf-8")
        print("Yeni şifre üretildi; Supabase secret'ına da kaydetmeyi unutma (yukarıdaki komut).")
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("EGRESS_PROXY_PASSWORD="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("proxy.env içinde EGRESS_PROXY_PASSWORD yok")


def main():
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    remote = subprocess.run(["git", "branch", "-r", "--contains", sha], capture_output=True, text=True).stdout
    if "origin/" not in remote:
        raise SystemExit("Bu commit GitHub'a gönderilmemiş; önce git push yap.")
    pw = password()
    raw = f"https://raw.githubusercontent.com/{REPO}/{sha}/infra/sabit-ip"
    alan = f"https://raw.githubusercontent.com/{REPO}/main/infra/sabit-ip/izinli-alanlar.txt"
    yaml = f"""#cloud-config
# Seltigo sabit IP sunucusu (commit {sha[:7]}). Kurulum kaydı: /var/log/seltigo-kurulum.log
runcmd:
  - [bash, -c, "curl -fsSL --retry 5 {raw}/kurulum.sh -o /root/seltigo-kurulum.sh && PROXY_PASSWORD='{pw}' REPO_RAW='{raw}' ALAN_URL='{alan}' bash /root/seltigo-kurulum.sh > /var/log/seltigo-kurulum.log 2>&1"]
"""
    out = OUT_DIR / "cloud-init.yaml"
    out.write_text(yaml, encoding="utf-8", newline="\n")
    print(f"Hazır: {out}")


if __name__ == "__main__":
    main()
