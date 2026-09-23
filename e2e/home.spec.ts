import { expect, test } from "@playwright/test";
test("shows mikaki setup or login without local Passkey controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "tsudoi" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /初期管理者を登録|ログイン/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Passkey でログイン" })).not.toBeVisible();
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
