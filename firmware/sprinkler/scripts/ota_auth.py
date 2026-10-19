# PlatformIO pre-script for the esp32-ota environment.
# Reads DEVICE_HOSTNAME and OTA_PASSWORD from include/config.h (which is gitignored),
# so the OTA password lives in one place and never ends up in platformio.ini.
Import("env")  # noqa: F821 (provided by PlatformIO)

import re
from pathlib import Path

config_h = Path(env.subst("$PROJECT_INCLUDE_DIR")) / "config.h"  # noqa: F821
if config_h.exists():
    text = config_h.read_text()

    def define(name):
        m = re.search(r'#define\s+%s\s+"([^"]*)"' % name, text)
        return m.group(1) if m else None

    host, password = define("DEVICE_HOSTNAME"), define("OTA_PASSWORD")
    if host:
        env.Replace(UPLOAD_PORT=host + ".local")  # noqa: F821
    if password:
        env.Append(UPLOAD_FLAGS=["--auth=" + password])  # noqa: F821
