import {
  canonicalAddress,
  registrationName,
  registrationSteps,
  type NetworkConfig,
  type PlannedClear,
  type TransactionUpdate,
  type TransactionStatus,
} from "@qns/sdk";
import { isRecord } from "./rpc";

function key(config: NetworkConfig, kind: string): string {
  return `qns:${kind}:${config.chainId}:${config.genesisHash ?? "local"}:${config.contracts.QNSRegistry ?? "pending"}`;
}

export function knownNames(config: NetworkConfig): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(config, "names")) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item: unknown): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function rememberName(config: NetworkConfig, name: string): void {
  try {
    localStorage.setItem(
      key(config, "names"),
      JSON.stringify(
        [...new Set([...knownNames(config), registrationName(name).name])].slice(-1000),
      ),
    );
  } catch {
    /* Ownership remains available from chain logs when storage is disabled. */
  }
}

export interface PendingClaim {
  readonly name: string;
  readonly account: string;
  readonly update: TransactionUpdate;
  readonly primary?: boolean;
  readonly attemptId?: string;
  readonly trackedHash?: string;
}

function pendingKey(config: NetworkConfig, account: string): string {
  return `${key(config, "pending")}:${config.genesisHash ?? config.rpcUrl}:${canonicalAddress(account)}`;
}

// Reload keeps settled outcomes terminal and resumes unfinished wallet requests as uncertain.
const restoredStatuses = {
  approval: "unconfirmed",
  pending: "unconfirmed",
  verifying: "verification-failed",
  unconfirmed: "unconfirmed",
  confirmed: "confirmed",
  skipped: "skipped",
  failed: "failed",
  mismatched: "mismatched",
  replaced: "replaced",
  incomplete: "incomplete",
  "verification-failed": "verification-failed",
} satisfies Record<TransactionStatus, TransactionStatus>;

export function readPendingClaim(
  config: NetworkConfig,
  account: string | null,
): PendingClaim | null {
  if (!account) return null;
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(pendingKey(config, account)) ??
        localStorage.getItem(key(config, "pending")) ??
        "null",
    );
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      typeof value.account !== "string" ||
      !isRecord(value.update)
    )
      return null;
    if (canonicalAddress(value.account) !== canonicalAddress(account)) return null;
    const { step, hash, nonce, requestId, status: savedStatus } = value.update;
    const knownStep = registrationSteps.find((item) => item === step);
    if (
      knownStep === undefined ||
      (hash !== undefined && (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)))
    )
      return null;
    if (
      nonce !== undefined &&
      (typeof nonce !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(nonce))
    )
      return null;
    if (
      requestId !== undefined &&
      !(typeof requestId === "string" && requestId.length > 0) &&
      !(typeof requestId === "number" && Number.isSafeInteger(requestId))
    )
      return null;
    return {
      name: registrationName(value.name).name,
      account: canonicalAddress(value.account),
      primary: value.primary === true || step === "primary",
      ...(typeof value.attemptId === "string" ? { attemptId: value.attemptId } : {}),
      ...(typeof value.trackedHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.trackedHash)
        ? { trackedHash: value.trackedHash }
        : {}),
      update: {
        step: knownStep,
        ...(typeof hash === "string" ? { hash } : {}),
        ...(typeof nonce === "string" ? { nonce } : {}),
        ...(typeof requestId === "string" || typeof requestId === "number" ? { requestId } : {}),
        status:
          Object.entries(restoredStatuses).find(([status]) => status === savedStatus)?.[1] ??
          "unconfirmed",
        ...(typeof value.update.message === "string" ? { message: value.update.message } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function savePendingClaim(
  config: NetworkConfig,
  pending: PendingClaim | null,
  account = pending?.account,
): void {
  if (!account) throw new Error("An account is required for pending state");
  try {
    if (pending) localStorage.setItem(pendingKey(config, account), JSON.stringify(pending));
    else localStorage.removeItem(pendingKey(config, account));
    const legacy: unknown = JSON.parse(localStorage.getItem(key(config, "pending")) ?? "null");
    if (isRecord(legacy) && canonicalAddress(legacy.account) === canonicalAddress(account))
      localStorage.removeItem(key(config, "pending"));
  } catch {
    /* The visible transaction link remains available for this session. */
  }
}

function clearKey(config: NetworkConfig, account: string): string {
  return `${key(config, "clear")}:${config.genesisHash ?? config.rpcUrl}:${canonicalAddress(account)}`;
}

function plannedClears(config: NetworkConfig, account: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(clearKey(config, account)) ?? "{}");
    if (!isRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] =>
          /^0x[0-9a-f]{64}$/.test(entry[0]) &&
          typeof entry[1] === "string" &&
          /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

/**
 * The clear a claim of an unowned name planned, with the record version read at that time.
 * A resumed claim by the same account carries it; without storage a resumed claim has no clear.
 */
export function plannedClear(
  config: NetworkConfig,
  account: string,
  node: string,
): PlannedClear | null {
  const version = plannedClears(config, account)[node];
  return version === undefined ? null : { version };
}

export function savePlannedClear(
  config: NetworkConfig,
  account: string,
  node: string,
  version: string,
): void {
  try {
    localStorage.setItem(
      clearKey(config, account),
      JSON.stringify({ ...plannedClears(config, account), [node]: version }),
    );
  } catch {
    /* Without storage a resumed claim plans no clear. */
  }
}

export function dropPlannedClear(config: NetworkConfig, account: string, node: string): void {
  try {
    const rest = Object.fromEntries(
      Object.entries(plannedClears(config, account)).filter(([saved]) => saved !== node),
    );
    if (Object.keys(rest).length === 0) localStorage.removeItem(clearKey(config, account));
    else localStorage.setItem(clearKey(config, account), JSON.stringify(rest));
  } catch {
    /* Nothing to remove when storage is disabled. */
  }
}
