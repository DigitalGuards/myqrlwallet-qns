import { registrationSteps, type RegistrationState, type TransactionUpdate } from "@qns/sdk";
import type { PendingClaim } from "./storage";

export type RecoveryCheck =
  | { status: "pending" | "confirmed" | "replaced" | "not found" }
  | { status: "mismatched" | "reverted" | "error"; message: string };

export interface RecoveryChecks {
  original: RecoveryCheck | null;
  // Each entry is the latest result for that hash. Tracking replaces the saved claim's hash.
  tracked: ReadonlyMap<string, RecoveryCheck>;
}

export type RecoveryRecords =
  | { status: "read"; state: Pick<RegistrationState, "complete"> }
  | { status: "error"; message: string };

export interface RecoveryDecision {
  next: "check" | "read" | "keep" | "delete";
  pending: PendingClaim | null;
  updates: TransactionUpdate[];
  message: string | null;
  showFinished: boolean;
}

/** Decide from this check's evidence; saved tracker statuses carry no fresh settlement proof. */
export function decideRecovery(
  saved: PendingClaim,
  checks: RecoveryChecks,
  stateOnly = false,
  records: RecoveryRecords | null = null,
): RecoveryDecision {
  const update = { ...saved.update };
  delete update.message;
  const inFlight = ["approval", "pending", "unconfirmed"].includes(saved.update.status);
  const checked =
    (saved.update.hash ? checks.tracked.get(saved.update.hash.toLowerCase()) : undefined) ??
    checks.original;
  const result: RecoveryCheck | null =
    stateOnly && !inFlight
      ? { status: saved.update.status === "replaced" ? "replaced" : "confirmed" }
      : checked;
  const keep = (
    current: TransactionUpdate,
    message: string | null,
    next: "check" | "read" | "keep" = "keep",
  ): RecoveryDecision => ({
    next,
    pending: { ...saved, update: current },
    updates: [current],
    message,
    showFinished: false,
  });

  if (!result) return { ...keep(saved.update, null, "check"), updates: [] };
  if (result.status === "error") return { ...keep(saved.update, result.message), updates: [] };
  if (result.status === "mismatched")
    return keep({ ...update, status: "mismatched" }, result.message);
  if (result.status === "reverted")
    return {
      next: "delete",
      pending: null,
      updates: [{ ...update, status: "failed", message: result.message }],
      message: result.message,
      showFinished: false,
    };

  const status = result.status === "not found" ? "pending" : result.status;
  const checkedUpdate: TransactionUpdate = {
    ...update,
    status:
      status === "confirmed" ? "verifying" : status === "replaced" ? "replaced" : "unconfirmed",
  };
  if (!records) return keep(checkedUpdate, null, "read");
  if (records.status === "error")
    return keep(
      status === "pending"
        ? checkedUpdate
        : {
            ...update,
            status: status === "confirmed" ? "verification-failed" : "replaced",
            message: records.message,
          },
      records.message,
    );
  if (status === "pending")
    return keep(
      checkedUpdate,
      "Confirmation is still pending. Re-check name state or discard pending state to continue.",
    );
  if (!stateOnly && status === "confirmed" && !records.state.complete[update.step]) {
    const message =
      "The expected name record is still incomplete. Re-check name state to continue.";
    return keep({ ...update, status: "incomplete", message }, message);
  }

  const steps = registrationSteps.filter((step) => step !== "primary" || saved.primary);
  const showFinished = steps.every((step) => records.state.complete[step]);
  return {
    next: "delete",
    pending: null,
    updates: steps
      .filter((step) => records.state.complete[step])
      .map((step) => ({ step, status: "skipped" })),
    message: showFinished
      ? null
      : status === "replaced"
        ? "The saved nonce has been used. Name records were checked; continue from the first incomplete step."
        : "Name records were checked. Continue from the first incomplete step.",
    showFinished,
  };
}
