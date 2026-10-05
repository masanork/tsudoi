import { expect, type BrowserContext, type Page } from "@playwright/test";

/** Runs inside the reception test's authenticated organizer context. */
export async function verifyDistributionFlow(page: Page, context: BrowserContext) {
  page.setDefaultTimeout(15_000);
  const created = await context.request.post("/api/events", { data: {
    name: "平時と避難所の運用検証", startsAt: "2026-12-13", registrationMode: "hybrid",
  } });
  expect(created.status()).toBe(201);
  const { id: eventId } = await created.json();
  const venue = await context.request.post(`/api/events/${eventId}/venues`, { data: { name: "支援窓口" } });
  expect(venue.status()).toBe(201);
  const { id: venueId } = await venue.json();
  const response = await context.request.post(`/api/events/${eventId}/attendees`, { data: { name: "配布確認者", venueId } });
  expect(response.status()).toBe(201);
  const person = await response.json();
  const qrLink = `http://localhost:4173/public/tickets/${person.ticketId}/check-in/${person.qrToken}`;
  const checkedIn = await context.request.post(`/api/tickets/${person.ticketId}/check-in`, { data: { ticketToken: person.qrToken, venueId } });
  expect(checkedIn.status()).toBe(200);

  await page.goto("/");
  await page.locator("li").filter({ hasText: "平時と避難所の運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  const distribution = page.getByRole("region", { name: "配布管理", exact: true });
  await distribution.getByLabel("配布するもの", { exact: true }).fill("昼食");
  await distribution.getByLabel("単位", { exact: true }).fill("食");
  await distribution.getByLabel("1人あたり上限", { exact: true }).fill("2");
  await distribution.getByRole("button", { name: "配布回を作成", exact: true }).click();
  await distribution.getByRole("button", { name: /^昼食/ }).click();
  await distribution.getByText("チケットQRから参加者を確認", { exact: true }).click();
  await distribution.getByRole("combobox", { name: "受け渡し会場", exact: true }).selectOption(venueId);
  await distribution.getByLabel("チケットの受付QRリンク", { exact: true }).fill(qrLink);
  await distribution.getByRole("button", { name: "参加者を確認", exact: true }).click();
  await distribution.getByRole("combobox", { name: "受け渡し会場", exact: true }).selectOption(venueId);
  await distribution.getByLabel("数量", { exact: true }).fill("2");
  const claimed = page.waitForResponse((r) => /\/distributions\/[^/]+\/claims$/.test(r.url()) && r.request().method() === "POST");
  await distribution.getByRole("button", { name: /配布確認者.*渡したことを記録/ }).click();
  expect((await claimed).status()).toBe(201);
  await expect(distribution).toContainText("配布確認者");

  const rounds = await (await context.request.get(`/api/events/${eventId}/distributions`)).json();
  const lunch = rounds.distributions.find((round: { name: string }) => round.name === "昼食");
  expect(lunch).toBeTruthy();
  const duplicate = await context.request.post(`/api/events/${eventId}/distributions/${lunch.id}/claims`, {
    data: { requestId: crypto.randomUUID(), qrLink, quantity: 1, venueId },
  });
  expect((await duplicate.json()).outcome).toBe("limit_reached");
  await distribution.getByRole("button", { name: /^昼食/ }).click();
  const rejectedAttempt = distribution.locator("article.distribution-claim").filter({ hasText: "上限超過・未配布" });
  await expect(rejectedAttempt).toHaveCount(1);
  await expect(rejectedAttempt.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);

  // A round added after lunch accepts the same, already checked-in QR.
  await distribution.getByLabel("配布するもの", { exact: true }).fill("夕食");
  await distribution.getByLabel("単位", { exact: true }).fill("食");
  await distribution.getByLabel("1人あたり上限", { exact: true }).fill("1");
  await distribution.getByRole("button", { name: "配布回を作成", exact: true }).click();
  await distribution.getByRole("button", { name: /^夕食/ }).click();
  const qrInput = distribution.getByLabel("チケットの受付QRリンク", { exact: true });
  if (!await qrInput.isVisible()) await distribution.getByText("チケットQRから参加者を確認", { exact: true }).click();
  await distribution.getByRole("combobox", { name: "受け渡し会場", exact: true }).selectOption(venueId);
  await qrInput.fill(qrLink);
  await distribution.getByRole("button", { name: "参加者を確認", exact: true }).click();
  await distribution.getByRole("combobox", { name: "受け渡し会場", exact: true }).selectOption(venueId);
  await distribution.getByLabel("数量", { exact: true }).fill("1");
  let committedClaimId = "";
  // The server commits, then its response is lost. A retry must reuse the operation.
  await page.route(`**/api/events/${eventId}/distributions/*/claims`, async (route) => {
    const committed = await route.fetch();
    expect(committed.status()).toBe(201);
    committedClaimId = (await committed.json()).claim.id;
    await route.abort("failed");
  }, { times: 1 });
  await distribution.getByRole("button", { name: /配布確認者.*渡したことを記録/ }).click();
  await expect(distribution.getByRole("button", { name: /再試行|再確認/ })).toBeEnabled();
  const dinnerClaimed = page.waitForResponse((r) => (/\/distributions\/[^/]+\/claims$/.test(r.url()) && r.request().method() === "POST")
    || (/\/claims\/by-request\/[^/]+$/.test(r.url()) && r.status() === 200));
  await distribution.getByRole("button", { name: /再試行|再確認/ }).click();
  const retried = await dinnerClaimed;
  expect(retried.status()).toBe(200);
  expect((await retried.json()).claim.id).toBe(committedClaimId);

  await distribution.locator("article.distribution-claim").getByRole("button", { name: "取消", exact: true }).click();
  const reversalDialog = page.getByRole("dialog", { name: "配布記録を取り消す" });
  await reversalDialog.getByLabel("取消理由", { exact: true }).fill("受け渡し前の入力誤り");
  await reversalDialog.getByRole("button", { name: "理由を記録して取消", exact: true }).click();
  const reversedClaim = distribution.locator("article.distribution-claim").filter({ hasText: "取消済み" });
  await expect(reversedClaim).toContainText("取消理由: 受け渡し前の入力誤り");
  const dinner = rounds.distributions.find((round: { name: string }) => round.name === "夕食")
    ?? (await (await context.request.get(`/api/events/${eventId}/distributions`)).json()).distributions.find((round: { name: string }) => round.name === "夕食");
  const restored = await context.request.post(`/api/events/${eventId}/distributions/${dinner.id}/claims`, {
    data: { requestId: crypto.randomUUID(), qrLink, quantity: 1, venueId },
  });
  expect(restored.status()).toBe(201);
  expect((await restored.json()).outcome).toBe("accepted");

  const roster = await (await context.request.get(`/api/events/${eventId}/roster`)).json();
  expect(roster.attendees.find((attendee: { id: string }) => attendee.id === person.attendeeId).ticket_status).toBe("checked_in");
  await page.setViewportSize({ width: 390, height: 844 });
  await distribution.screenshot({ path: "test-results/distribution-mobile.png" });
  return { eventId, venueId, person, qrLink };
}
