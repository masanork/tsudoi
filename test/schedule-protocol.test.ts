import { describe, expect, it } from "vitest";
import { confirmedCalendar, extractInviteToken, parseConstraints, parseScheduleSlot, pkceS256, suggestSlots } from "../src/schedule-protocol";

describe("schedule protocol", () => {
  it("rejects normalized invalid calendar dates and meetings that cross into an unavailable day", () => {
    expect(parseScheduleSlot({ start: "2026-02-30T09:00:00Z", end: "2026-02-30T10:00:00Z" })).toBeUndefined();
    expect(parseScheduleSlot({ start: "2026-11-02T24:00:00Z", end: "2026-11-03T01:00:00Z" })).toBeUndefined();
    const constraints = parseConstraints({ timeZone: "Asia/Tokyo", durationMinutes: 60, unavailableWeekdays: ["TU"], windows: [{ start: "2026-11-02T23:30:00+09:00", end: "2026-11-03T00:30:00+09:00" }] });
    expect(constraints).toBeDefined();
    expect(suggestSlots({ constraints: [constraints!] }).slots).toEqual([]);
  });
  it("normalizes constraints and keeps free intervals in UTC", () => {
    const constraints = parseConstraints({
      timeZone: "Asia/Tokyo",
      maxDurationMinutes: 90,
      unavailableWeekdays: ["monday", "SU"],
      windows: [{ start: "2026-11-03T10:00:00+09:00", end: "2026-11-03T13:00:00+09:00" }],
    });
    expect(constraints).toEqual({
      timeZone: "Asia/Tokyo",
      durationMinutes: 90,
      unavailableWeekdays: ["SU", "MO"],
      windows: [{ start: "2026-11-03T01:00:00.000Z", end: "2026-11-03T04:00:00.000Z" }],
    });
    expect(parseConstraints({ timeZone: "Asia/Tokyo", calendarTitle: "secret" })).toBeUndefined();
    expect(parseScheduleSlot({ date: "2026-11-01", start: "2026-11-01T00:00:00Z" })).toBeUndefined();
  });

  it("suggests the overlap and skips an unavailable weekday", () => {
    const shared = { timeZone: "UTC", durationMinutes: 60, unavailableWeekdays: [] as string[], windows: [] as Array<{ start: string; end: string }> };
    const suggested = suggestSlots({
      now: Date.parse("2026-11-01T00:00:00Z"),
      constraints: [
        { ...shared, windows: [{ start: "2026-11-03T01:00:00.000Z", end: "2026-11-03T04:00:00.000Z" }] },
        { ...shared, durationMinutes: 120, windows: [{ start: "2026-11-03T02:00:00.000Z", end: "2026-11-03T05:00:00.000Z" }] },
      ],
    });
    expect(suggested.durationMinutes).toBe(60);
    expect(suggested.slots[0]).toEqual({ start: "2026-11-03T02:00:00.000Z", end: "2026-11-03T03:00:00.000Z" });
    const blocked = suggestSlots({
      now: Date.parse("2026-11-01T00:00:00Z"),
      constraints: [
        { ...shared, unavailableWeekdays: ["TU"], windows: [{ start: "2026-11-03T01:00:00.000Z", end: "2026-11-03T04:00:00.000Z" }] },
      ],
    });
    expect(blocked.slots).toEqual([]);
  });

  it("publishes an iCalendar event and reads an invite token", () => {
    const allDay = confirmedCalendar({ uid: "event-1", title: "打ち合わせ, 本社", startsAt: "2026-11-01", endsAt: "2026-11-01", timeZone: "Asia/Tokyo", url: "https://tsudoi.example/events/event-1/schedule", stamp: new Date("2026-09-28T00:00:00Z") });
    expect(allDay.icalendar).toContain("BEGIN:VCALENDAR");
    expect(allDay.icalendar).toContain("DTSTART;VALUE=DATE:20261101");
    expect(allDay.icalendar).toContain("DTEND;VALUE=DATE:20261102");
    expect(allDay.icalendar).toContain("SUMMARY:打ち合わせ\\, 本社");
    const timed = confirmedCalendar({ uid: "event-2", title: "Call", startsAt: "2026-11-03T02:00:00.000Z", endsAt: "2026-11-03T03:00:00.000Z", timeZone: "Asia/Tokyo", url: "https://tsudoi.example/events/event-2/schedule" });
    expect(timed.allDay).toBe(false);
    expect(timed.icalendar).toContain("DTSTART:20261103T020000Z");
    expect(extractInviteToken("https://tsudoi.example/events/1/schedule#invite=abcDEF1234567890xyz_")).toBe("abcDEF1234567890xyz_");
  });

  it("implements the PKCE S256 example from RFC 7636", async () => {
    await expect(pkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
