import { describe, expect, it } from "vitest";
import { createIdentityKeyPair, createThreadKey, decryptMessage, derivePrfWrappingKey, encryptMessage, unwrapThreadKey, wrapThreadKey } from "../web/src/lib/e2ee";

describe("E2EE browser primitives", () => {
  it("encrypts and decrypts a message only with the same associated data", async () => {
    const key = await createThreadKey();
    const payload = await encryptMessage(key, "private attendee message", "thread-1");
    await expect(decryptMessage(key, payload, "thread-1")).resolves.toBe("private attendee message");
    await expect(decryptMessage(key, payload, "other-thread")).rejects.toThrow();
  });

  it("wraps a thread key for the recipient identity", async () => {
    const threadKey = await createThreadKey();
    const recipient = await createIdentityKeyPair();
    const envelope = await wrapThreadKey(threadKey, recipient.publicKey);
    const recovered = await unwrapThreadKey(envelope, recipient.privateKey);
    const payload = await encryptMessage(recovered, "readable by recipient", "thread-2");
    await expect(decryptMessage(threadKey, payload, "thread-2")).resolves.toBe("readable by recipient");
  });

  it("rejects unsupported message and key-envelope algorithms", async () => {
    const threadKey = await createThreadKey();
    await expect(decryptMessage(threadKey, { algorithm: "unknown" as "AES-GCM-256", ciphertext: "", iv: "" }, "thread-3")).rejects.toThrow("Unsupported message algorithm");
    const recipient = await createIdentityKeyPair();
    await expect(unwrapThreadKey({ algorithm: "unknown" as "ECDH-P256+AES-GCM-256", ephemeralPublicKey: {}, ciphertext: "", iv: "" }, recipient.privateKey)).rejects.toThrow("Unsupported envelope algorithm");
  });

  it("derives the same non-extractable wrapping key from a PRF result", async () => {
    const prfOutput = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const first = await derivePrfWrappingKey(prfOutput.buffer, salt.buffer);
    const second = await derivePrfWrappingKey(prfOutput.buffer, salt.buffer);
    expect(first.extractable).toBe(false);
    const payload = await encryptMessage(first, "device secret", "prf-key-test");
    await expect(decryptMessage(second, payload, "prf-key-test")).resolves.toBe("device secret");
  });
});
