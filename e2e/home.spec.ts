import { expect, test } from "@playwright/test";
test("shows the organizer workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "tsudoi" })).toBeVisible();
  await expect(page.getByLabel("API トークン")).toBeVisible();
  await expect(page.getByRole("heading", { name: "QR 受付" })).toBeVisible();
});

test("routes a participant to the ticket screen", async ({ page }) => {
  await page.goto("/ticket");
  await expect(page.getByText("YOUR TICKET")).toBeVisible();
});

test("routes a visitor to an event registration screen", async ({ page }) => {
  await page.goto("/events/demo-event/register");
  await expect(page.getByText("EVENT REGISTRATION")).toBeVisible();
});
