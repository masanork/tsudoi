export type EncryptedPayload = {
  algorithm: "AES-GCM-256";
  ciphertext: string;
  iv: string;
};

export type KeyEnvelope = {
  algorithm: "ECDH-P256+AES-GCM-256";
  ephemeralPublicKey: JsonWebKey;
  ciphertext: string;
  iv: string;
};

const text = new TextEncoder();
const decoder = new TextDecoder();

export async function createThreadKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function encryptMessage(threadKey: CryptoKey, plaintext: string, associatedData: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text.encode(associatedData) }, threadKey, text.encode(plaintext));
  return { algorithm: "AES-GCM-256", ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

export async function decryptMessage(threadKey: CryptoKey, payload: EncryptedPayload, associatedData: string): Promise<string> {
  if (payload.algorithm !== "AES-GCM-256") throw new Error("Unsupported message algorithm");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(payload.iv), additionalData: text.encode(associatedData) }, threadKey, fromBase64(payload.ciphertext));
  return decoder.decode(plaintext);
}

export async function createIdentityKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
}

export async function exportPublicKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

export async function importPublicKey(key: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", key, { name: "ECDH", namedCurve: "P-256" }, true, []);
}

export async function wrapThreadKey(threadKey: CryptoKey, recipientPublicKey: CryptoKey): Promise<KeyEnvelope> {
  const ephemeral = await createIdentityKeyPair();
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: recipientPublicKey }, ephemeral.privateKey, 256);
  const wrappingKey = await crypto.subtle.importKey("raw", shared, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const rawThreadKey = await crypto.subtle.exportKey("raw", threadKey);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, rawThreadKey);
  return { algorithm: "ECDH-P256+AES-GCM-256", ephemeralPublicKey: await exportPublicKey(ephemeral.publicKey), ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

export async function unwrapThreadKey(envelope: KeyEnvelope, recipientPrivateKey: CryptoKey): Promise<CryptoKey> {
  if (envelope.algorithm !== "ECDH-P256+AES-GCM-256") throw new Error("Unsupported envelope algorithm");
  const peer = await importPublicKey(envelope.ephemeralPublicKey);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, recipientPrivateKey, 256);
  const wrappingKey = await crypto.subtle.importKey("raw", shared, "AES-GCM", false, ["decrypt"]);
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(envelope.iv) }, wrappingKey, fromBase64(envelope.ciphertext));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const output = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(output);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return output;
}
