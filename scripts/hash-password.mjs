// Prints a new js/auth-hash.js for the given password: node scripts/hash-password.mjs 'password' > js/auth-hash.js
import { pbkdf2Sync, randomBytes } from "node:crypto";

const pw = process.argv[2];
if (!pw) { console.error("usage: node scripts/hash-password.mjs 'password' > js/auth-hash.js"); process.exit(1); }
const salt = randomBytes(16), iterations = 600000;
const hash = pbkdf2Sync(Buffer.from(pw.normalize("NFC"), "utf8"), salt, iterations, 32, "sha256");
const cfg = { salt: salt.toString("base64"), iterations, hash: hash.toString("base64") };
console.log(`// PBKDF2-SHA256 of the access password. The password itself is never stored anywhere.
// To change it: node scripts/hash-password.mjs 'new password' > js/auth-hash.js
export default ${JSON.stringify(cfg)};`);
