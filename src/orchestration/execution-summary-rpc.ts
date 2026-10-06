import { sessionBindingKey } from "./admission.ts";
import { summarizeExecutionRun, type ExecutionSummary } from "./summary.ts";

const summarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["available"],
  properties: {
    available: { type: "boolean" },
    taskState: { type: "string", maxLength: 40 },
    route: { type: "string", maxLength: 200 },
    round: { type: "integer", minimum: 0 },
    maxRounds: { type: "integer", minimum: 1 },
    progress: { type: "string", maxLength: 80 },
    recoveryEvents: {
      type: "array",
      maxItems: 5,
      items: { type: "string", maxLength: 120 },
    },
    outcome: { type: "string", enum: ["completed", "failed", "stopped", "limit-reached"] },
    detail: { type: "string", maxLength: 200 },
  },
} as const;

/** Read-only status surface. It has no dispatch, write, wake, or resume method. */
export const ExecutionSummaryRpc = {
  id: "opjev.execution-summary.v1",
  methods: {
    getActiveSummary: {
      input: {
        type: "object",
        additionalProperties: false,
        required: ["sessionID"],
        properties: {
          sessionID: { type: "string", minLength: 4, maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" },
        },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: { summary: summarySchema },
      },
    },
  },
  events: {},
} as const;

interface SummaryStorage {
  get(key: string): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeRunID(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

function safeSessionID(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 4 || value.length > 200) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

/** Resolves only the currently bound run and returns its bounded summary. */
export function createExecutionSummaryHandler(deps: {
  storage: SummaryStorage;
}): (input: unknown) => Promise<{ summary: ExecutionSummary }> {
  return async (input) => {
    try {
      const sessionID = safeSessionID(record(input)?.sessionID);
      if (!sessionID) return { summary: { available: false } };
      const binding = record(await deps.storage.get(sessionBindingKey(sessionID)));
      const runID = safeRunID(binding?.runID);
      if (!runID) return { summary: { available: false } };
      const persisted = await deps.storage.get(`orchestration/run/${runID}`);
      return { summary: summarizeExecutionRun(persisted) };
    } catch {
      return { summary: { available: false } };
    }
  };
}
