import { expect, test } from "@playwright/test";
test("shows the organizer workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "tsudoi" })).toBeVisible();
  await expect(page.getByLabel("API トークン")).toBeVisible();
  await expect(page.getByRole("heading", { name: "QR 受付" })).toBeVisible();
});
