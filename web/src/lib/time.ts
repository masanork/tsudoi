export function formatUtcTimestamp(value: string | null | undefined): string {
  if (!value) return "";
  const millis = utcTimestampMillis(value);
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function utcTimestampMillis(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const utcValue = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(utcValue);
}
