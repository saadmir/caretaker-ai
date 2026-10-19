// Loaded before the tests (see "test" in package.json): fixed settings, no .env needed.
Object.assign(process.env, {
  TIMEZONE: 'America/Los_Angeles',
  LATITUDE: '0',
  LONGITUDE: '0',
  MQTT_PASSWORD: 'test',
  BARK_DEVICE_KEY: '',
  BARK_ENCRYPTION_KEY: '',
  ANTHROPIC_API_KEY: '',
});
