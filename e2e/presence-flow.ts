import { expect, type BrowserContext, type Page } from "@playwright/test";

type Fixture = { eventId: string; venueId: string; qrLink: string; person: { attendeeId: string; ticketId: string } };

/** Exercises the same issued credential across admission, distributions, and presence. */
export async function verifyPresenceFlow(page: Page, context: BrowserContext, fixture: Fixture) {
  const { eventId, venueId, qrLink, person } = fixture;
  const venue = await context.request.post(`/api/events/${eventId}/venues`, { data: { name: "第二会場" } });
  expect(venue.status()).toBe(201);
  const { id: secondVenueId } = await venue.json();
  await page.goto("/");
  await page.locator("li").filter({ hasText: "平時と避難所の運用検証" }).getByRole("button", { name: "管理する", exact: true }).click();
  const presence = page.getByRole("region", { name: "入退館管理", exact: true });

  async function resolveAt(operationVenue: string) {
    const input = presence.getByLabel("入退館用QRリンク", { exact: true });
    if (!await input.isVisible()) await presence.getByText("QRから参加者を確認", { exact: true }).click();
    await presence.locator("details").getByRole("combobox", { name: "入退館会場", exact: true }).selectOption(operationVenue);
    await input.fill(qrLink);
    await presence.getByRole("button", { name: "参加者を確認", exact: true }).click();
    await expect(presence).toContainText("配布確認者");
  }

  async function record(action: "enter" | "exit") {
    const button = presence.getByRole("button", { name: action === "enter" ? /^入館を記録$/ : /退館を記録$/ });
    await expect(button).toBeEnabled();
    const completed = page.waitForResponse((r) => r.url().endsWith(`/events/${eventId}/presence/movements`) && r.request().method() === "POST");
    await button.click();
    const response = await completed;
    expect(response.status()).toBe(201);
    expect((await response.json()).outcome).toBe("accepted");
  }

  await resolveAt(venueId);
  await expect(presence).toContainText("未入館（記録なし）");
  const initial = await (await context.request.get(`/api/events/${eventId}/presence`)).json();
  expect(initial.summary.total_in).toBe(0);
  await record("enter");
  for (const operationVenue of [venueId, secondVenueId]) {
    const conflict = await context.request.post(`/api/events/${eventId}/presence/movements`, { data: {
      requestId: crypto.randomUUID(), qrLink, venueId: operationVenue, action: "enter", expectedRevision: 1,
    } });
    expect(conflict.status()).toBe(201);
    expect((await conflict.json()).outcome).toBe("state_conflict");
  }
  await resolveAt(venueId);
  await record("exit");
  await resolveAt(venueId);
  await record("enter");
  await record("exit");

  // Registration is still assigned to the first venue; actual presence can move.
  await resolveAt(secondVenueId);
  let committedMovementId = "";
  await page.route(`**/api/events/${eventId}/presence/movements`, async (route) => {
    const committed = await route.fetch();
    expect(committed.status()).toBe(201);
    committedMovementId = (await committed.json()).movement.id;
    await route.abort("failed");
  }, { times: 1 });
  await presence.getByRole("button", { name: "入館を記録", exact: true }).click();
  await expect(presence.getByRole("button", { name: /再確認|再試行/ })).toBeEnabled();
  const reconciled = page.waitForResponse((r) => /\/presence\/movements\/by-request\/[^/]+$/.test(r.url()) && r.status() === 200);
  await presence.getByRole("button", { name: /再確認|再試行/ }).click();
  expect((await (await reconciled).json()).movement.id).toBe(committedMovementId);
  const current = await (await context.request.get(`/api/events/${eventId}/presence`)).json();
  expect(current.summary.total_in).toBe(1);
  expect(current.summary.total_entries).toBe(3);
  expect(current.summary.venue_in).toContainEqual({ venue_id: secondVenueId, venue_name: "第二会場", count: 1 });
  expect(current.presence.find((row: { attendee_id: string }) => row.attendee_id === person.attendeeId)).toMatchObject({
    state: "in", venue_id: secondVenueId, revision: 5,
  });
  const stale = await context.request.post(`/api/events/${eventId}/presence/movements`, { data: {
    requestId: crypto.randomUUID(), attendeeId: person.attendeeId, venueId: secondVenueId, action: "exit", expectedRevision: 4,
  } });
  expect(stale.status()).toBe(201);
  expect((await stale.json()).outcome).toBe("revision_conflict");
  await resolveAt(secondVenueId);
  await record("exit");
  const final = await (await context.request.get(`/api/events/${eventId}/presence`)).json();
  expect(final.summary.total_in).toBe(0);
  expect(final.summary.total_entries).toBe(3);
  const history = await (await context.request.get(`/api/events/${eventId}/presence/history?attendeeId=${person.attendeeId}`)).json();
  const acceptedMovements = history.movements.filter((movement: { outcome: string }) => movement.outcome === "accepted");
  expect(acceptedMovements).toHaveLength(6);
  expect(acceptedMovements.map((movement: { revision: number }) => movement.revision)).toEqual([6, 5, 4, 3, 2, 1]);
  expect(history.movements.filter((movement: { status: string }) => movement.status === "unsuccessful")).toHaveLength(3);
  await expect(presence).toContainText("は未記録");
  const roster = await (await context.request.get(`/api/events/${eventId}/roster`)).json();
  const attendee = roster.attendees.find((row: { id: string }) => row.id === person.attendeeId);
  expect(attendee.ticket_status).toBe("checked_in");
  expect(attendee.venue_id).toBe(venueId);
  await presence.screenshot({ path: "test-results/presence-mobile.png" });
  return { ...fixture, secondVenueId };
}
