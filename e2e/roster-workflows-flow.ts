import { expect, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

export async function verifyRosterWorkflows(page: Page, context: BrowserContext) {
  const create = await context.request.post("/api/events", { data: { name: "名簿運用検証", startsAt: "2026-12-14", registrationMode: "hybrid" } });
  expect(create.status()).toBe(201); const { id: eventId } = await create.json();
  expect((await context.request.post(`/api/events/${eventId}/form-fields`, { data: { key: "category", label: "区分", type: "single_select", options: ["一般", "学生"] } })).status()).toBe(201);
  const preview = await context.request.post(`/api/events/${eventId}/roster/import/preview`, { data: { columns: ["Name", "Email", "Category"], rows: [["名簿参加者A", "roster-a@example.test", "一般"], ["名簿参加者B", "", "学生"]], mapping: { name: "Name", email: "Email", "answer:category": "Category" } } });
  expect(preview.status()).toBe(200);
  const { previewToken } = await preview.json();
  expect((await context.request.post(`/api/events/${eventId}/roster/import/commit`, { data: { previewToken, decisions: [{ rowIndex: 0, action: "include" }, { rowIndex: 1, action: "include" }] } })).status()).toBe(201);
  await page.goto("/");
  await page.locator("li").filter({ hasText: "名簿運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  const roster = page.getByRole("region", { name: "名簿を管理", exact: true });
  await expect(roster.locator("tbody tr")).toHaveCount(2);

  // Field changes and retirement preserve old answers; public forms use the active schema.
  await page.getByText("登録済み項目の変更・廃止", { exact: true }).click();
  await page.getByRole("button", { name: "項目を変更", exact: true }).click();
  await page.getByLabel("項目名", { exact: true }).fill("参加区分");
  await page.getByRole("button", { name: "項目の変更を保存", exact: true }).click();
  await expect(roster.getByRole("columnheader", { name: "参加区分", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "申込から外す", exact: true }).click();
  await expect(page.getByText("参加区分（廃止済み）", { exact: true })).toBeVisible();
  await expect(roster.getByRole("columnheader", { name: "参加区分", exact: true })).toHaveCount(0);
  expect((await (await context.request.get(`/api/events/${eventId}/roster`)).json()).attendees.some((person: { answers: Record<string, string> }) => person.answers.category === "一般")).toBe(true);
  await page.getByRole("button", { name: "申込に戻す", exact: true }).click();
  await expect(roster.getByRole("columnheader", { name: "参加区分", exact: true })).toBeVisible();

  // Personal column layout survives navigation and controls the selected-column CSV.
  await roster.getByText("名簿の表示列", { exact: true }).click();
  await roster.getByLabel("メール", { exact: true }).uncheck();
  await roster.getByRole("button", { name: "参加区分列を前へ", exact: true }).click();
  await roster.getByRole("button", { name: "列設定を保存", exact: true }).click();
  await expect(roster.getByText("自分の列設定を保存しました。", { exact: true })).toBeVisible();
  await page.goto("/");
  await page.locator("li").filter({ hasText: "名簿運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  await expect(roster.getByRole("columnheader", { name: "メール", exact: true })).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await roster.getByRole("button", { name: "表示列でCSVを出力", exact: true }).click();
  const download = await downloadPromise, csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain("名簿参加者A"); expect(csv).toContain("名簿参加者B"); expect(csv).not.toContain("roster-a@example.test");

  // A selected set can be updated together, including at mobile width.
  await roster.getByLabel("表示中の参加者をすべて選択", { exact: true }).check();
  const bulk = roster.getByLabel("選択した参加者の一括更新", { exact: true });
  await bulk.getByLabel("一括設定する所属", { exact: true }).fill("更新後の所属");
  await page.setViewportSize({ width: 390, height: 844 });
  await bulk.screenshot({ path: "test-results/roster-bulk-mobile.png" });
  page.once("dialog", (dialog) => dialog.accept());
  await bulk.getByRole("button", { name: "選択した参加者を更新", exact: true }).click();
  await expect(roster.getByText("選択した参加者の一括更新が完了しました。", { exact: true })).toBeVisible();
  await expect(roster.locator("tbody tr").filter({ hasText: "更新後の所属" })).toHaveCount(2);

  // Non-scheduling events can compose and preview mail. Delivery itself is covered by the Worker test.
  const announcement = page.getByRole("region", { name: "参加者へ案内", exact: true });
  await announcement.getByLabel("件名", { exact: true }).fill("会場のご案内");
  await announcement.getByLabel("本文", { exact: true }).fill("集合場所をご確認ください。");
  await announcement.getByRole("button", { name: "送信対象を確認", exact: true }).click();
  await expect(announcement.getByText("1件のメールアドレスが対象です。", { exact: true })).toBeVisible();
  await expect(announcement.getByRole("button", { name: "参加者へのメール送信を予約", exact: true })).toBeEnabled();
  await announcement.getByLabel("本文", { exact: true }).fill("案内を修正しました。");
  await expect(announcement.getByRole("button", { name: "参加者へのメール送信を予約", exact: true })).toHaveCount(0);

  // Templates create fresh fields in a separate event without copying the roster.
  await page.getByText("項目テンプレート", { exact: true }).click();
  await page.getByLabel("テンプレート名", { exact: true }).fill("受付の標準項目");
  await page.getByRole("button", { name: "現在の項目をテンプレートに保存", exact: true }).click();
  await expect(page.getByText("項目テンプレートを保存しました。参加者の情報は含まれません。", { exact: true })).toBeVisible();
  const destination = await context.request.post("/api/events", { data: { name: "テンプレート再利用検証", startsAt: "2026-12-15", registrationMode: "hybrid" } });
  const { id: destinationId } = await destination.json();
  await page.goto("/"); await page.locator("li").filter({ hasText: "テンプレート再利用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  await page.getByText("項目テンプレート", { exact: true }).click();
  await page.getByLabel("利用するテンプレート", { exact: true }).selectOption({ label: "受付の標準項目（1項目）" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "テンプレートの項目を追加", exact: true }).click();
  await expect(page.getByText("テンプレートの項目を追加しました。", { exact: true })).toBeVisible();
  const copy = await (await context.request.get(`/api/events/${destinationId}/roster`)).json();
  expect(copy.fields).toMatchObject([{ field_key: "category", label: "参加区分" }]); expect(copy.attendees).toEqual([]);
}
