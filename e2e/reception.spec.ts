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
  test.setTimeout(90_000);
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
    await expect(page.getByRole("status")).toContainText("受付が完了しました。");
    await expect(page.getByRole("status")).toContainText("受付担当");
    await expect(page.locator("tbody tr").filter({ hasText: "事前申込者" })).toContainText("checked_in");
    await page.getByRole("button", { name: "受付する", exact: true }).click();
    await expect(page.getByText(/受付済みです。最初の受付:/)).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept("誤受付の検証"));
    await page.locator("tbody tr").filter({ hasText: "事前申込者" }).getByRole("button", { name: "受付取消", exact: true }).click();
    await expect(page.getByText("受付を取り消しました。", { exact: true })).toBeVisible();
    const row = page.locator("tbody tr").filter({ hasText: "事前申込者" });
    await expect(row).toContainText("issued");
    await row.getByRole("button", { name: "受付", exact: true }).click();
    await page.getByRole("dialog", { name: "参加者を確認" }).getByRole("button", { name: "本人確認して受付", exact: true }).click();
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
    await page.getByRole("dialog", { name: "参加者を確認" }).getByRole("button", { name: "本人確認して受付", exact: true }).click();
    await expect(walkInRow).toContainText("checked_in");
    await page.getByLabel("検索", { exact: true }).fill("当日参加者");
    await page.getByRole("button", { name: "絞り込む", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr")).toContainText("当日参加者");

    // Editing keeps the issued QR and reception state while changing roster data.
    await page.locator("tbody tr").getByRole("button", { name: "編集", exact: true }).click();
    const edit = page.locator("form").filter({ has: page.getByRole("button", { name: "変更を保存", exact: true }) });
    await edit.getByLabel("氏名", { exact: true }).fill("当日参加者（修正）");
    await edit.getByLabel("所属", { exact: true }).fill("名簿所属");
    await edit.getByLabel("所属（必須）", { exact: true }).fill("回答所属（修正）");
    await expect(edit.getByRole("combobox", { name: "会場", exact: true })).toBeDisabled();
    const edited = page.waitForResponse((response) => response.url().includes(`/api/events/${eventId}/attendees/`) && response.request().method() === "PATCH");
    await edit.getByRole("button", { name: "変更を保存", exact: true }).click();
    expect((await edited).status()).toBe(200);
    await expect(edit).toHaveCount(0);
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr")).toContainText("当日参加者（修正）");
    await expect(page.locator("tbody tr")).toContainText("名簿所属");
    await expect(page.locator("tbody tr")).toContainText("回答所属（修正）");
    await expect(page.locator("tbody tr")).toContainText("checked_in");

    // Simulate camera input to verify continuous scanning without camera hardware.
    await page.evaluate((initialQr) => {
      const camera = window as Window & { BarcodeDetector?: unknown; testQr: string; testDetections: number };
      camera.testQr = initialQr; camera.testDetections = 0;
      camera.BarcodeDetector = class { async detect() { camera.testDetections++; return [{ rawValue: camera.testQr }]; } };
      navigator.mediaDevices.getUserMedia = async () => new MediaStream();
      HTMLMediaElement.prototype.play = async () => {};
    }, `http://localhost:4173/public/tickets/${registration.ticketId}/check-in/${registration.qrToken}`);
    let cameraRequests = 0;
    const cameraRequestListener = (request: import("@playwright/test").Request) => {
      if (request.method() === "POST" && /\/api\/tickets\/[^/]+\/check-in$/.test(request.url())) cameraRequests++;
    };
    page.on("request", cameraRequestListener);
    await page.getByRole("button", { name: "カメラで QR を読む", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as Window & { testDetections: number }).testDetections)).toBeGreaterThan(3);
    expect(cameraRequests).toBe(1);
    await page.evaluate((qr) => { (window as Window & { testQr: string }).testQr = qr; }, `http://localhost:4173/public/tickets/${(await saved.json()).ticketId}/check-in/${(await saved.json()).qrToken}`);
    await expect.poll(() => cameraRequests).toBe(2);
    await page.getByRole("button", { name: "カメラを閉じる", exact: true }).click();
    page.off("request", cameraRequestListener);

    // Use a separate event without required fields for CSV mapping and duplicates.
    const csvEventResponse = await context.request.post("/api/events", { data: {
      name: "CSV取込検証", startsAt: "2026-12-11", registrationMode: "hybrid",
    } });
    expect(csvEventResponse.status()).toBe(201);
    const { id: csvEventId } = await csvEventResponse.json();
    expect((await context.request.post(`/api/events/${csvEventId}/venues`, { data: { name: "メイン会場" } })).status()).toBe(201);
    expect((await context.request.post(`/api/events/${csvEventId}/attendees`, { data: { name: "既存参加者" } })).status()).toBe(201);
    expect((await context.request.post(`/api/events/${csvEventId}/form-fields`, { data: { key: "notes", label: "備考", type: "textarea" } })).status()).toBe(201);
    expect((await context.request.post(`/api/events/${csvEventId}/form-fields`, { data: { key: "custom_name", label: "Name", type: "text" } })).status()).toBe(201);
    await page.goto("/");
    await page.locator("li").filter({ hasText: "CSV取込検証" }).getByRole("button", { name: "管理する", exact: true }).click();
    await expect(page.getByLabel("CSVファイル", { exact: true })).toBeEnabled();
    await page.getByLabel("CSVファイル", { exact: true }).setInputFiles({
      name: "roster.csv", mimeType: "text/csv",
      buffer: Buffer.from('\uFEFF名前,会社,備考,会場,Name\r\n既存参加者,,,,\r\nCSV新規参加者,"新規,所属","複数行の備考\r\n2行目",メイン会場,CSVカスタム回答\r\n,氏名なし,除外する行,,\r\n'),
    });
    await page.getByRole("combobox", { name: "氏名列", exact: true }).selectOption("名前");
    await page.getByRole("combobox", { name: "所属列", exact: true }).selectOption("会社");
    await page.getByRole("combobox", { name: "備考列", exact: true }).selectOption("備考");
    await page.getByRole("combobox", { name: "会場列", exact: true }).selectOption("会場");
    await page.getByRole("combobox", { name: "Name列", exact: true }).selectOption("Name");
    await page.getByRole("button", { name: "プレビューを確認", exact: true }).click();
    await expect(page.getByText("新規,所属", { exact: true })).toBeVisible();
    const committed = page.waitForResponse((response) => response.url().endsWith(`/api/events/${csvEventId}/roster/import/commit`));
    await page.getByRole("button", { name: "取り込みを確定", exact: true }).click();
    expect((await committed).status()).toBe(201);
    const importedRoster = page.getByRole("region", { name: "名簿を管理", exact: true });
    await expect(importedRoster.locator("tbody tr")).toHaveCount(2);
    await expect(importedRoster.locator("tbody tr").filter({ hasText: "CSV新規参加者" })).toContainText("新規,所属");
    await expect(importedRoster.locator("tbody tr").filter({ hasText: "CSV新規参加者" })).toContainText("複数行の備考");
    await expect(importedRoster.locator("tbody tr").filter({ hasText: "CSV新規参加者" })).toContainText("メイン会場");
    await expect(importedRoster.locator("tbody tr").filter({ hasText: "既存参加者" })).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.getByLabel("CSVファイル", { exact: true }).evaluate((input) => input.getBoundingClientRect().right <= input.parentElement!.getBoundingClientRect().right)).toBe(true);
    await importedRoster.screenshot({ path: "test-results/roster-management-mobile.png" });

    // Exported human-readable venues also work in a different event with different IDs.
    const exported = await context.request.get(`/api/events/${csvEventId}/attendees.csv`);
    expect(exported.status()).toBe(200);
    const copyEvent = await context.request.post("/api/events", { data: {
      name: "CSV再取込検証", startsAt: "2026-12-12", registrationMode: "hybrid",
    } });
    expect(copyEvent.status()).toBe(201);
    const { id: copyEventId } = await copyEvent.json();
    const copyVenue = await context.request.post(`/api/events/${copyEventId}/venues`, { data: { name: "メイン会場" } });
    expect(copyVenue.status()).toBe(201);
    const { id: copyVenueId } = await copyVenue.json();
    expect((await context.request.post(`/api/events/${copyEventId}/form-fields`, { data: { key: "notes", label: "備考", type: "textarea" } })).status()).toBe(201);
    expect((await context.request.post(`/api/events/${copyEventId}/form-fields`, { data: { key: "custom_name", label: "Name", type: "text" } })).status()).toBe(201);
    await page.goto("/");
    await page.locator("li").filter({ hasText: "CSV再取込検証" }).getByRole("button", { name: "管理する", exact: true }).click();
    await expect(page.getByLabel("CSVファイル", { exact: true })).toBeEnabled();
    await page.getByLabel("CSVファイル", { exact: true }).setInputFiles({ name: "export.csv", mimeType: "text/csv", buffer: await exported.body() });
    await page.getByRole("button", { name: "プレビューを確認", exact: true }).click();
    const copied = page.waitForResponse((response) => response.url().endsWith(`/api/events/${copyEventId}/roster/import/commit`));
    await page.getByRole("button", { name: "取り込みを確定", exact: true }).click();
    expect((await copied).status()).toBe(201);
    const copiedRoster = page.getByRole("region", { name: "名簿を管理", exact: true });
    await expect(copiedRoster.locator("tbody tr")).toHaveCount(2);
    const copiedParticipant = copiedRoster.locator("tbody tr").filter({ hasText: "CSV新規参加者" });
    await expect(copiedParticipant).toContainText("新規,所属");
    await expect(copiedParticipant).toContainText("メイン会場");
    await expect(copiedParticipant).toContainText("複数行の備考");
    await expect(copiedParticipant).toContainText("CSVカスタム回答");

    // Duplicate venue names export their IDs so the same event remains importable.
    expect((await context.request.post(`/api/events/${copyEventId}/venues`, { data: { name: "メイン会場" } })).status()).toBe(201);
    const ambiguousExport = await context.request.get(`/api/events/${copyEventId}/attendees.csv`);
    expect(ambiguousExport.status()).toBe(200);
    expect(await ambiguousExport.text()).toContain(copyVenueId);
    await expect(page.getByLabel("CSVファイル", { exact: true })).toBeEnabled();
    await page.getByLabel("CSVファイル", { exact: true }).setInputFiles({ name: "duplicate-venues.csv", mimeType: "text/csv", buffer: await ambiguousExport.body() });
    await page.getByRole("button", { name: "プレビューを確認", exact: true }).click();
    await expect(page.getByText("プレビュー: 2 行を登録できます。", { exact: true })).toBeVisible();

    // A real viewer session sees roster data without write controls.
    const { organizationId } = await (await context.request.get("/api/session")).json();
    const invitation = await context.request.post(`/api/organizations/${organizationId}/invites`, { data: { role: "viewer" } });
    expect(invitation.status()).toBe(201);
    const viewerContext = await context.browser()!.newContext();
    try {
      const viewer = await viewerContext.newPage();
      const viewerCdp = await viewerContext.newCDPSession(viewer);
      await viewerCdp.send("WebAuthn.enable");
      await viewerCdp.send("WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", transport: "internal", hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
      } });
      await viewer.goto((await invitation.json()).url);
      await viewer.getByLabel("表示名", { exact: true }).fill("閲覧担当");
      await viewer.getByRole("button", { name: "Passkey を登録して参加", exact: true }).click();
      await expect(viewer.locator("li").filter({ hasText: "CSV取込検証" })).toBeVisible();
      await expect(viewer.getByRole("heading", { name: "新しいイベントを作成" })).toHaveCount(0);
      await viewer.locator("li").filter({ hasText: "CSV取込検証" }).getByRole("button", { name: "管理する", exact: true }).click();
      await expect(viewer.locator("tbody tr")).toHaveCount(2);
      for (const label of ["編集", "受付", "プレビューを確認", "受付する", "登録する", "項目を追加"]) {
        await expect(viewer.getByRole("button", { name: label, exact: true })).toHaveCount(0);
      }
    } finally { await viewerContext.close(); }
  } finally { await participantContext.close(); }
});
