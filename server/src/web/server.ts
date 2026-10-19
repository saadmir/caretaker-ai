import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, parseAiMode } from '../config.js';
import type { Sprinkler } from '../devices/sprinkler.js';
import type { Store } from '../store.js';
import type { WateringController } from '../watering/controller.js';
import { snapshot } from './snapshot.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

/** Dashboard + JSON API. Live updates go out over Server-Sent Events on /api/stream. */
export function startWeb(sprinkler: Sprinkler, watering: WateringController, store: Store) {
  const app = express();
  app.use(express.json());
  if (config.web.password) app.use(basicAuth(config.web.password));

  const current = () => snapshot(sprinkler, watering, store);
  const fail = (res: Response, status: number, err: unknown) => res.status(status).json({ error: (err as Error).message });

  app.get('/api/status', (_req, res) => res.json(current()));

  app.post('/api/valve', (req, res) => {
    const { action, minutes } = (req.body ?? {}) as { action?: string; minutes?: number | null };
    try {
      if (action === 'on') {
        const m = minutes == null ? config.schedule.defaultManualMinutes : Number(minutes);
        if (!Number.isFinite(m) || m < 0 || m > 240) throw new Error('minutes must be 0-240 (0 = until turned off)');
        watering.manualOn(m);
      } else if (action === 'off') {
        watering.manualOff();
      } else {
        return res.status(400).json({ error: 'action must be "on" or "off"' });
      }
      res.json({ ok: true });
    } catch (err) {
      fail(res, 503, err);
    }
  });

  app.post('/api/auto', (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    watering.setAutoEnabled(enabled);
    res.json({ ok: true });
  });

  app.post('/api/ai/mode', (req, res) => {
    try {
      watering.setAiMode(parseAiMode(String(req.body?.mode)));
      res.json({ ok: true });
    } catch (err) {
      fail(res, 400, err);
    }
  });

  app.post('/api/ai/decide', async (_req, res) => {
    try {
      res.json({ ok: true, decision: await watering.ai.decide('manual') });
    } catch (err) {
      res.status(503).json({ error: watering.ai.error ?? (err as Error).message });
    }
  });

  app.post('/api/notes', (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text || text.length > 500) return res.status(400).json({ error: 'Note must be 1-500 characters' });
    store.update({ notes: [{ at: new Date().toISOString(), text }, ...store.state.notes].slice(0, 50) });
    store.log('info', `Note added: ${text}`);
    watering.emit('change');
    res.json({ ok: true });
  });

  app.post('/api/notes/delete', (req, res) => {
    const at = String(req.body?.at ?? '');
    store.update({ notes: store.state.notes.filter((n) => n.at !== at) });
    watering.emit('change');
    res.json({ ok: true });
  });

  app.post('/api/weather/refresh', async (_req, res) => {
    await watering.refreshWeather();
    res.json({ ok: true });
  });

  app.get('/api/stream', liveUpdates(watering, current));
  app.use(express.static(publicDir));

  return app.listen(config.web.port, () => console.log(`[web] dashboard on http://0.0.0.0:${config.web.port}`));
}

/** Any username; the password must match WEB_PASSWORD. */
function basicAuth(password: string) {
  const expected = Buffer.from(password);
  return (req: Request, res: Response, next: NextFunction) => {
    const b64 = (req.headers.authorization ?? '').split(' ')[1] ?? '';
    const given = Buffer.from(Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':'));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Caretaker"').status(401).send('Auth required');
  };
}

/** SSE: send the full snapshot on connect and after every change (batched to 100 ms). */
function liveUpdates(watering: WateringController, current: () => object) {
  const clients = new Set<Response>();
  let pending: NodeJS.Timeout | null = null;
  watering.on('change', () => {
    pending ??= setTimeout(() => {
      pending = null;
      const msg = `data: ${JSON.stringify(current())}\n\n`;
      for (const c of clients) c.write(msg);
    }, 100);
  });
  setInterval(() => clients.forEach((c) => c.write(': keepalive\n\n')), 25_000);

  return (req: Request, res: Response) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(current())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  };
}
