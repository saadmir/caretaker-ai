#!/usr/bin/env bash
# Install or update the Caretaker AI server on Ubuntu/Debian. Run from the repo root:
#   sudo bash deploy/install.sh
# Safe to re-run: settings (.env), garden.md and data/ are kept.
set -euo pipefail

APP_DIR=/opt/caretaker-ai
APP_USER=caretaker
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OLD_DIR=/opt/smart-sprinkler   # the project's previous name

[[ $EUID -eq 0 ]] || { echo "Run with sudo"; exit 1; }

echo "==> Packages"
if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 20 )); then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v rsync >/dev/null || apt-get install -y rsync
# mDNS, so the ESP32s can find this machine as <hostname>.local without a fixed IP
command -v avahi-daemon >/dev/null || apt-get install -y avahi-daemon
echo "   node $(node -v)"

echo "==> Files"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/server/data"
rsync -a --delete --exclude node_modules --exclude dist --exclude data --exclude .env --exclude garden.md \
  "$REPO_DIR/server/" "$APP_DIR/server/"

# Coming from the old install? Bring its settings and history along (the old folder stays as a backup).
if [[ -d "$OLD_DIR/server" && ! -f "$APP_DIR/server/.env" ]]; then
  echo "   migrating settings and history from $OLD_DIR"
  systemctl stop sprinkler.service 2>/dev/null || true   # so state.json isn't written mid-copy
  cp -a "$OLD_DIR/server/.env" "$APP_DIR/server/.env"
  cp -a "$OLD_DIR/server/data/." "$APP_DIR/server/data/"
  [[ -f "$OLD_DIR/server/garden.md" ]] && cp -a "$OLD_DIR/server/garden.md" "$APP_DIR/server/garden.md"
fi

# Your garden description: the repo copy wins if you keep one; otherwise start from the template.
if [[ -f "$REPO_DIR/server/garden.md" ]]; then
  cp "$REPO_DIR/server/garden.md" "$APP_DIR/server/garden.md"
elif [[ ! -f "$APP_DIR/server/garden.md" ]]; then
  cp "$APP_DIR/server/garden.example.md" "$APP_DIR/server/garden.md"
fi

if [[ ! -f "$APP_DIR/server/.env" ]]; then
  cp "$APP_DIR/server/.env.example" "$APP_DIR/server/.env"
  MQTT_PW=$(openssl rand -hex 12)
  BARK_KEY=$(openssl rand -hex 16)   # 32 characters for AES-256
  # Port 80: the service is allowed to bind it (see caretaker.service)
  sed -i "s/^MQTT_PASSWORD=.*/MQTT_PASSWORD=$MQTT_PW/; s/^BARK_ENCRYPTION_KEY=.*/BARK_ENCRYPTION_KEY=$BARK_KEY/; s/^WEB_PORT=.*/WEB_PORT=80/" \
    "$APP_DIR/server/.env"
  echo "   Created .env with generated secrets:"
  echo "     MQTT_PASSWORD=$MQTT_PW         -> also put it in the firmware's include/config.h"
  echo "     BARK_ENCRYPTION_KEY=$BARK_KEY  -> Bark app: Push Encryption, AES256, CBC, this KEY"
  echo "   Then set LATITUDE, LONGITUDE and BARK_DEVICE_KEY in .env"
fi

echo "==> Build"
cd "$APP_DIR/server"
npm ci
npm run build
npm prune --omit=dev
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/server/.env"   # MQTT, Bark and Anthropic secrets

echo "==> Service"
if systemctl list-unit-files sprinkler.service >/dev/null 2>&1; then   # old service name
  systemctl disable --now sprinkler.service || true
  rm -f /etc/systemd/system/sprinkler.service
fi
cp "$REPO_DIR/deploy/caretaker.service" /etc/systemd/system/caretaker.service
systemctl daemon-reload
systemctl enable caretaker
systemctl restart caretaker

echo "==> Keep the laptop awake with the lid closed"
sed -i -E 's/^#?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/; s/^#?HandleLidSwitchDocked=.*/HandleLidSwitchDocked=ignore/' \
  /etc/systemd/logind.conf
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
echo "   (takes effect after a reboot, or: sudo systemctl restart systemd-logind)"

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "==> Firewall"
  ufw allow 1883/tcp comment 'caretaker mqtt'
  WEB_PORT=$(sed -n 's/^WEB_PORT=\([0-9]*\).*/\1/p' "$APP_DIR/server/.env")
  ufw allow "${WEB_PORT:-8080}/tcp" comment 'caretaker web'
  ufw allow 8266/tcp comment 'caretaker ESP32 OTA'   # the ESP32 connects back here during OTA
  ufw allow 5353/udp comment 'mDNS'
fi

echo
WEB_PORT=$(sed -n 's/^WEB_PORT=\([0-9]*\).*/\1/p' "$APP_DIR/server/.env")
[[ "${WEB_PORT:-8080}" == 80 ]] && URL="http://$(hostname).local" || URL="http://$(hostname).local:${WEB_PORT:-8080}"
echo "Done. Dashboard: $URL"
echo "Logs:      journalctl -u caretaker -f"
echo "Settings:  sudo nano $APP_DIR/server/.env && sudo systemctl restart caretaker"
