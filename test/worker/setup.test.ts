import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("OIDC-only organizer setup", () => {
  it("starts with no organization or OIDC session", async () => {
    const status = await SELF.fetch("https://tsudoi.test/api/setup/status");
    await expect(status.json()).resolves.toEqual({ initialSetupRequired: true });
    const session = await SELF.fetch("https://tsudoi.test/api/session");
    expect(session.status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM organizations").first()).toEqual({ count: 0 });
  });

  it("does not expose organizer Passkey registration or login endpoints", async () => {
    for (const path of ["/api/session/options", "/api/session/verify", "/api/setup/initial-admin/options", "/api/setup/initial-admin/verify"]) {
      const response = await SELF.fetch(`https://tsudoi.test${path}`, { method: "POST" });
      expect(response.status).toBe(404);
    }
    const oidc = await SELF.fetch("https://tsudoi.test/api/oidc/status");
    await expect(oidc.json()).resolves.toEqual({ enabled: false });
  });
});
