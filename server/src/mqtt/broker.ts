import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { Aedes, type AuthenticateError } from 'aedes';

export interface BrokerOptions {
  port: number;
  username: string;
  password: string;
}

/**
 * MQTT broker embedded in the server process, so there's no Mosquitto to install.
 * Every ESP32 on the network connects here; the server talks to them through it.
 */
export class Broker {
  private aedes!: Aedes;
  private server!: Server;

  constructor(private readonly opts: BrokerOptions) {}

  async start(): Promise<void> {
    this.aedes = await Aedes.createBroker({
      authenticate: (_client, username, password, done) => {
        const ok =
          username === this.opts.username &&
          password !== undefined &&
          safeEqual(password.toString(), this.opts.password);
        if (ok) return done(null, true);
        const err = new Error('Bad username or password') as AuthenticateError;
        err.returnCode = 4;
        done(err, false);
      },
    });
    this.aedes.on('clientError', (client, err) => console.warn(`[mqtt] client ${client?.id} error: ${err.message}`));

    this.server = createServer(this.aedes.handle);
    await new Promise<void>((resolve) => this.server.listen(this.opts.port, resolve));
    console.log(`[mqtt] broker listening on :${this.opts.port}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.aedes.close(() => r()));
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Call `handler` with each message published on `topic` (including retained ones). */
  subscribe(topic: string, handler: (payload: string) => void): void {
    this.aedes.subscribe(
      topic,
      (packet, cb) => {
        handler(packet.payload.toString());
        cb();
      },
      () => {},
    );
  }

  publish(topic: string, payload: object | string, opts: { qos?: 0 | 1; retain?: boolean } = {}): void {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.aedes.publish(
      { cmd: 'publish', topic, payload: Buffer.from(body), qos: opts.qos ?? 1, retain: opts.retain ?? false, dup: false },
      (err) => err && console.error(`[mqtt] publish to ${topic} failed`, err),
    );
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
