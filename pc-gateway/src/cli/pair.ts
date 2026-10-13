// Run on the PC: `npm run pair`. Prints a one-time code (valid 5 minutes) to enter on the phone.
import { AuthService } from "../api/auth.js";
import { loadConfig, loadDotEnv } from "../config.js";
import { openDb } from "../storage/sqlite.js";

loadDotEnv();
const config = loadConfig();
const db = openDb(config.dbPath);
const { code, expiresAt } = new AuthService(db).createPairingCode();
db.close();

console.log(`\nPairing code: ${code}`);
console.log(`Expires:      ${new Date(expiresAt).toLocaleTimeString()} (one use)`);
console.log(`Gateway:      http://${config.host}:${config.port}  (phone reaches it via your tailnet URL)\n`);
