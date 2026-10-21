import { beforeEach, expect, it } from "vitest";
import { ACCOUNT, OTHER, config } from "../../sdk/src/__tests__/mockProvider";
import { readPendingClaim, savePendingClaim } from "./storage";

beforeEach(() => {
  localStorage.clear();
});

it("isolates pending claims by account, chain, genesis and deployment", () => {
  const pending = {
    name: "alice.qrl",
    account: ACCOUNT,
    primary: true,
    update: { step: "register", status: "unconfirmed", nonce: "0x7", requestId: "request-one" },
  } as const;
  savePendingClaim(config, pending);
  expect(readPendingClaim(config, ACCOUNT)).toEqual(pending);
  for (const other of [
    { ...config, chainId: config.chainId + 1 },
    { ...config, rpcUrl: "http://localhost:32003" },
    { ...config, genesisHash: `0x${"a".repeat(64)}` },
    { ...config, contracts: { ...config.contracts, QNSRegistry: OTHER } },
  ]) {
    expect(readPendingClaim(other, ACCOUNT)).toBeNull();
    savePendingClaim(other, { ...pending, name: "bob.qrl" });
    expect(readPendingClaim(other, ACCOUNT)?.name).toBe("bob.qrl");
  }
  expect(readPendingClaim(config, OTHER)).toBeNull();
  expect(readPendingClaim(config, null)).toBeNull();
  expect(readPendingClaim(config, ACCOUNT)?.name).toBe("alice.qrl");
  savePendingClaim(config, null, ACCOUNT);
  expect(readPendingClaim(config, ACCOUNT)).toBeNull();
});

it("recovers legacy records for their owner and retires them on discard", () => {
  const key = `qns:pending:${config.chainId}:local:${config.contracts.QNSRegistry ?? "pending"}`;
  localStorage.setItem(
    key,
    JSON.stringify({ name: "alice.qrl", account: ACCOUNT, update: { step: "register" } }),
  );
  expect(readPendingClaim(config, OTHER)).toBeNull();
  expect(readPendingClaim(config, ACCOUNT)?.name).toBe("alice.qrl");
  savePendingClaim(config, null, ACCOUNT);
  expect(readPendingClaim(config, ACCOUNT)).toBeNull();
});

it.each([false, true])("stores tracking independently of a submitted hash (known=%s)", (known) => {
  const hash = `0x${"d".repeat(64)}`;
  const trackedHash = `0x${"e".repeat(64)}`;
  const pending = {
    name: "alice.qrl",
    account: ACCOUNT,
    primary: true,
    attemptId: "original-attempt",
    update: {
      step: "primary",
      status: "unconfirmed",
      requestId: "original-request",
      ...(known ? { hash, nonce: "0x7" } : {}),
    },
  } as const;
  savePendingClaim(config, pending);
  savePendingClaim(config, { ...pending, trackedHash });
  expect(readPendingClaim(config, ACCOUNT)).toEqual({ ...pending, trackedHash });
  savePendingClaim(config, { ...pending, trackedHash: hash });
  expect(readPendingClaim(config, ACCOUNT)?.update).toEqual(pending.update);
  expect(readPendingClaim(config, ACCOUNT)?.attemptId).toBe(pending.attemptId);
  savePendingClaim(config, { ...pending, trackedHash: "invalid" });
  expect(readPendingClaim(config, ACCOUNT)).toEqual(pending);
});
