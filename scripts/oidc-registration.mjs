import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [originValue, directoryValue, kid] = process.argv.slice(2);
if (!originValue || !directoryValue || !kid || !/^[A-Za-z0-9._-]{1,64}$/.test(kid)) {
  console.error("Usage: node scripts/oidc-registration.mjs <https-origin> <new-private-directory> <key-id>");
  process.exit(2);
}
const origin = new URL(originValue);
if (origin.protocol !== "https:" || origin.origin !== originValue || origin.username || origin.password) {
  console.error("The RP origin must be a canonical HTTPS origin without a path or trailing slash.");
  process.exit(2);
}
const directory = resolve(directoryValue);
mkdirSync(directory, { mode: 0o700 });
const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await webcrypto.subtle.exportKey("jwk", keys.privateKey);
const publicJwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
const clientId = randomUUID();
const registration = {
  client_id: clientId,
  sector_identifier: origin.hostname,
  redirect_uris: [`${origin.origin}/api/oidc/callback`],
  key: { kid, jwk: { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y } },
};
writeFileSync(`${directory}/private.jwk`, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
writeFileSync(`${directory}/bootstrap-token.txt`, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
writeFileSync(`${directory}/registration.json`, `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ clientId, keyId: kid, registrationFile: `${directory}/registration.json`, privateKeyFile: `${directory}/private.jwk`, bootstrapTokenFile: `${directory}/bootstrap-token.txt` }));
