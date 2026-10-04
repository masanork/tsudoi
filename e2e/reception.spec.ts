import { expect, test, type Locator } from "@playwright/test";

async function fillAnswers(form: Locator, company: string) {
  await form.getByLabel("所属（必須）", { exact: true }).fill(company);
  await form.getByLabel("備考（必須）", { exact: true }).fill("受付で確認");
  await form.getByLabel("人数（必須）", { exact: true }).fill("0");
  await form.getByLabel("参加日（必須）", { exact: true }).fill("2026-12-10");
  await form.getByLabel("区分（必須）", { exact: true }).selectOption("一般");
  await form.getByRole("group", { name: "関心（必須）", exact: true }).getByLabel("交流", { exact: true }).check();
  await form.getByLabel("確認済み（必須）", { exact: true }).check();
  await form.getByLabel("規約に同意（必須）", { exact: true }).check();
  // Optional values that were filled and then cleared must be omitted.
  await form.getByLabel("任意区分", { exact: true }).selectOption("一般");
  await form.getByLabel("任意区分", { exact: true }).selectOption("");
  await form.getByLabel("任意人数", { exact: true }).fill("1.5");
  await form.getByLabel("任意人数", { exact: true }).fill("");
  await form.getByLabel("任意日", { exact: true }).fill("2026-12-10");
  await form.getByLabel("任意日", { exact: true }).fill("");
}

test("completes Passkey setup, registration, roster reception, duplicate detection, and reversal", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await page.goto("/");
  await page.getByLabel("お名前", { exact: true }).fill("受付担当");
  await page.getByRole("button", { name: "Passkey を登録して始める" }).click();
  await expect(page.getByRole("heading", { name: "新しいイベントを作成" })).toBeVisible();
  await page.getByLabel("イベント名", { exact: true }).fill("受付検証イベント");
  await page.getByLabel("開催日", { exact: true }).fill("2026-12-10");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/events") && response.request().method() === "POST");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  const { id: eventId } = await (await created).json();
  await page.locator("li").filter({ hasText: "受付検証イベント" }).getByRole("button", { name: "管理する", exact: true }).click();
  await page.getByLabel("会場名", { exact: true }).fill("受付会場");
  await page.getByRole("button", { name: "会場を追加" }).click();
  await expect(page.getByRole("combobox", { name: "受付会場", exact: true })).toHaveValue(/.+/);
  for (const field of [
    { key: "note", label: "備考", type: "textarea", required: true },
    { key: "count", label: "人数", type: "number", required: true },
    { key: "date", label: "参加日", type: "date", required: true },
    { key: "category", label: "区分", type: "single_select", required: true, options: ["一般", "学生"] },
    { key: "interests", label: "関心", type: "multi_select", required: true, options: ["講演", "交流"] },
    { key: "confirmed", label: "確認済み", type: "checkbox", required: true },
    { key: "consent", label: "規約に同意", type: "consent", required: true },
    { key: "optional_category", label: "任意区分", type: "single_select", options: ["一般"] },
    { key: "optional_count", label: "任意人数", type: "number" },
    { key: "optional_date", label: "任意日", type: "date" },
  ]) {
    expect((await context.request.post(`/api/events/${eventId}/form-fields`, { data: field })).status()).toBe(201);
  }
  // Adding a field through the UI also refreshes the walk-in form immediately.
  await page.getByLabel("項目キー", { exact: true }).fill("company");
  await page.getByLabel("表示名", { exact: true }).fill("所属");
  await page.locator("#settings select").selectOption("text");
  await page.getByLabel("必須項目", { exact: true }).check();
  await page.getByRole("button", { name: "項目を追加", exact: true }).click();
  const walkIn = page.locator("form").filter({ has: page.getByRole("button", { name: "登録する", exact: true }) });
  await expect(walkIn.getByLabel("所属（必須）", { exact: true })).toBeVisible();
  const published = page.waitForResponse((response) => response.url().endsWith(`/api/events/${eventId}/publish`));
  await page.getByRole("button", { name: "イベントを公開する", exact: true }).click();
  expect((await published).status()).toBe(200);

  // A second browser has no organizer session and registers through the public UI.
  const participantContext = await context.browser()!.newContext();
  try {
    const participant = await participantContext.newPage();
    const participantCdp = await participantContext.newCDPSession(participant);
    await participantCdp.send("WebAuthn.enable");
    await participantCdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } });
    await participant.goto(`http://localhost:4173/events/${eventId}/register`);
    await participant.getByLabel("氏名", { exact: true }).fill("事前申込者");
    await fillAnswers(participant.locator("form"), "事前所属");
    const registered = participant.waitForResponse((response) => response.url().endsWith(`/public/events/${eventId}/register`) && response.request().method() === "POST");
    await participant.getByRole("button", { name: "申し込む", exact: true }).click();
    const registration = await (await registered).json();
    await expect(participant.getByRole("img", { name: "受付用QRコード" })).toBeVisible();
    await participant.getByRole("button", { name: "Passkey を登録", exact: true }).click();
    await expect(participant.getByText(/Passkeyを登録しました。/)).toBeVisible();
    await participant.goto("http://localhost:4173/ticket");
    await participant.route("**/public/participant/passkeys/authentication/verify", async (route) => {
      const request = route.request();
      const responses = await Promise.all([
        participantContext.request.post(request.url(), { data: request.postDataJSON() }),
        participantContext.request.post(request.url(), { data: request.postDataJSON() }),
      ]);
      expect(responses.map((response) => response.status()).sort()).toEqual([200, 400]);
      await route.fulfill({ response: responses.find((response) => response.status() === 200)! });
    });
    await participant.getByRole("button", { name: "Passkey でログイン", exact: true }).click();
    await expect(participant.getByRole("heading", { name: "受付検証イベント", exact: true })).toBeVisible();
    await expect(participant.getByRole("img", { name: "受付用 QR コード", exact: true })).toBeVisible();

    await page.getByLabel("チケットリンク", { exact: true }).fill(`http://localhost:4173/public/tickets/${registration.ticketId}/check-in/${registration.qrToken}`);
    await page.getByRole("button", { name: "受付する", exact: true }).click();
    await expect(page.getByText("受付が完了しました。", { exact: true })).toBeVisible();
    await expect(page.locator("tbody tr").filter({ hasText: "事前申込者" })).toContainText("checked_in");
    await page.getByRole("button", { name: "受付する", exact: true }).click();
    await expect(page.getByText(/受付済みです。最初の受付:/)).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept("誤受付の検証"));
    await page.locator("tbody tr").filter({ hasText: "事前申込者" }).getByRole("button", { name: "受付取消", exact: true }).click();
    await expect(page.getByText("受付を取り消しました。", { exact: true })).toBeVisible();
    const row = page.locator("tbody tr").filter({ hasText: "事前申込者" });
    await expect(row).toContainText("issued");
    await row.getByRole("button", { name: "受付", exact: true }).click();
    await expect(row).toContainText("checked_in");

    await page.setViewportSize({ width: 390, height: 844 });
    await walkIn.getByLabel("氏名", { exact: true }).fill("当日参加者");
    expect(await walkIn.evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(false);
    await fillAnswers(walkIn, "当日所属");
    await walkIn.getByRole("group", { name: "関心（必須）", exact: true }).getByLabel("交流", { exact: true }).uncheck();
    expect(await walkIn.evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(false);
    await walkIn.getByRole("group", { name: "関心（必須）", exact: true }).getByLabel("交流", { exact: true }).check();
    await walkIn.screenshot({ path: "test-results/walk-in-fields.png" });
    await page.route(`**/api/events/${eventId}/attendees`, (route) => route.fulfill({ status: 503, json: { message: "一時的に登録できません。" } }), { times: 1 });
    await walkIn.getByRole("button", { name: "登録する", exact: true }).click();
    await expect(page.getByText("一時的に登録できません。", { exact: true })).toBeVisible();
    await expect(walkIn.getByLabel("氏名", { exact: true })).toHaveValue("当日参加者");
    await expect(walkIn.getByLabel("所属（必須）", { exact: true })).toHaveValue("当日所属");
    await expect(walkIn.getByLabel("規約に同意（必須）", { exact: true })).toBeChecked();
    const walkInRegistered = page.waitForResponse((response) => response.url().endsWith(`/api/events/${eventId}/attendees`) && response.request().method() === "POST");
    await walkIn.getByRole("button", { name: "登録する", exact: true }).click();
    const saved = await walkInRegistered;
    expect(saved.status()).toBe(201);
    expect(saved.request().postDataJSON().answers).toEqual({ company: "当日所属", note: "受付で確認", count: 0, date: "2026-12-10", category: "一般", interests: ["交流"], confirmed: true, consent: true });
    await expect(page.getByRole("img", { name: "当日参加者の受付用 QR コード" })).toBeVisible();
    await expect(walkIn.getByLabel("所属（必須）", { exact: true })).toHaveValue("");
    await expect(walkIn.getByLabel("規約に同意（必須）", { exact: true })).not.toBeChecked();
    const walkInRow = page.locator("tbody tr").filter({ hasText: "当日参加者" });
    await expect(walkInRow).toContainText("当日所属");
    await expect(walkInRow).toContainText("交流");
    await walkInRow.getByRole("button", { name: "受付", exact: true }).click();
    await expect(walkInRow).toContainText("checked_in");
    await page.getByLabel("検索", { exact: true }).fill("当日参加者");
    await page.getByRole("button", { name: "絞り込む", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr")).toContainText("当日参加者");
  } finally { await participantContext.close(); }
});
