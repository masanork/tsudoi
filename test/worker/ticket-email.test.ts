import jsQR from "jsqr";
import { PNG } from "pngjs";
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";

type SentEmail = {
  to: string;
  from: { email: string; name: string };
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{
    content: Uint8Array | ArrayBuffer | string;
    filename: string;
    type: string;
    disposition: string;
    contentId?: string;
  }>;
};

const appOrigin = "https://tsudoi.test";

function runQueue(body: unknown, send: ReturnType<typeof vi.fn>) {
  const message = { body, ack: vi.fn(), retry: vi.fn() };
  const batch = { queue: "test-notifications", messages: [message], ackAll: vi.fn(), retryAll: vi.fn() };
  const workerEnv = { ...env, APP_ORIGIN: appOrigin, EMAIL_FROM: "noreply@example.test", EMAIL: { send } } as unknown as Cloudflare.Env;
  return worker.queue!(batch as unknown as MessageBatch, workerEnv);
}

async function readPng(content: Uint8Array | ArrayBuffer) {
  const bytes = new Uint8Array(content instanceof ArrayBuffer ? content : content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = await new Promise<PNG>((resolve, reject) => {
    new PNG().parse(Buffer.from(bytes), (error, image) => error ? reject(error) : resolve(image));
  });
  expect(png.width).toBe(640);
  expect(png.height).toBe(640);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(decoded).not.toBeNull();
  return { bytes, data: decoded!.data };
}

async function insertLegacyLinkFixture() {
  const organizationId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const attendeeId = crypto.randomUUID();
  const ticketId = crypto.randomUUID();
  const magicToken = `magic_${crypto.randomUUID()}`;
  const linkTokenHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(magicToken)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const ticketTokenHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`possession_${crypto.randomUUID()}`)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(organizationId, "Ticket email test"),
    env.DB.prepare("INSERT INTO events (id, organization_id, name, starts_at, ends_at, registration_mode, status) VALUES (?, ?, ?, ?, ?, 'hybrid', 'published')")
      .bind(eventId, organizationId, "Legacy fallback event", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
    env.DB.prepare("INSERT INTO attendees (id, organization_id, event_id, name, email_normalized, registration_source) VALUES (?, ?, ?, ?, ?, 'public_form')")
      .bind(attendeeId, organizationId, eventId, "Fallback guest", "fallback@example.test"),
    env.DB.prepare("INSERT INTO tickets (id, attendee_id, event_id, token_hash, token_key_id) VALUES (?, ?, ?, ?, 'possession-v2')")
      .bind(ticketId, attendeeId, eventId, ticketTokenHash),
    env.DB.prepare("INSERT INTO magic_links (id, attendee_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, 'ticket', datetime('now', '+1 hour'))")
      .bind(crypto.randomUUID(), attendeeId, linkTokenHash),
  ]);
  return { ticketId, magicToken };
}

describe("ticket email QR attachment", () => {
  it("sends a decodable 640px inline PNG whose QR is the check-in URL, not the Passkey token", async () => {
    const checkInUrl = `${appOrigin}/public/tickets/${crypto.randomUUID()}/check-in/qr_only_${crypto.randomUUID()}`;
    const magicToken = `magic_${crypto.randomUUID()}`;
    const possessionToken = `possession_${crypto.randomUUID()}`;
    const link = `${appOrigin}/public/magic-links/${magicToken}`;
    const send = vi.fn<(email: SentEmail) => Promise<void>>().mockResolvedValue(undefined);

    await runQueue({ type: "ticket_link", to: "guest@example.test", eventName: "Inline QR event", link, ticketUrl: checkInUrl }, send);

    expect(send).toHaveBeenCalledTimes(1);
    const email = send.mock.calls[0]![0];
    expect(email.to).toBe("guest@example.test");
    expect(email.attachments).toHaveLength(1);
    const image = email.attachments![0]!;
    expect(image).toMatchObject({ filename: "tsudoi-ticket-qr.png", type: "image/png", disposition: "inline", contentId: "tsudoi-ticket-qr" });
    expect(email.html).toContain('src="cid:tsudoi-ticket-qr"');
    expect(email.text).toContain("inline QR image");
    expect(image.content).toBeInstanceOf(Uint8Array);
    const qr = await readPng(image.content as Uint8Array);
    expect(qr.data).toBe(checkInUrl);
    expect(qr.data).not.toContain(magicToken);
    expect(qr.data).not.toContain(possessionToken);
    expect(email.html).toContain(link);
    expect(email.text).toContain(link);
  });

  it("keeps the legacy ticket-link fallback and leaves announcement messages without attachments", async () => {
    const { ticketId, magicToken } = await insertLegacyLinkFixture();
    const ticketSend = vi.fn<(email: SentEmail) => Promise<void>>().mockResolvedValue(undefined);
    const legacyLink = `${appOrigin}/public/magic-links/${magicToken}`;

    await runQueue({ type: "ticket_link", to: "fallback@example.test", eventName: "Legacy fallback event", link: legacyLink }, ticketSend);

    expect(ticketSend).toHaveBeenCalledTimes(1);
    const fallbackEmail = ticketSend.mock.calls[0]![0];
    const fallbackQr = await readPng(fallbackEmail.attachments![0]!.content as Uint8Array);
    expect(new URL(fallbackQr.data).pathname).toMatch(new RegExp(`^/public/tickets/${ticketId}/check-in/`));
    expect(fallbackQr.data).not.toContain(magicToken);
    expect(fallbackEmail.html).toContain('src="cid:tsudoi-ticket-qr"');

    const announcementSend = vi.fn<(email: SentEmail) => Promise<void>>().mockResolvedValue(undefined);
    await runQueue({ type: "event_announcement", to: "guest@example.test", eventName: "Event", subject: "Update", message: "Doors open at 10." }, announcementSend);
    expect(announcementSend).toHaveBeenCalledTimes(1);
    expect(announcementSend.mock.calls[0]![0]).toMatchObject({ text: "Doors open at 10.", html: "<p>Doors open at 10.</p>" });
    expect(announcementSend.mock.calls[0]![0].attachments).toBeUndefined();
  });
});
