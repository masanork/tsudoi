import { describe, expect, it } from "vitest";
import { app } from "../src/index";
const env = { APP_ORIGIN: "https://tsudoi.test" } as unknown as Cloudflare.Env;

describe("Worker edge routes", () => {
  it("reports a health check without database access", async () => {
    const response = await app.request("https://tsudoi.test/api/health", undefined, env);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects oversized API payloads before route handling", async () => {
    const response = await app.request(new Request("https://tsudoi.test/api/health", { method: "POST", headers: { "content-length": "1000001" } }), undefined, env);
    expect(response.status).toBe(413);
  });

  it("rejects organization API calls without a bearer token", async () => {
    const response = await app.request("https://tsudoi.test/api/organizations/org/events", undefined, env);
    expect(response.status).toBe(401);
  });
});
