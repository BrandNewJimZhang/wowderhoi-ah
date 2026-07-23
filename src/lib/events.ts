import type { DailySummary, Event } from "@prisma/client";

function percentChange(current: number, previous: number) {
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

function closestSummary(summaries: DailySummary[], date: Date) {
  return summaries.reduce<DailySummary | null>((closest, summary) => {
    if (!closest) return summary;
    return Math.abs(summary.date.getTime() - date.getTime()) < Math.abs(closest.date.getTime() - date.getTime()) ? summary : closest;
  }, null);
}

export function calculateEventStudy(event: Event, summaries: DailySummary[]) {
  const sorted = [...summaries].sort((left, right) => left.date.getTime() - right.date.getTime());
  const start = event.startTime;
  const before3 = new Date(start); before3.setDate(start.getDate() - 3);
  const after3 = new Date(start); after3.setDate(start.getDate() + 3);
  const before7 = new Date(start); before7.setDate(start.getDate() - 7);
  const after7 = new Date(start); after7.setDate(start.getDate() + 7);
  const eventDay = closestSummary(sorted, start);
  const b3 = closestSummary(sorted, before3);
  const a3 = closestSummary(sorted, after3);
  const b7 = closestSummary(sorted, before7);
  const a7 = closestSummary(sorted, after7);
  const pre3Return = eventDay && b3 ? percentChange(eventDay.closePrice, b3.closePrice) : 0;
  const post3Return = eventDay && a3 ? percentChange(a3.closePrice, eventDay.closePrice) : 0;
  const pre7Return = eventDay && b7 ? percentChange(eventDay.closePrice, b7.closePrice) : 0;
  const post7Return = eventDay && a7 ? percentChange(a7.closePrice, eventDay.closePrice) : 0;
  const expectedReturn = (pre3Return + pre7Return) / 2;
  const abnormalReturn = post3Return - expectedReturn;
  const cumulativeAbnormalReturn = abnormalReturn + post7Return - expectedReturn;
  return { event, pre3Return, post3Return, pre7Return, post7Return, abnormalReturn, cumulativeAbnormalReturn };
}