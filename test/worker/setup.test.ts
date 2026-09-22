import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("initial administrator setup", () => {
  it("requires a display name and stores an optional normalized email with the passkey challenge", async () => {
    const status = await SELF.fetch("https://tsudoi.test/api/setup/status");
    await expect(status.json()).resolves.toEqual({ initialSetupRequired: true });

    const invalid = await SELF.fetch("https://tsudoi.test/api/setup/initial-admin/options", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.test" }),
    });
    expect(invalid.status).toBe(400);

    const options = await SELF.fetch("https://tsudoi.test/api/setup/initial-admin/options", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Tsudoi Admin", email: " ADMIN@Example.Test ", avatarUrl: "data:image/png;base64,AA==" }),
    });
    expect(options.status).toBe(200);
    const { challengeId, options: registrationOptions } = await options.json<{ challengeId: string; options: { rp: { id: string }; user: { name: string; displayName: string } } }>();
    expect(registrationOptions).toMatchObject({ rp: { id: "localhost" }, user: { name: "admin@example.test", displayName: "Tsudoi Admin" } });
    await expect(env.DB.prepare("SELECT organization_name, display_name, email_normalized, avatar_url FROM initial_admin_challenges WHERE id = ?").bind(challengeId).first())
      .resolves.toEqual({ organization_name: "既定ワークスペース", display_name: "Tsudoi Admin", email_normalized: "admin@example.test", avatar_url: "data:image/png;base64,AA==" });
  });

  it("creates organizer authentication challenges without disclosing an account", async () => {
    const options = await SELF.fetch("https://tsudoi.test/api/session/options", { method: "POST" });
    expect(options.status).toBe(200);
    const { challengeId, options: authenticationOptions } = await options.json<{ challengeId: string; options: { rpId: string; challenge: string } }>();
    expect(authenticationOptions.rpId).toBe("localhost");
    await expect(env.DB.prepare("SELECT challenge FROM organizer_webauthn_challenges WHERE id = ?").bind(challengeId).first())
      .resolves.toEqual({ challenge: authenticationOptions.challenge });
  });
});
