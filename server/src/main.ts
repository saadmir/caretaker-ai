import { config } from './config.js';
import { Sprinkler } from './devices/sprinkler.js';
import { notify } from './integrations/bark.js';
import { Broker } from './mqtt/broker.js';
import { Store } from './store.js';
import { WateringController } from './watering/controller.js';
import { startWeb } from './web/server.js';

// Caretaker AI server: starts the MQTT broker, connects the devices, and serves the dashboard.

async function main() {
  console.log(`[boot] Caretaker AI server, TZ=${config.timezone}`);
  const store = new Store(config.dataDir, { autoEnabled: config.schedule.autoEnabledDefault, aiMode: config.ai.defaultMode });

  const broker = new Broker(config.mqtt);
  await broker.start();
  const sprinklers = config.zones.map((z) => new Sprinkler(broker, config.mqtt.topicBase, z.id, config.flow.pulsesPerLiter));

  const watering = new WateringController(sprinklers, store);
  watering.start();
  const http = startWeb(watering, store);

  store.log('info', 'Server started');
  void notify('Caretaker server started', `Dashboard on port ${config.web.port}.`, { priority: 'low' });

  const shutdown = async (signal: string) => {
    console.log(`[boot] ${signal}, shutting down`);
    watering.stop();
    http.close();
    await broker.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
