/**
 * Send one encrypted test notification using the settings in .env.
 *   npm run test-notify          (on the installed copy: node dist/cli/test-notify.js)
 * If the phone shows "Decryption Failed", the KEY / algorithm / mode in the
 * Bark app don't match BARK_ENCRYPTION_KEY + AES256 + CBC.
 */
import { notify } from '../integrations/bark.js';

const ok = await notify('Sprinkler test', `Encrypted test notification sent at ${new Date().toLocaleTimeString()}.`);
console.log(ok ? 'Sent - check your phone.' : 'Failed - see errors above.');
process.exit(ok ? 0 : 1);
