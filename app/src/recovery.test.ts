import { beforeEach, expect, it } from "vitest";
import { ACCOUNT, config } from "../../sdk/src/__tests__/mockProvider";
import {
  decideRecovery,
  type RecoveryCheck,
  type RecoveryChecks,
  type RecoveryRecords,
} from "./recovery";
import { readPendingClaim, savePendingClaim, type PendingClaim } from "./storage";
import {
  recoveryCases,
  renderedRecoveryCases,
  results,
  retryCases,
  settles,
  type CheckResult,
} from "./__tests__/recoveryCases";

const hash = `0x${"d".repeat(64)}`;
const otherHash = `0x${"e".repeat(64)}`;
const complete = { register: true, resolver: true, address: true, name: true, primary: true };
const readyRecords: RecoveryRecords = { status: "read", state: { complete } };
const unavailable: RecoveryRecords = {
  status: "error",
  message: "Name records temporarily unavailable",
};

function claim(knownNonce = false): PendingClaim {
  return {
    name: "alice.qrl",
    account: ACCOUNT,
    primary: true,
    attemptId: "claim-attempt",
    update: {
      step: "primary",
      status: "unconfirmed",
      requestId: "claim-request",
      hash,
      ...(knownNonce ? { nonce: "0x7" } : {}),
    },
  };
}

function checked(result: CheckResult): RecoveryCheck {
  if (result === "mismatched" || result === "reverted")
    return {
      status: result,
      message: result === "reverted" ? "Transaction reverted" : "Transaction does not match",
    };
  return { status: result };
}

function evidence(result: RecoveryCheck | null, tracked: boolean): RecoveryChecks {
  return {
    original: tracked ? null : result,
    tracked: tracked && result ? new Map([[hash, result]]) : new Map(),
  };
}

function persist(saved: PendingClaim | null, reload: boolean): PendingClaim | null {
  savePendingClaim(config, saved, ACCOUNT);
  const restored = readPendingClaim(config, ACCOUNT);
  expect(restored).toEqual(saved);
  return reload ? restored : saved;
}

beforeEach(() => {
  localStorage.clear();
});

it("enumerates all 6,216 sequence combinations and 48 retries", () => {
  expect(recoveryCases).toHaveLength(4 * (6 + 6 ** 2 + 6 ** 3 + 6 ** 4));
  expect(
    new Set(
      recoveryCases.map(
        ({ trace, tracked, reload }) => `${trace}:${String(tracked)}:${String(reload)}`,
      ),
    ).size,
  ).toBe(6216);
  expect(retryCases).toHaveLength(48);
});

it("renders every outcome at every reachable step for both hash sources and reload modes", () => {
  expect(renderedRecoveryCases).toHaveLength(60);
  const covered = new Set<string>();
  for (const { sequence, tracked, reload } of renderedRecoveryCases) {
    for (const [step, result] of sequence.entries()) {
      covered.add(`${step}:${result}:${String(tracked)}:${String(reload)}`);
      if (settles(result)) break;
    }
  }
  for (let step = 0; step < 4; step++)
    for (const result of results)
      for (const tracked of [false, true])
        for (const reload of [false, true])
          expect(covered.has(`${step}:${result}:${String(tracked)}:${String(reload)}`)).toBe(true);
});

it.each(recoveryCases)(
  "requires settlement after every check: $trace (tracked=$tracked, reload=$reload)",
  ({ sequence, tracked, reload }) => {
    let saved: PendingClaim | null = persist(claim(), reload);
    let settled = false;
    let showFinished = false;
    for (const result of sequence) {
      if (saved) {
        const before = structuredClone(saved);
        const decision = decideRecovery(
          saved,
          evidence(checked(result), tracked),
          false,
          readyRecords,
        );
        expect(saved).toEqual(before);
        // This oracle uses only the current RPC outcome, independent of the recovery decision.
        settled = settles(result);
        showFinished = result === "confirmed" || result === "replaced";
        expect(decision.next).toBe(settled ? "delete" : "keep");
        expect(decision.showFinished).toBe(showFinished);
        if (!settled) {
          expect(decision.pending).toEqual({
            ...claim(),
            update: {
              ...claim().update,
              status: result === "mismatched" ? "mismatched" : "unconfirmed",
            },
          });
          expect(decision.updates).toEqual([decision.pending?.update]);
        }
        if (result === "reverted")
          expect(decision.updates).toEqual([
            { ...claim().update, status: "failed", message: "Transaction reverted" },
          ]);
        if (showFinished)
          expect(decision.updates).toEqual(
            Object.keys(complete).map((step) => ({ step, status: "skipped" })),
          );
        saved = persist(decision.pending, reload);
        if (reload && saved) {
          const restored = decideRecovery(saved, evidence(null, tracked));
          expect(restored.pending).toEqual(saved);
          expect(restored.next).toBe("check");
          expect(restored.showFinished).toBe(false);
        }
      }
      // Settlement closes the flow, so later sequence inputs have no check action.
      expect(saved === null).toBe(settled);
      expect(showFinished && !settled).toBe(false);
    }
  },
);

it.each(retryCases)(
  "uses fresh $result after $previous and a record read failure (tracked=$tracked, reload=$reload)",
  ({ result, previous, tracked, reload }) => {
    const first = decideRecovery(
      claim(true),
      evidence(checked(previous === "confirmed" ? "confirmed" : "replaced"), tracked),
      false,
      unavailable,
    );
    expect(first.pending?.update).toMatchObject({
      status: previous === "confirmed" ? "verification-failed" : "replaced",
      message: unavailable.message,
    });
    expect(first.showFinished).toBe(false);
    const saved = persist(first.pending, reload);
    if (!saved) throw new Error("Missing recovery after a record read failure");
    const decision = decideRecovery(saved, evidence(checked(result), tracked), false, readyRecords);
    expect(decision.pending === null).toBe(settles(result));
    expect(decision.showFinished).toBe(result === "confirmed" || result === "replaced");
    if (!settles(result))
      expect(decision.pending).toEqual({
        ...claim(true),
        update: {
          ...claim(true).update,
          status: result === "mismatched" ? "mismatched" : "unconfirmed",
        },
      });
    persist(decision.pending, reload);
  },
);

it.each([false, true])(
  "permits explicit name-state recovery after a mismatch (reload=%s)",
  (reload) => {
    const mismatch = decideRecovery(
      claim(),
      evidence(checked("mismatched"), true),
      false,
      readyRecords,
    );
    const saved = persist(mismatch.pending, reload);
    if (!saved) throw new Error("Missing mismatched recovery");
    const decision = decideRecovery(saved, evidence(null, true), true, readyRecords);
    expect(decision.pending).toBeNull();
    expect(decision.showFinished).toBe(true);
  },
);

it.each(["pending", "not found"] satisfies CheckResult[])(
  "keeps a fresh %s tracked hash despite settled results for other hashes",
  (result) => {
    const checks: RecoveryChecks = {
      original: checked("confirmed"),
      tracked: new Map([
        [otherHash, checked("replaced")],
        [hash, checked(result)],
      ]),
    };
    const decision = decideRecovery(claim(), checks, false, readyRecords);
    expect(decision.pending?.update.status).toBe("unconfirmed");
    expect(decision.showFinished).toBe(false);
    expect(checks.tracked.get(hash)).toEqual(checked(result));
  },
);

it.each(["approval", "pending", "unconfirmed"] as const)(
  "checks an unresolved %s request during name-state recovery",
  (status) => {
    const saved = { ...claim(), update: { ...claim().update, status } };
    expect(decideRecovery(saved, evidence(null, false), true).next).toBe("check");
    const decision = decideRecovery(saved, evidence(checked("pending"), false), true, readyRecords);
    expect(decision.pending?.update.status).toBe("unconfirmed");
    expect(decision.showFinished).toBe(false);
  },
);

it("keeps confirmed incomplete records until explicit name-state recovery", () => {
  const records: RecoveryRecords = {
    status: "read",
    state: { complete: { ...complete, primary: false } },
  };
  const decision = decideRecovery(claim(), evidence(checked("confirmed"), false), false, records);
  expect(decision.pending?.update.status).toBe("incomplete");
  expect(decision.showFinished).toBe(false);
  const saved = decision.pending;
  if (!saved) throw new Error("Missing incomplete recovery");
  const resumed = decideRecovery(saved, evidence(null, false), true, records);
  expect(resumed.pending).toBeNull();
  expect(resumed.showFinished).toBe(false);
  expect(resumed.updates).toHaveLength(4);
  const ready = decideRecovery({ ...saved, primary: false }, evidence(null, false), true, records);
  expect(ready.showFinished).toBe(true);
});

it("preserves saved recovery on a check error and clears stale messages once a check succeeds", () => {
  const saved = {
    ...claim(),
    update: {
      ...claim().update,
      status: "verification-failed" as const,
      message: "Earlier failure",
    },
  };
  const error = decideRecovery(
    saved,
    evidence({ status: "error", message: "RPC unavailable" }, false),
  );
  expect(error.pending).toEqual(saved);
  expect(error.updates).toEqual([]);
  expect(error.showFinished).toBe(false);
  const reading = decideRecovery(saved, evidence(checked("pending"), false));
  expect(reading.next).toBe("read");
  expect(reading.pending?.update).toEqual(claim().update);
  const failedRead = decideRecovery(saved, evidence(checked("pending"), false), false, unavailable);
  expect(failedRead.pending?.update).toEqual(claim().update);
  expect(failedRead.message).toBe(unavailable.message);
});
