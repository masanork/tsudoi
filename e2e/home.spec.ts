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
  await expect(page.getByRole("button", { name: "Passkey でログイン" })).toBeVisible();
});

test("routes an invitee to Passkey enrollment", async ({ page }) => {
  await page.goto("/invite/sample-token");
  await expect(page.getByRole("heading", { name: "tsudoi への招待" })).toBeVisible();
});

test("routes a visitor to an event registration screen", async ({ page }) => {
  await page.goto("/events/demo-event/register");
  await expect(page.getByText("EVENT REGISTRATION")).toBeVisible();
});

test("explains available options when an organizer has no passkey", async ({ page }) => {
  await page.route("**/api/setup/status", (route) => route.fulfill({ json: { initialSetupRequired: false } }));
  await page.route("**/api/session", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.goto("/");
  await page.getByText("Passkey が見つからない場合").click();
  await expect(page.getByText("招待は元のアカウントの復旧ではありません。", { exact: false })).toBeVisible();
  await expect(page.getByText("現在はこの画面から元の管理者アカウントを復旧できません。", { exact: false })).toBeVisible();
});

test("explains how a participant can retrieve a ticket without a passkey", async ({ page }) => {
  await page.goto("/ticket");
  await page.getByText("Passkey が見つからない場合").click();
  await expect(page.getByText("イベントの主催者に再送を依頼してください。", { exact: false })).toBeVisible();
  await expect(page.getByText("新しい Passkey を追加する機能は、現在この画面にはありません。", { exact: false })).toBeVisible();
});
