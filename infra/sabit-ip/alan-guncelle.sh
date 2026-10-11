#!/usr/bin/env bash
# Seltigo: izinli alan adları listesini GitHub'dan çekip Squid'e uygular (systemd timer, 15 dk).
# Liste bozuksa ya da Squid ayarı doğrulanamazsa eski liste korunur.
set -euo pipefail
ALAN_URL="${ALAN_URL:?ALAN_URL gerekli}"
HEDEF=/etc/squid/izinli-alanlar.txt
GECICI="$(mktemp)"
trap 'rm -f "$GECICI" "$GECICI.temiz"' EXIT

curl -fsS --max-time 30 "$ALAN_URL" -o "$GECICI"
# Yorum ve boş satırları at, her satırı doğrula
grep -vE '^\s*(#|$)' "$GECICI" | tr -d '\r' | sed 's/[[:space:]]//g' > "$GECICI.temiz"
[ -s "$GECICI.temiz" ] || { echo "Liste boş, uygulanmadı"; exit 1; }
if grep -vqE '^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' "$GECICI.temiz"; then
  echo "Listede geçersiz satır var, uygulanmadı"; exit 1
fi

if [ -f "$HEDEF" ] && cmp -s "$GECICI.temiz" "$HEDEF"; then exit 0; fi

[ -f "$HEDEF" ] && cp "$HEDEF" "$HEDEF.onceki"
install -m 644 "$GECICI.temiz" "$HEDEF"
[ "${NO_RELOAD:-0}" = "1" ] && exit 0

if squid -k parse -f /etc/squid/squid.conf >/dev/null 2>&1; then
  systemctl reload squid || squid -k reconfigure
  echo "İzinli alan adları güncellendi"
else
  echo "Squid yeni listeyi kabul etmedi; eski liste geri yüklendi"
  [ -f "$HEDEF.onceki" ] && cp "$HEDEF.onceki" "$HEDEF"
  exit 1
fi
