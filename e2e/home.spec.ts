import { expect, test } from "@playwright/test";
test("shows initial setup or Passkey login without credential fields", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "tsudoi" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /初期管理者の Passkey を登録|Passkey でログイン/ })).toBeVisible();
  await expect(page.getByLabel("API トークン")).not.toBeVisible();
  await expect(page.getByLabel("組織 ID")).not.toBeVisible();
});

test("routes a participant to the ticket screen", async ({ page }) => {
  await page.goto("/ticket");
  await expect(page.getByText("YOUR TICKET")).toBeVisible();
});

test("routes a visitor to an event registration screen", async ({ page }) => {
  await page.goto("/events/demo-event/register");
  await expect(page.getByText("EVENT REGISTRATION")).toBeVisible();
});
