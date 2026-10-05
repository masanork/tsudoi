export function formatUtcTimestamp(value: string | null | undefined): string {
  if (!value) return "";
  const utcValue = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(utcValue);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
