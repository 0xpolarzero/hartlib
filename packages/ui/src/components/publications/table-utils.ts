import { flexRender } from "@tanstack/react-table";

export function renderTableContent(renderer: unknown, context: unknown) {
  return flexRender(
    renderer as Parameters<typeof flexRender>[0],
    context as Parameters<typeof flexRender>[1],
  );
}

export function formatPublicationDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

export function formatRelativeSchedule(value: string) {
  const diffMs = new Date(value).getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  const month = day * 30;
  const formatter = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });

  if (absMs < hour) return formatter.format(Math.round(diffMs / minute), "minute");
  if (absMs < day) return formatter.format(Math.round(diffMs / hour), "hour");
  if (absMs < week) return formatter.format(Math.round(diffMs / day), "day");
  if (absMs < month) return formatter.format(Math.round(diffMs / week), "week");
  return formatter.format(Math.round(diffMs / month), "month");
}

export function toDatetimeLocalValue(value: string) {
  const date = new Date(value);
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
}
