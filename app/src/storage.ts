import {
  canonicalAddress,
  registrationName,
  type NetworkConfig,
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
    if (
      (step !== "register" &&
        step !== "resolver" &&
        step !== "address" &&
        step !== "name" &&
        step !== "primary") ||
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
        step,
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
