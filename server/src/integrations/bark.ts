import { createCipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

export type Priority = 'min' | 'low' | 'default' | 'high' | 'urgent';

/**
 * Bark interruption levels (iOS):
 *   passive        - added to Notification Center silently, screen stays dark
 *   active         - normal notification
 *   timeSensitive  - breaks through Focus modes
 *   critical       - rings even on silent (needs the critical-alert permission in Bark)
 */
type BarkLevel = 'passive' | 'active' | 'timeSensitive' | 'critical';

function levelFor(p: Priority): BarkLevel {
  switch (p) {
    case 'min':
    case 'low':
      return 'passive';
    case 'high':
      return 'timeSensitive';
    case 'urgent':
      return config.bark.criticalAlerts ? 'critical' : 'timeSensitive';
    default:
      return 'active';
  }
}

/**
 * End-to-end encryption, matching the Bark app's "AES256 / CBC" setting:
 *   - key: the 32-character string typed into the app (used as raw ASCII bytes)
 *   - iv:  16 random ASCII characters, generated per message, sent alongside
 *   - ciphertext: base64(AES-256-CBC(PKCS7(json)))
 * The Bark relay server and Apple's APNs only ever see ciphertext.
 */
export function encryptForBark(payload: object, key: string): { ciphertext: string; iv: string } {
  // Alphanumeric IV: the app treats the iv parameter as a text string.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const iv = Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join('');
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]).toString('base64');
  return { ciphertext, iv };
}

const RETRY_DELAYS_MS = [5_000, 30_000];
let warnedUnconfigured = false;

/** Push a notification to the phone via Bark (https://bark.day.app). Never throws. */
export async function notify(
  title: string,
  message: string,
  opts: { priority?: Priority } = {},
): Promise<boolean> {
  const { server, deviceKey, encryptionKey } = config.bark;
  if (!deviceKey || !encryptionKey) {
    if (!warnedUnconfigured) {
      console.warn('[notify] BARK_DEVICE_KEY / BARK_ENCRYPTION_KEY not set - notifications disabled');
      warnedUnconfigured = true;
    }
    console.warn(`[notify] skipped: ${title} - ${message}`);
    return false;
  }

  // Everything readable goes inside the ciphertext. Only the interruption level
  // stays in the clear, because iOS needs it before the app decrypts anything.
  const secret = {
    title,
    body: message,
    group: config.bark.group,
    sound: opts.priority === 'urgent' ? 'alarm' : undefined,
  };
  const { ciphertext, iv } = encryptForBark(secret, encryptionKey);
  const body = JSON.stringify({
    device_key: deviceKey,
    ciphertext,
    iv,
    level: levelFor(opts.priority ?? 'default'),
  });

  // Retry network errors and 5xx (e.g. Wi-Fi not up yet after a reboot), but not a
  // rejection from Bark such as a wrong device key.
  for (let attempt = 0; ; attempt++) {
    const result = await pushOnce(`${server.replace(/\/$/, '')}/push`, body);
    if (result !== 'retry') return result === 'ok';
    if (attempt >= RETRY_DELAYS_MS.length) {
      console.error(`[notify] giving up on: ${title}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}

async function pushOnce(url: string, body: string): Promise<'ok' | 'retry' | 'fail'> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[notify] Bark responded ${res.status}: ${text}`);
      return res.status >= 500 ? 'retry' : 'fail';
    }
    // bark-server replies {"code":200,...}; a non-200 code means it was rejected.
    try {
      const j = JSON.parse(text) as { code?: number; message?: string };
      if (j.code !== undefined && j.code !== 200) {
        console.error(`[notify] Bark rejected push: ${j.code} ${j.message ?? ''}`);
        return 'fail';
      }
    } catch {
      /* non-JSON body from a proxy; treat HTTP 2xx as success */
    }
    return 'ok';
  } catch (err) {
    console.error('[notify] failed:', (err as Error).message);
    return 'retry';
  }
}
