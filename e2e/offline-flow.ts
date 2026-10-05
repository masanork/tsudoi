import { readFile } from "node:fs/promises";
import { expect, type BrowserContext, type Page } from "@playwright/test";

type Fixture = { eventId: string; venueId: string; secondVenueId: string; qrLink: string; person: { attendeeId: string }; familyMember: { attendeeId: string } };

async function storedState(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tsudoi-prepared-operations");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(["snapshots", "operations", "receipts"], "readonly");
      const get = (request: IDBRequest<any>) => new Promise<any>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [snapshot, operations, receipts] = await Promise.all([
        get(tx.objectStore("snapshots").get("prepared")), get(tx.objectStore("operations").getAll()), get(tx.objectStore("receipts").getAll()),
      ]);
      return { snapshot: snapshot?.value ?? null, operations, receipts };
    } finally { db.close(); }
  });
}

export async function verifyOfflineFlow(page: Page, context: BrowserContext, fixture: Fixture) {
  const { eventId, venueId, secondVenueId, qrLink, person, familyMember } = fixture;
  const roundResponse = await context.request.post(`/api/events/${eventId}/distributions`, { data: { name: "通信断用の配布", unit: "個", maxPerAttendee: 1 } });
  expect(roundResponse.status()).toBe(201);
  const roundId = (await roundResponse.json()).id;
  const projectionRoundResponse = await context.request.post(`/api/events/${eventId}/distributions`, { data: { name: "別タブ反映確認用", unit: "個", maxPerAttendee: 1 } });
  expect(projectionRoundResponse.status()).toBe(201);
  const projectionRoundId = (await projectionRoundResponse.json()).id;
  const expiryPersonResponse = await context.request.post(`/api/events/${eventId}/attendees`, { data: { name: "期限検証用の参加者", venueId } });
  expect(expiryPersonResponse.status()).toBe(201);
  const expiryPerson = await expiryPersonResponse.json();
  await page.goto("/");
  await page.locator("li").filter({ hasText: "平時と避難所の運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  await page.getByRole("button", { name: "オフライン受付を開く", exact: true }).click();
  const panel = page.getByRole("region", { name: "オフライン受付", exact: true });
  await panel.getByRole("combobox", { name: "準備する会場", exact: true }).selectOption(venueId);
  await panel.getByRole("checkbox", { name: "この端末に受付データを準備する", exact: true }).check();
  // Both tabs start with empty storage. Start the second preparation while
  // the first response is held, then verify it cannot replace the first venue.
  const preparingSibling = await context.newPage();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let preparedResponses = 0, siblingRequests = 0;
  await page.route(`**/api/events/${eventId}/offline-snapshot?*`, async (route) => {
    const response = await route.fetch();
    preparedResponses += 1;
    await firstGate;
    await route.fulfill({ response });
  }, { times: 1 });
  await preparingSibling.route(`**/api/events/${eventId}/offline-snapshot?*`, async (route) => {
    siblingRequests += 1;
    await route.continue();
  }, { times: 1 });
  await preparingSibling.goto("/");
  await preparingSibling.locator("li").filter({ hasText: "平時と避難所の運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  await preparingSibling.getByRole("button", { name: "オフライン受付を開く", exact: true }).click();
  const preparingSiblingPanel = preparingSibling.getByRole("region", { name: "オフライン受付", exact: true });
  await preparingSiblingPanel.getByRole("combobox", { name: "準備する会場", exact: true }).selectOption(secondVenueId);
  await preparingSiblingPanel.getByRole("checkbox", { name: "この端末に受付データを準備する", exact: true }).check();
  const preparation = page.waitForResponse((response) => response.url().includes(`/events/${eventId}/offline-snapshot?`) && response.status() === 200);
  await panel.getByRole("button", { name: "オフライン利用を準備", exact: true }).click();
  await expect.poll(() => preparedResponses).toBe(1);
  await preparingSiblingPanel.getByRole("button", { name: "オフライン利用を準備", exact: true }).click();
  releaseFirst();
  await expect.poll(async () => (await storedState(page)).snapshot?.venueId).toBe(venueId);
  await expect(preparingSiblingPanel).toContainText("準備を完了できませんでした");
  expect(siblingRequests).toBe(0);
  expect((await storedState(page)).snapshot.venueId).toBe(venueId);
  await preparingSibling.close();
  const snapshot = (await (await preparation).json()).snapshot;
  expect(snapshot.attendees.some((attendee: { id: string }) => attendee.id === person.attendeeId)).toBe(true);
  expect(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.preparedAt)).toBe(12 * 60 * 60 * 1000);
  const qrSecret = new URL(qrLink).pathname.split("/").at(-1)!;
  const serialized = JSON.stringify(snapshot);
  expect(serialized).not.toContain(qrSecret);
  for (const field of ["email_normalized", "affiliation", "answers", "ticketToken", "qrToken"]) expect(serialized).not.toContain(`"${field}"`);
  await expect.poll(async () => (await storedState(page)).snapshot?.eventId).toBe(eventId);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await panel.getByRole("combobox", { name: "参加者を選択", exact: true }).selectOption(expiryPerson.attendeeId);
  await panel.getByRole("button", { name: "入館を記録", exact: true }).click();
  await expect.poll(async () => (await storedState(page)).operations.length).toBe(1);
  const expiryOperationId = (await storedState(page)).operations[0].requestId;
  await page.clock.install({ time: new Date(Date.parse(snapshot.expiresAt) + 1) });
  await page.clock.runFor(2001);
  await expect.poll(async () => (await storedState(page)).snapshot).toBeNull();
  expect((await storedState(page)).operations.map((operation: { requestId: string }) => operation.requestId)).toEqual([expiryOperationId]);
  await expect(panel).not.toContainText("期限検証用の参加者");
  await expect(panel.getByRole("button", { name: "入館を記録", exact: true })).toHaveCount(0);
  await page.clock.setSystemTime(new Date());
  await context.setOffline(false);
  await expect(panel.getByRole("button", { name: "未同期操作を同期", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "未同期操作を同期", exact: true }).click();
  await expect.poll(async () => (await storedState(page)).operations.length).toBe(0);
  expect((await storedState(page)).receipts).toEqual([expect.objectContaining({ requestId: expiryOperationId, outcome: "accepted" })]);
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "準備データと未同期操作を消去", exact: true }).click();
  await expect.poll(async () => (await storedState(page)).receipts.length).toBe(0);
  await page.goto("/");
  await page.locator("li").filter({ hasText: "平時と避難所の運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  await page.getByRole("button", { name: "オフライン受付を開く", exact: true }).click();
  await panel.getByRole("combobox", { name: "準備する会場", exact: true }).selectOption(venueId);
  await panel.getByRole("checkbox", { name: "この端末に受付データを準備する", exact: true }).check();
  await panel.getByRole("button", { name: "オフライン利用を準備", exact: true }).click();
  await expect.poll(async () => (await storedState(page)).snapshot?.eventId).toBe(eventId);

  const anotherTerminal = await context.browser()!.newContext();
  await anotherTerminal.addCookies(await context.cookies());
  try {
    await context.setOffline(true);
    await panel.locator("summary").filter({ hasText: "受付QRから参加者を確認" }).click();
    await panel.getByLabel("受付QRリンク", { exact: true }).fill(qrLink);
    await panel.getByRole("button", { name: "QRから参加者を確認", exact: true }).click();
    await panel.getByRole("combobox", { name: "配布回", exact: true }).selectOption(roundId);
    await panel.getByLabel("数量", { exact: true }).fill("1");
    // A storage write failure must not appear as a saved handoff.
    await page.evaluate(() => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === "operations") {
          IDBObjectStore.prototype.add = add;
          throw new DOMException("Simulated full storage", "QuotaExceededError");
        }
        return add.apply(this, args);
      };
    });
    await panel.getByRole("button", { name: "配布を記録", exact: true }).click();
    await expect(panel).toContainText("操作を保存できませんでした");
    expect((await storedState(page)).operations).toHaveLength(0);
    await panel.getByLabel("受付QRリンク", { exact: true }).fill(qrLink);
    await panel.getByRole("button", { name: "QRから参加者を確認", exact: true }).click();
    const sibling = await context.newPage();
    try {
      await sibling.goto("/");
      const siblingPanel = sibling.getByRole("region", { name: "オフライン受付", exact: true });
      await siblingPanel.getByRole("combobox", { name: "参加者を選択", exact: true }).selectOption(person.attendeeId);
      await siblingPanel.getByRole("combobox", { name: "配布回", exact: true }).selectOption(roundId);
      await siblingPanel.getByLabel("数量", { exact: true }).fill("1");
      await Promise.all([
        panel.getByRole("button", { name: "配布を記録", exact: true }).click(),
        siblingPanel.getByRole("button", { name: "配布を記録", exact: true }).click(),
      ]);
      await expect.poll(async () => (await storedState(page)).operations.length).toBe(1);
      await expect(panel.getByRole("button", { name: "配布を記録", exact: true })).toBeDisabled();
      await expect(siblingPanel.getByRole("button", { name: "配布を記録", exact: true })).toBeDisabled();
      await expect.poll(async () => {
        const [mainText, siblingText] = await Promise.all([panel.innerText(), siblingPanel.innerText()]);
        return `${mainText}\n${siblingText}`.includes("配布操作を未同期として保存しました");
      }).toBe(true);
    } finally { await sibling.close(); }
    await expect.poll(async () => (await storedState(page)).operations.length).toBe(1);
    // Re-reading a QR does not reset this terminal's provisional quota.
    await panel.getByLabel("受付QRリンク", { exact: true }).fill(qrLink);
    await panel.getByRole("button", { name: "QRから参加者を確認", exact: true }).click();
    await expect(panel.getByRole("button", { name: "配布を記録", exact: true })).toBeDisabled();
    // A sibling tab can win a different round while this panel still has a stale
    // projection. QR confirmation must refresh IndexedDB before enabling another claim.
    await panel.getByRole("combobox", { name: "配布回", exact: true }).selectOption(projectionRoundId);
    const projectionSibling = await context.newPage();
    try {
      await projectionSibling.goto("/");
      const projectionPanel = projectionSibling.getByRole("region", { name: "オフライン受付", exact: true });
      await projectionPanel.getByRole("combobox", { name: "参加者を選択", exact: true }).selectOption(person.attendeeId);
      await projectionPanel.getByRole("combobox", { name: "配布回", exact: true }).selectOption(projectionRoundId);
      await projectionPanel.getByLabel("数量", { exact: true }).fill("1");
      await projectionPanel.getByRole("button", { name: "配布を記録", exact: true }).click();
      await expect(projectionPanel).toContainText("配布操作を未同期として保存しました");
      await expect.poll(async () => (await storedState(page)).operations.length).toBe(2);
      await panel.getByLabel("受付QRリンク", { exact: true }).fill(qrLink);
      await panel.getByRole("button", { name: "QRから参加者を確認", exact: true }).click();
      await expect(panel.getByRole("button", { name: "配布を記録", exact: true })).toBeDisabled();
    } finally { await projectionSibling.close(); }
    await panel.getByRole("button", { name: "入館を記録", exact: true }).click();
    await panel.getByRole("button", { name: "退館を記録", exact: true }).click();
    await panel.getByRole("combobox", { name: "参加者を選択", exact: true }).selectOption(familyMember.attendeeId);
    await panel.getByRole("combobox", { name: "配布回", exact: true }).selectOption(roundId);
    await panel.getByRole("button", { name: "配布を記録", exact: true }).click();
    await panel.getByRole("button", { name: "入館を記録", exact: true }).click();
    await panel.getByRole("button", { name: "退館を記録", exact: true }).click();
    await expect.poll(async () => (await storedState(page)).operations.length).toBe(7);
    const queued = await storedState(page);
    const operationIds = queued.operations.map((operation: { requestId: string }) => operation.requestId).sort();
    expect(new Set(operationIds).size).toBe(7);
    const projectionOperationId = queued.operations.find((operation: { distributionId?: string }) => operation.distributionId === projectionRoundId)?.requestId;
    expect(projectionOperationId).toBeTruthy();
    expect(JSON.stringify(queued)).not.toContain(qrSecret);
    await page.reload();
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await storedState(page)).operations.map((operation: { requestId: string }) => operation.requestId).sort()).toEqual(operationIds);
    await expect(panel).toContainText("未同期");

    // Another online terminal wins the distribution quota and advances presence.
    const onlineClaim = await anotherTerminal.request.post(`/api/events/${eventId}/distributions/${roundId}/claims`, { data: { requestId: crypto.randomUUID(), qrLink, quantity: 1, venueId } });
    expect((await onlineClaim.json()).outcome).toBe("accepted");
    for (const [action, expectedRevision] of [["enter", 6], ["exit", 7]] as const) {
      const moved = await anotherTerminal.request.post(`/api/events/${eventId}/presence/movements`, { data: { requestId: crypto.randomUUID(), attendeeId: person.attendeeId, action, venueId, expectedRevision } });
      expect((await moved.json()).outcome).toBe("accepted");
    }
    let committedFamilyId = "";
    await page.route(`**/api/events/${eventId}/distributions/${roundId}/claims`, async (route) => {
      const payload = route.request().postDataJSON();
      if (payload.attendeeId !== familyMember.attendeeId || committedFamilyId) { await route.continue(); return; }
      const committed = await route.fetch();
      const result = await committed.json();
      expect(result.outcome).toBe("accepted");
      committedFamilyId = result.claim.id;
      await route.abort("failed");
    });
    await context.setOffline(false);
    await panel.getByRole("button", { name: "未同期操作を同期", exact: true }).click();
    await expect.poll(() => committedFamilyId).not.toBe("");
    await expect(panel.getByRole("button", { name: "未同期操作を同期", exact: true })).toBeEnabled();
    const afterInitialSync = await storedState(page);
    const unresolvedOperationIds = operationIds.filter((id) => id !== projectionOperationId);
    expect(afterInitialSync.operations.map((operation: { requestId: string }) => operation.requestId).sort()).toEqual(unresolvedOperationIds);
    expect(afterInitialSync.receipts).toContainEqual(expect.objectContaining({ requestId: projectionOperationId, outcome: "accepted" }));
    const projectionClaims = await (await anotherTerminal.request.get(`/api/events/${eventId}/distributions/${projectionRoundId}/claims`)).json();
    expect(projectionClaims.claims.some((claim: { attendee_id: string; status: string }) => claim.attendee_id === person.attendeeId && claim.status === "accepted")).toBe(true);
    const currentSession = await (await anotherTerminal.request.get("/api/session")).json();
    await page.route("**/api/session", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ ...currentSession, actorId: crypto.randomUUID() }),
    }), { times: 1 });
    await panel.getByRole("button", { name: "未同期操作を同期", exact: true }).click();
    await expect.poll(async () => (await storedState(page)).snapshot).toBeNull();
    expect((await storedState(page)).operations.map((operation: { requestId: string }) => operation.requestId).sort()).toEqual(unresolvedOperationIds);
    await expect(panel).not.toContainText("配布確認者");
    await expect(panel).not.toContainText("世帯の同伴者");
    await panel.getByRole("button", { name: "元のアカウントを確認", exact: true }).click();
    await expect(panel.getByRole("button", { name: "未同期操作を同期", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "未同期操作を同期", exact: true }).click();
    await expect.poll(async () => (await storedState(page)).operations.length).toBe(3);
    const reconciled = await storedState(page);
    expect(reconciled.operations.every((operation: { status: string }) => operation.status === "needs_review")).toBe(true);
    expect(reconciled.receipts.filter((receipt: { attendeeId: string; outcome: string }) => receipt.attendeeId === familyMember.attendeeId && receipt.outcome === "accepted")).toHaveLength(3);
    const serverClaims = await (await anotherTerminal.request.get(`/api/events/${eventId}/distributions/${roundId}/claims`)).json();
    expect(serverClaims.claims.filter((claim: { attendee_id: string; status: string }) => claim.attendee_id === familyMember.attendeeId && claim.status === "accepted")).toHaveLength(1);
    expect(serverClaims.claims.some((claim: { id: string }) => claim.id === committedFamilyId)).toBe(true);
    const serverPresence = await (await anotherTerminal.request.get(`/api/events/${eventId}/presence?attendeeId=${familyMember.attendeeId}`)).json();
    expect(serverPresence.presence[0]).toMatchObject({ state: "out", revision: 2 });
    await expect(panel).toContainText("要照合");
    const cachedPaths = await page.evaluate(async () => {
      const names = await caches.keys();
      const requests = await Promise.all(names.filter((name) => name.startsWith("tsudoi-static-shell-")).map(async (name) => (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)));
      return requests.flat();
    });
    expect(cachedPaths).toContain("/");
    expect(cachedPaths.every((path) => path === "/" || path === "/index.html" || path.startsWith("/assets/"))).toBe(true);
    const downloading = page.waitForEvent("download");
    await panel.getByRole("button", { name: "未同期操作を書き出す", exact: true }).click();
    const download = await downloading;
    const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(exported.operations).toHaveLength(3);
    expect(JSON.stringify(exported)).not.toContain(qrSecret);
    expect(JSON.stringify(exported)).not.toContain("credentialHash");
    await panel.screenshot({ path: "test-results/offline-mobile.png" });
    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByRole("button", { name: "準備データと未同期操作を消去", exact: true }).click();
    await expect.poll(async () => (await storedState(page)).operations.length).toBe(0);
    expect((await storedState(page)).snapshot).toBeNull();
    await panel.getByRole("button", { name: "通常画面に戻る", exact: true }).click();
    await page.locator("li").filter({ hasText: "平時と避難所の運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
    await page.getByRole("button", { name: "オフライン受付を開く", exact: true }).click();
    await panel.getByRole("combobox", { name: "準備する会場", exact: true }).selectOption(venueId);
    await panel.getByRole("checkbox", { name: "この端末に受付データを準備する", exact: true }).check();
    await panel.getByRole("button", { name: "オフライン利用を準備", exact: true }).click();
    await expect.poll(async () => (await storedState(page)).snapshot?.eventId).toBe(eventId);
    await panel.getByRole("button", { name: "ログアウト", exact: true }).click();
    await expect.poll(async () => (await storedState(page)).snapshot).toBeNull();
    expect((await storedState(page)).operations).toHaveLength(0);
    expect((await storedState(page)).receipts).toHaveLength(0);
    expect((await context.request.get("/api/session")).status()).toBe(401);
  } finally {
    await context.setOffline(false);
    await anotherTerminal.close();
  }
}
