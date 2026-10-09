import type { ExecutionSummary } from "./summary.ts";

const TUI_NOTICE_LIMIT = 2000;
const SUMMARY_PREFIX_LIMIT = 700;

/** Formats a concise live TUI update from the same bounded projection as terminal notices. */
export function formatActiveExecutionSummary(summary: ExecutionSummary): string {
  if (!summary?.available) return "";
  return [
    summary.taskState ? `Task: ${summary.taskState}` : undefined,
    summary.route ? `Route: ${summary.route}` : undefined,
    summary.progress,
    ...(summary.recoveryEvents ?? []).map((event) => `Recovery: ${event}`),
  ].filter((line): line is string => Boolean(line)).join("\n").slice(0, TUI_NOTICE_LIMIT);
}

/** Combines a bounded optional projection with the original result notice. */
export function composeExecutionNotice(notice: string, summary: ExecutionSummary): string {
  const original = String(notice ?? "").slice(0, TUI_NOTICE_LIMIT);
  if (!summary?.available) return original;
  const lines = [
    summary.taskState ? `Task: ${summary.taskState}` : undefined,
    summary.route ? `Route: ${summary.route}` : undefined,
    summary.progress,
    summary.outcome ? `Outcome: ${summary.outcome}` : undefined,
    summary.detail,
    ...(summary.recoveryEvents ?? []).map((event) => `Recovery: ${event}`),
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) return original;

  const prefixLimit = Math.min(SUMMARY_PREFIX_LIMIT, TUI_NOTICE_LIMIT - original.length - 2);
  if (prefixLimit <= 0) return original;
  const prefix = lines.join("\n").slice(0, prefixLimit);
  const noticeLimit = Math.max(0, TUI_NOTICE_LIMIT - prefix.length - 2);
  return `${prefix}\n\n${original.slice(0, noticeLimit)}`;
}

/** Uses only a projection confirmed for the requested run; failures preserve the event notice. */
export async function composeExecutionNoticeFromLookup(
  notice: string,
  runID: string,
  lookup: () => Promise<{ runID?: string; summary?: ExecutionSummary }>,
): Promise<string> {
  try {
    const result = await lookup();
    return composeExecutionNotice(notice, result?.runID === runID && result.summary
      ? result.summary
      : { available: false });
  } catch {
    return composeExecutionNotice(notice, { available: false });
  }
}

/** Only publish a terminal notice when the parent TUI can render it. */
export function renderExecutionNoticeIfReady(
  status: unknown,
  render: () => void,
): "shown" | "retry" {
  if (status !== "idle") return "retry";
  render();
  return "shown";
}

/** Applies the same display text to each route retry and the scheduled refresh. */
export async function deliverExecutionNoticeWithRetry(input: {
  displayNotice: string;
  render(notice: string): "shown" | "retry" | "skip";
  refresh(notice: string): void;
  deadline: number;
  now(): number;
  retryIntervalMs: number;
  wait(ms: number): Promise<void>;
}): Promise<"shown" | "retry" | "skip"> {
  let outcome = input.render(input.displayNotice);
  while (outcome === "retry" && input.now() < input.deadline) {
    await input.wait(input.retryIntervalMs);
    outcome = input.render(input.displayNotice);
  }
  if (outcome === "shown") input.refresh(input.displayNotice);
  return outcome;
}
