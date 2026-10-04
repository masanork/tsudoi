// Scheduling values that already have a standard shape: RFC 3339 instants,
// IANA time zones, iCalendar weekdays (RFC 5545), and a published VEVENT.
// Overlap itself is not a separate standard; it is computed from those values.

const WEEKDAY_ALIASES: Record<string, string> = {
  su: "SU", sun: "SU", sunday: "SU",
  mo: "MO", mon: "MO", monday: "MO",
  tu: "TU", tue: "TU", tuesday: "TU",
  we: "WE", wed: "WE", wednesday: "WE",
  th: "TH", thu: "TH", thursday: "TH",
  fr: "FR", fri: "FR", friday: "FR",
  sa: "SA", sat: "SA", saturday: "SA",
};
const WEEKDAY_ORDER = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const CONSTRAINT_KEYS = new Set(["timeZone", "durationMinutes", "maxDurationMinutes", "windows", "unavailableWeekdays"]);

export type SchedulingConstraints = {
  timeZone: string;
  durationMinutes: number;
  windows: Array<{ start: string; end: string }>;
  unavailableWeekdays: string[];
};

export type ScheduleSlot = { startsAt: string; endsAt: string; allDay: boolean };

export function canonicalDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return value;
}

export function canonicalTimestamp(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  if (!canonicalDate(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23
    || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

export function calendarDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function parseScheduleSlot(input: { date?: unknown; start?: unknown; end?: unknown }): ScheduleSlot | undefined {
  const date = typeof input.date === "string" ? input.date : undefined;
  const start = typeof input.start === "string" ? input.start : undefined;
  const end = typeof input.end === "string" ? input.end : undefined;
  if (date && (start || end)) return undefined;
  if (date) {
    const startsAt = canonicalDate(date);
    return startsAt ? { startsAt, endsAt: startsAt, allDay: true } : undefined;
  }
  if (!start || !end) return undefined;
  const startsAt = canonicalTimestamp(start);
  const endsAt = canonicalTimestamp(end);
  if (!startsAt || !endsAt) return undefined;
  const duration = Date.parse(endsAt) - Date.parse(startsAt);
  if (duration <= 0 || duration > 24 * 60 * 60 * 1000) return undefined;
  return { startsAt, endsAt, allDay: false };
}

export function parseConstraints(value: unknown): SchedulingConstraints | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CONSTRAINT_KEYS.has(key))) return undefined;
  const timeZone = record.timeZone === undefined ? "UTC" : record.timeZone;
  if (typeof timeZone !== "string" || !isTimeZone(timeZone)) return undefined;
  const requested = record.durationMinutes ?? record.maxDurationMinutes ?? 60;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 15 || requested > 480) return undefined;
  const windowsValue = record.windows === undefined ? [] : record.windows;
  if (!Array.isArray(windowsValue) || windowsValue.length > 32) return undefined;
  const windows: Array<{ start: string; end: string }> = [];
  for (const window of windowsValue) {
    if (typeof window !== "object" || window === null || Array.isArray(window)) return undefined;
    const slot = parseScheduleSlot(window as { start?: unknown; end?: unknown });
    if (!slot || slot.allDay) return undefined;
    if (Date.parse(slot.endsAt) - Date.parse(slot.startsAt) > 18 * 60 * 60 * 1000) return undefined;
    windows.push({ start: slot.startsAt, end: slot.endsAt });
  }
  const weekdaysValue = record.unavailableWeekdays === undefined ? [] : record.unavailableWeekdays;
  if (!Array.isArray(weekdaysValue) || weekdaysValue.length > 7) return undefined;
  const unavailable = new Set<string>();
  for (const weekday of weekdaysValue) {
    if (typeof weekday !== "string") return undefined;
    const code = WEEKDAY_ALIASES[weekday.trim().toLowerCase()];
    if (!code) return undefined;
    unavailable.add(code);
  }
  return {
    timeZone,
    durationMinutes: requested,
    windows,
    unavailableWeekdays: WEEKDAY_ORDER.filter((code) => unavailable.has(code)),
  };
}

export function suggestSlots(input: { constraints: SchedulingConstraints[]; durationMinutes?: number; now?: number; limit?: number }): { durationMinutes: number; slots: Array<{ start: string; end: string }> } {
  const caps = input.constraints.map((constraints) => constraints.durationMinutes);
  const cap = caps.length > 0 ? Math.min(...caps) : 480;
  const requested = input.durationMinutes && input.durationMinutes > 0 ? input.durationMinutes : cap;
  const durationMinutes = Math.min(Math.max(requested, 15), cap);
  const durationMs = durationMinutes * 60 * 1000;
  const windowSets = input.constraints
    .filter((constraints) => constraints.windows.length > 0)
    .map((constraints) => mergeIntervals(constraints.windows.map((window) => [Date.parse(window.start), Date.parse(window.end)] as [number, number])));
  if (windowSets.length === 0) return { durationMinutes, slots: [] };
  const overlap = windowSets.reduce((left, right) => intersectIntervals(left, right));
  const slots: Array<{ start: string; end: string }> = [];
  const limit = input.limit ?? 8;
  const now = input.now ?? 0;
  for (const [windowStart, windowEnd] of overlap) {
    for (let start = windowStart; start + durationMs <= windowEnd && slots.length < limit; start += 30 * 60 * 1000) {
      if (start < now) continue;
      if (input.constraints.some((constraints) => constraints.unavailableWeekdays.includes(weekdayCode(start, constraints.timeZone))
        || constraints.unavailableWeekdays.includes(weekdayCode(start + durationMs - 1, constraints.timeZone)))) continue;
      slots.push({ start: new Date(start).toISOString(), end: new Date(start + durationMs).toISOString() });
    }
  }
  return { durationMinutes, slots };
}

export function confirmedCalendar(input: { uid: string; title: string; startsAt: string; endsAt: string; timeZone: string; url: string; stamp?: Date }): { title: string; start: string; end: string; timeZone: string; url: string; allDay: boolean; icalendar: string } {
  const allDay = canonicalDate(input.startsAt) === input.startsAt;
  const stamp = icalUtc((input.stamp ?? new Date()).toISOString());
  const uid = `${input.uid.replace(/[^A-Za-z0-9.@-]/g, "")}@tsudoi`;
  const startLine = allDay ? `DTSTART;VALUE=DATE:${input.startsAt.replaceAll("-", "")}` : `DTSTART:${icalUtc(input.startsAt)}`;
  const endLine = allDay ? `DTEND;VALUE=DATE:${nextDate(input.startsAt)}` : `DTEND:${icalUtc(input.endsAt)}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tsudoi//scheduling//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    startLine,
    endLine,
    `SUMMARY:${icalText(input.title)}`,
    `URL:${icalText(input.url)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return { title: input.title, start: input.startsAt, end: input.endsAt, timeZone: input.timeZone, url: input.url, allDay, icalendar: lines.map(foldIcalLine).join("\r\n") };
}

export function extractInviteToken(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) return undefined;
  try {
    const url = new URL(trimmed);
    const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    return fragment.get("invite") ?? url.searchParams.get("invite") ?? undefined;
  } catch {
    return /^[A-Za-z0-9._~-]{20,200}$/.test(trimmed) ? trimmed : undefined;
  }
}

export async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function weekdayCode(instant: number, timeZone: string): string {
  const short = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(instant));
  return WEEKDAY_ALIASES[short.toLowerCase()] ?? "MO";
}

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (!last || start > last[1]) merged.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return merged;
}

function intersectIntervals(left: Array<[number, number]>, right: Array<[number, number]>): Array<[number, number]> {
  const overlap: Array<[number, number]> = [];
  for (const first of left) for (const second of right) {
    const start = Math.max(first[0], second[0]);
    const end = Math.min(first[1], second[1]);
    if (end > start) overlap.push([start, end]);
  }
  return mergeIntervals(overlap);
}

function nextDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10).replaceAll("-", "");
}

function icalUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icalText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
}

function foldIcalLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let offset = 0;
  let width = 75;
  const decoder = new TextDecoder();
  while (offset < bytes.length) {
    let end = Math.min(bytes.length, offset + width);
    while (end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
    chunks.push(decoder.decode(bytes.slice(offset, end)));
    offset = end;
    width = 74;
  }
  return chunks.map((chunk, index) => index === 0 ? chunk : ` ${chunk}`).join("\r\n");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
