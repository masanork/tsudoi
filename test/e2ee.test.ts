import { describe, expect, it } from "vitest";
import { createIdentityKeyPair, createThreadKey, decryptMessage, encryptMessage, unwrapThreadKey, wrapThreadKey } from "../web/src/lib/e2ee";

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
});
