#!/usr/bin/env bash
# =========================================================
# Seltigo sabit IP çıkış sunucusu kurulumu (Hetzner, Ubuntu 24.04)
# Sunucu oluşturulurken "Cloud config" ile kendiliğinden çalışır (bkz. docs/sabit-ip-kurulumu.md).
# Elle çalıştırmak için (root):  PROXY_PASSWORD='...' bash kurulum.sh
# Tekrar çalıştırmak güvenlidir (aynı sonuca götürür).
#
# Kurulanlar:
#   - Squid proxy (3128): yalnız şifreli istemci, yalnız HTTPS, yalnız izinli alan adları,
#     çıkış daima sunucunun IPv4'ünden
#   - İzinli alan adları listesi 15 dakikada bir GitHub'dan güncellenir (alan-guncelle.sh)
#   - Güvenlik duvarı (ufw): yalnız SSH ve 3128; fail2ban (SSH deneme saldırıları)
#   - Otomatik güvenlik güncellemeleri + gerekirse gece 04:30'da (UTC) yeniden başlatma
#   - Squid çökerse systemd yeniden başlatır
# =========================================================
set -euo pipefail

: "${PROXY_PASSWORD:?PROXY_PASSWORD gerekli}"
PROXY_USER="${PROXY_USER:-seltigo}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/mustafabahsimb-eng/hizlisatici-ai/main/infra/sabit-ip}"
ALAN_URL="${ALAN_URL:-https://raw.githubusercontent.com/mustafabahsimb-eng/hizlisatici-ai/main/infra/sabit-ip/izinli-alanlar.txt}"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
export DEBIAN_FRONTEND=noninteractive

log "Paketler kuruluyor"
apt-get update -q
[ "${SKIP_UPGRADE:-0}" = "1" ] || apt-get -y -q -o Dpkg::Options::="--force-confold" upgrade
apt-get install -y -q squid apache2-utils ufw fail2ban unattended-upgrades curl ca-certificates

OUT_IP="$(curl -4 -fsS --max-time 15 https://api.ipify.org)"
[[ "$OUT_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "IPv4 adresi bulunamadı: $OUT_IP"; exit 1; }
log "Sunucunun IPv4 adresi: $OUT_IP"

log "Squid ayarlanıyor"
curl -fsS --max-time 30 "$REPO_RAW/squid.conf" | sed "s/__OUT_IP__/$OUT_IP/" > /etc/squid/squid.conf.yeni
# Hetzner'de IPv4 doğrudan ağ kartındadır. Değilse (NAT arkası, ör. test makinesi) bağlama yapılamaz.
if ! ip -4 addr show | grep -qw "$OUT_IP"; then
  log "UYARI: $OUT_IP bu makinenin ağ kartında değil; çıkış adresi sabitlenmeden devam"
  sed -i 's/^tcp_outgoing_address /# tcp_outgoing_address /' /etc/squid/squid.conf.yeni
fi
htpasswd -bcm /etc/squid/passwd "$PROXY_USER" "$PROXY_PASSWORD" >/dev/null
chown root:proxy /etc/squid/passwd && chmod 640 /etc/squid/passwd

# İzinli alan adı güncelleyicisi
curl -fsS --max-time 30 "$REPO_RAW/alan-guncelle.sh" -o /usr/local/sbin/seltigo-alan-guncelle
chmod 755 /usr/local/sbin/seltigo-alan-guncelle
echo "ALAN_URL=$ALAN_URL" > /etc/default/seltigo-alan-guncelle
# İlk liste (squid henüz yeni ayarla çalışmıyor, yeniden yükleme yapmadan)
NO_RELOAD=1 ALAN_URL="$ALAN_URL" /usr/local/sbin/seltigo-alan-guncelle

mv /etc/squid/squid.conf.yeni /etc/squid/squid.conf
squid -k parse -f /etc/squid/squid.conf

mkdir -p /etc/systemd/system/squid.service.d
cat > /etc/systemd/system/squid.service.d/seltigo.conf <<'EOF'
[Service]
Restart=always
RestartSec=5
EOF

cat > /etc/systemd/system/seltigo-alan-guncelle.service <<'EOF'
[Unit]
Description=Seltigo izinli alan adlarini GitHub'dan guncelle
After=network-online.target
[Service]
Type=oneshot
EnvironmentFile=/etc/default/seltigo-alan-guncelle
ExecStart=/usr/local/sbin/seltigo-alan-guncelle
EOF
cat > /etc/systemd/system/seltigo-alan-guncelle.timer <<'EOF'
[Unit]
Description=Seltigo izinli alan adlari (15 dakikada bir)
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
RandomizedDelaySec=60
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable squid >/dev/null
systemctl restart squid
systemctl enable --now seltigo-alan-guncelle.timer >/dev/null

log "Güvenlik duvarı"
if [ "${SKIP_FIREWALL:-0}" != "1" ]; then
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 3128/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null
fi

# SSH anahtarı eklenmişse şifreyle girişi kapat
if [ -s /root/.ssh/authorized_keys ]; then
  echo "PasswordAuthentication no" > /etc/ssh/sshd_config.d/60-seltigo.conf
  systemctl reload ssh || systemctl reload sshd || true
fi

log "Otomatik güncellemeler"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52seltigo-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
  "${distro_id}:${distro_codename}";
  "${distro_id}:${distro_codename}-security";
  "${distro_id}ESMApps:${distro_codename}-apps-security";
  "${distro_id}ESM:${distro_codename}-infra-security";
  "${distro_id}:${distro_codename}-updates";
};
Unattended-Upgrade::Package-Blacklist {};
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
systemctl enable --now unattended-upgrades >/dev/null

# Son kontrol: proxy kendi üzerinden çıkış IP'sini görebiliyor mu
sleep 2
SEEN="$(curl -fsS --max-time 20 -x "http://127.0.0.1:3128" -U "$PROXY_USER:$PROXY_PASSWORD" https://api.ipify.org || true)"
if [ "$SEEN" = "$OUT_IP" ]; then
  log "TAMAM: proxy çalışıyor, çıkış IP'si $OUT_IP"
else
  log "UYARI: proxy denemesi beklenen IP'yi vermedi ('$SEEN'); journalctl -u squid ile bakın"
fi
echo "$OUT_IP" > /root/seltigo-sabit-ip.txt
