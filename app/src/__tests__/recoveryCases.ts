export type CheckResult =
  "pending" | "mismatched" | "confirmed" | "reverted" | "replaced" | "not found";
export const results: CheckResult[] = [
  "pending",
  "mismatched",
  "confirmed",
  "reverted",
  "replaced",
  "not found",
];

export function settles(result: CheckResult): boolean {
  return result === "confirmed" || result === "reverted" || result === "replaced";
}

function allSequences(): CheckResult[][] {
  let level: CheckResult[][] = [[]];
  const sequences: CheckResult[][] = [];
  for (let length = 1; length <= 4; length++) {
    level = level.flatMap((prefix) => results.map((result) => [...prefix, result]));
    sequences.push(...level);
  }
  return sequences;
}

export const trackingModes = ["original", "same hash", "earlier identical calldata"] as const;
export type TrackingMode = (typeof trackingModes)[number];
export const recoveryCases = allSequences().flatMap((sequence) =>
  trackingModes.flatMap((tracking) =>
    [false, true].flatMap((receiptLookupFailed) =>
      [false, true].map((reload) => ({
        sequence,
        trace: sequence.join(" / "),
        tracking,
        tracked: tracking !== "original",
        receiptLookupFailed,
        reload,
      })),
    ),
  ),
);

export const retryCases = results.flatMap((result) =>
  ["confirmed", "replaced"].flatMap((previous) =>
    [false, true].flatMap((tracked) =>
      [false, true].map((reload) => ({ result, previous, tracked, reload })),
    ),
  ),
);

// Fifteen traces cover all six outcomes at every reachable step, in all four modes.
const unfinished: CheckResult[] = ["pending", "mismatched", "not found"];
const sampleSequences = [
  ...Array.from({ length: 4 }, (_, step) =>
    results
      .filter(settles)
      .map((terminal, offset) => [
        ...Array.from(
          { length: step },
          (_, index) => unfinished[(index + offset) % 3] ?? "pending",
        ),
        terminal,
      ]),
  ).flat(),
  ...unfinished.map((_, offset) =>
    Array.from({ length: 4 }, (_, index) => unfinished[(index + offset) % 3] ?? "pending"),
  ),
];
const sampleTraces = new Set(sampleSequences.map((sequence) => sequence.join(" / ")));
export const renderedRecoveryCases = recoveryCases.filter(
  ({ trace, tracking, receiptLookupFailed }) =>
    tracking === "earlier identical calldata"
      ? trace === "pending / mismatched / not found / confirmed"
      : receiptLookupFailed && sampleTraces.has(trace),
);
export const renderedRetryCases = retryCases.filter(
  ({ result, previous, tracked, reload }) =>
    tracked === (results.indexOf(result) % 2 === 0) && reload === (previous === "replaced"),
);
