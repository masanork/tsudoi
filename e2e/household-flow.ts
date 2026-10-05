import { randomBytes } from "node:crypto";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import jsQR from "jsqr";

type Fixture = { eventId: string; venueId: string; qrLink: string; person: { attendeeId: string; ticketId: string; ticketToken: string } };

function verifyCardPng(dataUrl: string, url: string) {
  expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
  expect(png.width).toBeGreaterThanOrEqual(320);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(decoded?.data).toBe(url);
}

export async function verifyHouseholdFlow(page: Page, context: BrowserContext, fixture: Fixture) {
  const { eventId, venueId, person, qrLink: originalQr } = fixture;
  const panel = page.getByRole("region", { name: "紙QRカード", exact: true });
  await panel.getByRole("combobox", { name: "カード発行対象の参加者", exact: true }).selectOption(person.attendeeId);
  const issued = page.waitForResponse((r) => r.url().endsWith(`/attendees/${person.attendeeId}/qr-cards`) && r.request().method() === "POST");
  await panel.getByRole("button", { name: "カードを発行", exact: true }).click();
  const issuance = await issued;
  expect(issuance.status()).toBe(201);
  const additional = (await issuance.json()).card;
  verifyCardPng(additional.qrPngDataUrl, additional.url);
  const printedImage = panel.getByRole("img", { name: "配布確認者 の紙QRカード", exact: true });
  await expect(printedImage).toBeVisible();
  verifyCardPng((await printedImage.getAttribute("src"))!, additional.url);
  await page.evaluate(() => {
    const open = window.open.bind(window);
    window.open = (...args) => {
      const popup = open(...args);
      if (popup) popup.print = () => { popup.document.documentElement.dataset.printCalled = "true"; };
      return popup;
    };
  });
  const printing = page.waitForEvent("popup");
  await panel.getByRole("button", { name: "印刷する", exact: true }).click();
  const printedCard = await printing;
  await expect(printedCard.getByRole("heading", { name: "配布確認者", exact: true })).toBeVisible();
  await expect(printedCard.locator("html")).toHaveAttribute("data-print-called", "true");
  verifyCardPng((await printedCard.getByRole("img", { name: "受付QRコード", exact: true }).getAttribute("src"))!, additional.url);
  await printedCard.screenshot({ path: "test-results/printed-card.png" });
  await printedCard.close();
  const resolve = (qrLink: string) => context.request.post(`/api/events/${eventId}/credentials/resolve`, { data: { qrLink, venueId } });
  expect((await resolve(originalQr)).status()).toBe(200);
  expect((await resolve(additional.url)).status()).toBe(200);

  await panel.locator("summary").filter({ hasText: "紛失カードを再発行" }).click();
  await panel.getByLabel("再発行の理由", { exact: true }).fill("紙カードの紛失を確認");
  let replacementBody: { card: { id: string; url: string; qrPngDataUrl: string }; revokedCount: number; legacyCredentialInvalidated: boolean };
  let replacementRequest: Record<string, unknown>;
  await page.route(`**/api/events/${eventId}/attendees/${person.attendeeId}/qr-cards/reissue`, async (route) => {
    replacementRequest = route.request().postDataJSON();
    const committed = await route.fetch();
    expect(committed.status()).toBe(201);
    replacementBody = await committed.json();
    await route.abort("failed");
  }, { times: 1 });
  await panel.getByRole("button", { name: "紛失カードを再発行", exact: true }).click();
  await expect(panel.getByRole("button", { name: "カード発行結果を再確認", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "カード発行結果を再確認", exact: true }).click();
  await expect(panel).toContainText("紛失カードの再発行を確認しました。");
  verifyCardPng((await printedImage.getAttribute("src"))!, replacementBody!.card.url);
  verifyCardPng(replacementBody.card.qrPngDataUrl, replacementBody.card.url);
  expect(replacementBody.revokedCount).toBeGreaterThanOrEqual(2);
  expect(replacementBody.legacyCredentialInvalidated).toBe(false);
  expect((await resolve(originalQr)).status()).toBe(404);
  expect((await resolve(additional.url)).status()).toBe(404);
  expect((await resolve(replacementBody.card.url)).status()).toBe(200);
  const possession = await context.request.post(`/public/tickets/${person.ticketId}/passkeys/options`, { data: { ticketToken: person.ticketToken } });
  expect(possession.status()).toBe(200);
  const laterCard = await context.request.post(`/api/events/${eventId}/attendees/${person.attendeeId}/qr-cards`, { data: {
    requestId: crypto.randomUUID(), qrToken: randomBytes(32).toString("base64url"), venueId,
  } });
  expect(laterCard.status()).toBe(201);
  const laterQr = (await laterCard.json()).card.url;
  const replayReplacement = await context.request.post(`/api/events/${eventId}/attendees/${person.attendeeId}/qr-cards/reissue`, { data: replacementRequest! });
  expect(replayReplacement.status()).toBe(200);
  expect((await replayReplacement.json()).card.id).toBe(replacementBody!.card.id);
  expect((await resolve(laterQr)).status()).toBe(200);

  const familyResponse = await context.request.post(`/api/events/${eventId}/attendees`, { data: { name: "世帯の同伴者", venueId } });
  expect(familyResponse.status()).toBe(201);
  const familyMember = await familyResponse.json();
  await page.goto("/");
  await page.locator("li").filter({ hasText: "平時と避難所の運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  const householdPanel = page.getByRole("region", { name: "世帯・代理受取", exact: true });
  await householdPanel.getByLabel("世帯名", { exact: true }).first().fill("受付した世帯");
  const creation = page.waitForResponse((r) => r.url().endsWith(`/events/${eventId}/households`) && r.request().method() === "POST");
  await householdPanel.getByRole("button", { name: "世帯を作成", exact: true }).click();
  const createdHousehold = await creation;
  expect(createdHousehold.status()).toBe(201);
  const householdId = (await createdHousehold.json()).household.id;
  await expect(householdPanel.getByRole("combobox", { name: "世帯を選択", exact: true })).toHaveValue(householdId);
  for (const attendeeId of [person.attendeeId, familyMember.attendeeId]) {
    await householdPanel.getByRole("combobox", { name: "世帯に追加する参加者", exact: true }).selectOption(attendeeId);
    const added = page.waitForResponse((r) => r.url().endsWith(`/households/${householdId}/members`) && r.request().method() === "POST");
    await householdPanel.getByRole("button", { name: "世帯メンバーを追加", exact: true }).click();
    expect((await added).status()).toBe(201);
    await expect(householdPanel.getByRole("button", { name: "世帯メンバーを追加", exact: true })).toBeDisabled();
  }
  const sameNamed = await context.request.post(`/api/events/${eventId}/households`, { data: { name: "受付した世帯" } });
  expect(sameNamed.status()).toBe(201);
  expect((await sameNamed.json()).household.id).not.toBe(householdId);
  const roundResponse = await context.request.post(`/api/events/${eventId}/distributions`, { data: { name: "世帯分の弁当", unit: "食", maxPerAttendee: 1 } });
  expect(roundResponse.status()).toBe(201);
  const roundId = (await roundResponse.json()).id;
  await page.goto("/");
  await page.locator("li").filter({ hasText: "平時と避難所の運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  await householdPanel.getByRole("combobox", { name: "世帯を選択", exact: true }).selectOption(householdId);
  await householdPanel.getByRole("combobox", { name: "世帯受取を行う会場", exact: true }).selectOption(venueId);
  await householdPanel.getByRole("combobox", { name: "配布回", exact: true }).selectOption(roundId);
  await householdPanel.getByRole("combobox", { name: "受取担当", exact: true }).selectOption(person.attendeeId);
  for (const name of ["配布確認者", "世帯の同伴者"]) {
    await householdPanel.getByRole("checkbox", { name, exact: true }).check();
    await householdPanel.getByLabel(`数量（${name}）`, { exact: true }).fill("1");
  }
  let group: { id: string; items: Array<{ claimId: string; attendeeId: string; remaining: number }> } | null = null;
  await page.route(`**/api/events/${eventId}/distributions/${roundId}/proxy-claims`, async (route) => {
    const committed = await route.fetch();
    expect(committed.status()).toBe(201);
    const body = await committed.json();
    expect(body.outcome).toBe("accepted");
    group = body.proxyClaim;
    await route.abort("failed");
  }, { times: 1 });
  await householdPanel.getByRole("button", { name: "世帯分を受け取る（2人）", exact: true }).click();
  await expect(householdPanel.getByRole("button", { name: "受取結果を再確認", exact: true })).toBeEnabled();
  await householdPanel.getByRole("button", { name: "受取結果を再確認", exact: true }).click();
  await expect(householdPanel).toContainText("対象 2 人分を一括で記録しました。");
  expect(group).toBeTruthy();
  expect(group!.items).toHaveLength(2);
  expect(group!.items.every((item) => item.remaining === 0)).toBe(true);
  for (const item of group!.items) {
    const rejectedCancel = await context.request.post(`/api/events/${eventId}/distributions/${roundId}/claims/${item.claimId}/reverse`, { data: { reason: "一部だけの取消を防止" } });
    expect(rejectedCancel.status()).toBe(409);
    expect((await rejectedCancel.json()).error).toBe("proxy_claim_requires_group_reverse");
  }
  const thirdResponse = await context.request.post(`/api/events/${eventId}/attendees`, { data: { name: "未受取の同伴者", venueId } });
  expect(thirdResponse.status()).toBe(201);
  const third = await thirdResponse.json();
  expect((await context.request.post(`/api/events/${eventId}/households/${householdId}/members`, { data: { attendeeId: third.attendeeId } })).status()).toBe(201);
  const mixed = await context.request.post(`/api/events/${eventId}/distributions/${roundId}/proxy-claims`, { data: {
    requestId: crypto.randomUUID(), householdId, collectorId: person.attendeeId, venueId,
    items: [{ attendeeId: person.attendeeId, quantity: 1 }, { attendeeId: third.attendeeId, quantity: 1 }],
  } });
  expect(mixed.status()).toBe(201);
  expect((await mixed.json()).outcome).toBe("limit_reached");
  const householdState = await (await context.request.get(`/api/events/${eventId}/households/${householdId}?distributionId=${roundId}&venueId=${venueId}`)).json();
  expect(householdState.household.members.find((member: { attendeeId: string }) => member.attendeeId === third.attendeeId).used).toBe(0);
  // Reload the round to verify failed attempts are visible but cannot be reversed.
  await householdPanel.getByRole("combobox", { name: "配布回", exact: true }).selectOption("");
  await householdPanel.getByRole("combobox", { name: "配布回", exact: true }).selectOption(roundId);
  const proxyHistory = householdPanel.getByRole("region", { name: "世帯受取履歴", exact: true });
  await expect(proxyHistory).toContainText("上限超過（未配布）");
  const failed = proxyHistory.locator("ol > li").filter({ hasText: "上限超過（未配布）" });
  await expect(failed.locator("summary")).toHaveCount(0);
  await proxyHistory.locator("summary").filter({ hasText: "世帯受取をまとめて取り消す" }).click();
  await proxyHistory.getByLabel("取消理由", { exact: true }).fill("世帯全員分の受取を訂正");
  await proxyHistory.getByRole("button", { name: "取消を確定", exact: true }).click();
  await expect(householdPanel).toContainText("世帯受取をまとめて取り消しました。");
  const restored = await (await context.request.get(`/api/events/${eventId}/households/${householdId}?distributionId=${roundId}&venueId=${venueId}`)).json();
  expect(restored.household.members.every((member: { used: number; remaining: number }) => member.used === 0 && member.remaining === 1)).toBe(true);
  expect((await context.request.post(`/api/events/${eventId}/distributions/${roundId}/proxy-claims/${group!.id}/reverse`, { data: { reason: "再送しても二重に戻さない" } })).status()).toBe(409);
  await householdPanel.scrollIntoViewIfNeeded();
  await householdPanel.screenshot({ path: "test-results/household-mobile.png" });
  return { ...fixture, qrLink: replacementBody.card.url as string, householdId, familyMember, roundId };
}
