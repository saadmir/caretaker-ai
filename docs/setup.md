# Setup

The order that works: wire it, install the server, flash the ESP32, test, then add the AI.

## 1. Wire it

Follow [hardware.md](hardware.md). You also need a **24 VAC plug-in transformer**. The
relay is only a switch; it doesn't make 24 V.

## 2. Install the server

On an always-on Ubuntu/Debian machine (an old laptop is perfect):

```bash
git clone <this repo> && cd caretaker-ai
cp server/garden.example.md server/garden.md && nano server/garden.md   # describe your garden (gitignored)
sudo bash deploy/install.sh
```

The installer:
- installs Node 22, rsync and avahi (mDNS),
- creates a `caretaker` system user,
- builds the server into `/opt/caretaker-ai`,
- generates an MQTT password and a Bark encryption key,
- installs and starts the `caretaker` systemd service,
- stops the laptop from sleeping when the lid closes,
- serves the dashboard on port 80. The service runs as an unprivileged user that has only one extra right: binding ports below 1024 (`CAP_NET_BIND_SERVICE`),
- opens the firewall ports (MQTT 1883, web 80, OTA 8266, mDNS 5353).

It's safe to re-run for updates. Your `.env`, `garden.md` and `data/` are kept.

Then:

1. **Settings.** Run `sudo nano /opt/caretaker-ai/server/.env`:
   - set `LATITUDE` and `LONGITUDE` (required) and `TIMEZONE`,
   - check the rest,
   - then run `sudo systemctl restart caretaker`.
2. **Server address.** No fixed IP is needed. The ESP32 finds the server by its mDNS name `<hostname>.local`, and looks it up again on every reconnect. Check it with `avahi-resolve -4 -n $(hostname).local`.
3. **Logs:** `journalctl -u caretaker -f`

### Phone notifications (Bark, iOS)

1. Install **[Bark – Custom Notifications](https://apps.apple.com/us/app/bark-custom-notifications/id1403753865)** and allow notifications.
2. Copy your **device key** from the app. It's the random string in the example URLs (`https://api.day.app/<device key>/...`). Put it in `.env` as `BARK_DEVICE_KEY`.
3. In the app, open **Push Encryption**:
   - choose **AES256** and **CBC**,
   - for the KEY, enter the `BARK_ENCRYPTION_KEY` value from `.env`,
   - if the IV field can't be left empty, enter any 16 characters (the server sends a fresh random IV with each message).
4. Restart the service, then send a test:
   `cd /opt/caretaker-ai/server && sudo -u caretaker node dist/cli/test-notify.js`.
   "Decryption Failed" on the phone means the key or settings don't match.
5. Optional: to make urgent alerts ring even on silent, allow **Critical Alerts** for Bark in iOS Settings and set `BARK_CRITICAL_ALERTS=true`.

Messages are encrypted on the server, so the Bark relay and Apple only see ciphertext.
Only the alert level travels in the clear, because iOS needs it before decrypting. To
avoid the public relay entirely, self-host [bark-server](https://github.com/Finb/bark-server)
and set `BARK_SERVER`.

## 3. Flash the ESP32

```bash
sudo apt install -y pipx && pipx install platformio && pipx ensurepath   # then open a new terminal
sudo usermod -aG dialout $USER        # serial port access; log out and in once

cd firmware/sprinkler
cp include/config.example.h include/config.h
nano include/config.h                 # Wi-Fi, MQTT_HOST (<server>.local), MQTT_PASSWORD from .env, OTA_PASSWORD
pio run -t upload                     # ESP32 plugged in over USB
pio device monitor                    # watch it connect (Ctrl+C to exit)
```

- **Upload stalls at `Connecting.....`:** hold the ESP32's **BOOT** button until writing starts.
- **Later updates over Wi-Fi:** run `pio run -e esp32-ota -t upload`. The host name and password come from `config.h` (`scripts/ota_auth.py`). The ESP32 connects back on TCP port 8266, which the installer opens.

## 4. Test

1. **Bench test:** follow [hardware.md §1c](hardware.md#1c-bench-test-before-connecting-the-valve). The relay should click, with no transformer connected yet.
2. **Dashboard test:**
   - Open `http://<server>.local` on your phone, turn the sprinkler on, then off. You should get two notifications.
   - On iPhone, use **Safari**. Chrome on iOS can't reach LAN addresses without the Local Network permission (Settings → Apps → Chrome → Local Network).
   - Share → Add to Home Screen makes it feel like an app.
3. **Water test:** plug in the transformer and repeat with water.

**Without hardware.** Use the simulator from a checkout of the repo:

```bash
cd server && npm install && cp .env.example .env   # set LATITUDE, LONGITUDE, MQTT_PASSWORD
npm run dev                                        # terminal 1
npm run simulate                                   # terminal 2 (SIM_FLOW_GPM=0 / SIM_LEAK_GPM=1 to test alerts)
npm test
```

## 5. Turn on the AI gardener

1. **Get an API key** from [platform.claude.com](https://platform.claude.com). API billing is separate from a claude.ai subscription. Set a monthly spend limit.
2. **Add it to the server:** put `ANTHROPIC_API_KEY=` in `/opt/caretaker-ai/server/.env`, then run `sudo systemctl restart caretaker`.
3. **Try it:** tap **Ask AI now** on the dashboard. It starts in **Advise** mode: it decides and notifies, but doesn't water.
4. **Switch to Auto** once you trust its advice.

[ai-gardener.md](ai-gardener.md) covers the details. With a flow meter connected, the
gallon numbers are measured. Without one, set `EMITTER_COUNT` and `EMITTER_GPH` in `.env`.

## Access from outside the home

The dashboard is meant for your LAN, so don't port-forward it. For remote access, put the
server and your phone on [Tailscale](https://tailscale.com), and set `WEB_PASSWORD` if
others share your network. Notifications work anywhere without this.
