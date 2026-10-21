import {
  addressWord,
  bytes32Word,
  call,
  canonicalAddress,
  decodeAddress,
  decodeBool,
  decodeString,
  hashText,
  isHash,
  isRecord,
  quantity,
  nodeStringArguments,
  selector,
  stringArgument,
  toQuantity,
  ZERO_ADDRESS,
} from "./abi.js";
import { assertNetwork, CONTRACT_NAMES, requireContract, type NetworkConfig } from "./config.js";
import { isHexBytes } from "./guards.js";
import { namehash, nodeToHex } from "./namehash.js";
import { normalize, QnsNameError } from "./normalize.js";
import { resolveName, verifyReverse, type RpcProvider } from "./resolver.js";

export function registrationName(input: string): {
  name: string;
  label: string;
  labelHash: string;
  node: string;
} {
  const normalized = normalize(input);
  const label = normalized.endsWith(".qrl") ? normalized.slice(0, -4) : normalized;
  if (!label || label.includes("."))
    throw new QnsNameError("Enter one name, such as alice or alice.qrl");
  const name = `${label}.qrl`;
  return { name, label, labelHash: hashText(label), node: nodeToHex(namehash(name)) };
}

export interface RegistrationContext {
  config: NetworkConfig;
  provider: RpcProvider;
}

export async function nameOwner(
  input: string,
  context: RegistrationContext,
): Promise<string | null> {
  const owner = decodeAddress(
    await call(
      context.provider,
      requireContract(context.config, "QNSRegistry"),
      "owner(bytes32)",
      bytes32Word(registrationName(input).node),
    ),
  );
  return owner === ZERO_ADDRESS ? null : owner;
}

export async function isAvailable(input: string, context: RegistrationContext): Promise<boolean> {
  const { labelHash } = registrationName(input);
  return decodeBool(
    await call(
      context.provider,
      requireContract(context.config, "FIFSQRLRegistrar"),
      "available(bytes32)",
      bytes32Word(labelHash),
    ),
  );
}

/** Check code and wiring before offering writes. No deployment transactions are sent. */
export async function assertDeployment(context: RegistrationContext): Promise<void> {
  const { provider, config } = context;
  await assertNetwork(provider, config);
  for (const contract of CONTRACT_NAMES) {
    const code = await provider.request({
      method: "qrl_getCode",
      params: [requireContract(config, contract), "latest"],
    });
    if (!isHexBytes(code) || code === "0x" || /^0x0+$/.test(code))
      throw new Error(`No contract code for ${contract}`);
  }
  const registry = requireContract(config, "QNSRegistry");
  const registrar = requireContract(config, "FIFSQRLRegistrar");
  const resolver = requireContract(config, "QRLPublicResolver");
  const reverse = requireContract(config, "ReverseRegistrar");
  for (const address of [registrar, resolver, reverse]) {
    if (decodeAddress(await call(provider, address, "qns()")) !== registry)
      throw new Error("QNS registry wiring mismatch");
  }
  const tld = nodeToHex(namehash("qrl"));
  if (
    (await call(provider, registrar, "baseNode()")) !== `0x${bytes32Word(tld)}` ||
    decodeAddress(await call(provider, registry, "owner(bytes32)", bytes32Word(tld))) !==
      registrar ||
    decodeAddress(
      await call(
        provider,
        registry,
        "owner(bytes32)",
        bytes32Word(nodeToHex(namehash("addr.reverse"))),
      ),
    ) !== reverse ||
    decodeAddress(await call(provider, reverse, "defaultResolver()")) !== resolver ||
    decodeAddress(await call(provider, resolver, "trustedReverseRegistrar()")) !== reverse
  ) {
    throw new Error("QNS registrar or resolver wiring mismatch");
  }
}

export type RegistrationStep = "register" | "resolver" | "address" | "name" | "primary";
export type TransactionStatus =
  "approval" | "pending" | "confirmed" | "skipped" | "failed" | "unconfirmed";
export interface TransactionUpdate {
  step: RegistrationStep;
  status: TransactionStatus;
  hash?: string;
  nonce?: string;
  requestId?: string | number;
  message?: string;
}

/** Expected zero-value call, shared by submission and recovery. */
export function registrationTransaction(
  input: string,
  account: string,
  step: RegistrationStep,
  config: NetworkConfig,
): { from: string; to: string; data: string; chainId: string; value: string } {
  const { name, node, labelHash } = registrationName(input);
  const from = canonicalAddress(account);
  const resolver = requireContract(config, "QRLPublicResolver");
  const calls = {
    register: {
      to: requireContract(config, "FIFSQRLRegistrar"),
      data: selector("register(bytes32,address)") + bytes32Word(labelHash) + addressWord(from),
    },
    resolver: {
      to: requireContract(config, "QNSRegistry"),
      data: selector("setResolver(bytes32,address)") + bytes32Word(node) + addressWord(resolver),
    },
    address: {
      to: resolver,
      data: selector("setAddr(bytes32,address)") + bytes32Word(node) + addressWord(from),
    },
    name: {
      to: resolver,
      data: selector("setName(bytes32,string)") + nodeStringArguments(node, name),
    },
    primary: {
      to: requireContract(config, "ReverseRegistrar"),
      data: selector("setName(string)") + stringArgument(name),
    },
  };
  return { from, ...calls[step], chainId: toQuantity(BigInt(config.chainId)), value: "0x0" };
}

export interface RegistrationState {
  owner: string | null;
  resolver: string;
  address: string | null;
  spelling: string | null;
  primary: string | null;
  complete: Record<RegistrationStep, boolean>;
}

/** Read every postcondition at one block so recovery also works for replacement hashes. */
export async function readRegistrationState(
  input: string,
  account: string,
  context: RegistrationContext,
): Promise<RegistrationState> {
  await assertNetwork(context.provider, context.config);
  const block = toQuantity(quantity(await context.provider.request({ method: "qrl_blockNumber" })));
  const provider: RpcProvider = {
    request: (args) =>
      context.provider.request(
        args.method === "qrl_call" ? { ...args, params: [args.params?.[0], block] } : args,
      ),
  };
  const { name, node } = registrationName(input);
  const owner = await nameOwner(name, { ...context, provider });
  const registry = requireContract(context.config, "QNSRegistry");
  const resolver = decodeAddress(
    await call(provider, registry, "resolver(bytes32)", bytes32Word(node)),
  );
  const address =
    resolver === ZERO_ADDRESS
      ? null
      : decodeAddress(await call(provider, resolver, "addr(bytes32)", bytes32Word(node)));
  const spelling =
    resolver === ZERO_ADDRESS
      ? null
      : decodeString(await call(provider, resolver, "name(bytes32)", bytes32Word(node)));
  const primary = await verifyReverse(account, { registry, provider });
  const owned = owner === canonicalAddress(account);
  const selected = owned && resolver === requireContract(context.config, "QRLPublicResolver");
  const forward = selected && address === canonicalAddress(account);
  await assertNetwork(context.provider, context.config);
  return {
    owner,
    resolver,
    address,
    spelling,
    primary,
    complete: {
      register: owned,
      resolver: selected,
      address: forward,
      name: forward && spelling === name,
      primary: forward && primary === name,
    },
  };
}

type ExpectedTransaction = ReturnType<typeof registrationTransaction> & { nonce?: string };

async function transactionNonce(
  hash: string,
  expected: ExpectedTransaction,
  provider: RpcProvider,
): Promise<string | null> {
  const tx = await provider.request({ method: "qrl_getTransactionByHash", params: [hash] });
  if (tx === null) return null;
  try {
    if (
      !isRecord(tx) ||
      typeof tx.hash !== "string" ||
      tx.hash.toLowerCase() !== hash.toLowerCase() ||
      canonicalAddress(tx.from) !== expected.from ||
      canonicalAddress(tx.to) !== expected.to ||
      typeof tx.input !== "string" ||
      tx.input.toLowerCase() !== expected.data.toLowerCase() ||
      quantity(tx.chainId) !== quantity(expected.chainId) ||
      quantity(tx.value) !== 0n ||
      (expected.nonce !== undefined && quantity(tx.nonce) !== quantity(expected.nonce))
    ) {
      throw new Error("mismatch");
    }
    return toQuantity(quantity(tx.nonce));
  } catch {
    throw new Error(
      "This transaction does not match the pending step (sender, contract, calldata, chain or nonce).",
    );
  }
}

export async function isNonceConsumed(
  account: string,
  nonce: string,
  context: RegistrationContext,
): Promise<boolean> {
  await assertNetwork(context.provider, context.config);
  const confirmed = quantity(
    await context.provider.request({
      method: "qrl_getTransactionCount",
      params: [canonicalAddress(account), "latest"],
    }),
  );
  return confirmed > quantity(nonce);
}

/** A receipt is accepted only for this exact operation on the configured network. */
export async function checkRegistrationTransaction(
  input: string,
  account: string,
  update: TransactionUpdate,
  context: RegistrationContext,
): Promise<"confirmed" | "pending" | "replaced"> {
  await assertNetwork(context.provider, context.config);
  if (update.hash) {
    try {
      await waitForReceipt(update.hash, {
        provider: context.provider,
        receiptTimeoutMs: 0,
        expected: {
          ...registrationTransaction(input, account, update.step, context.config),
          ...(update.nonce !== undefined ? { nonce: update.nonce } : {}),
        },
      });
      await assertNetwork(context.provider, context.config);
      return "confirmed";
    } catch (error) {
      if (error instanceof ReplacedTransactionError) return "replaced";
      if (!(error instanceof PendingTransactionError)) throw error;
    }
  }
  return update.nonce !== undefined && (await isNonceConsumed(account, update.nonce, context))
    ? "replaced"
    : "pending";
}

export interface RegistrationOptions extends RegistrationContext {
  wallet: RpcProvider;
  account: string;
  transport: "extension" | "relay";
  primary: boolean;
  onUpdate: (update: TransactionUpdate) => void;
  onState?: (state: RegistrationState) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  receiptTimeoutMs?: number;
}

export class PendingTransactionError extends Error {
  constructor(public readonly hash: string) {
    super("Confirmation is still pending. Check the transaction before retrying.");
    this.name = "PendingTransactionError";
  }
}

export class ReplacedTransactionError extends Error {
  constructor() {
    super("The saved nonce has been used by another transaction. Re-check name state to continue.");
    this.name = "ReplacedTransactionError";
  }
}

export async function waitForReceipt(
  hash: string,
  options: Pick<
    RegistrationOptions,
    "provider" | "signal" | "pollIntervalMs" | "receiptTimeoutMs"
  > & { expected?: ExpectedTransaction; onNonce?: (nonce: string) => void },
): Promise<void> {
  const until = Date.now() + (options.receiptTimeoutMs ?? 600_000);
  let expected = options.expected;
  do {
    options.signal?.throwIfAborted();
    const receipt = await options.provider.request({
      method: "qrl_getTransactionReceipt",
      params: [hash],
    });
    if (expected && (receipt !== null || expected.nonce === undefined)) {
      const nonce = await transactionNonce(hash, expected, options.provider);
      if (nonce !== null) {
        if (expected.nonce !== nonce) options.onNonce?.(nonce);
        expected = { ...expected, nonce };
      } else if (receipt !== null) throw new PendingTransactionError(hash);
    }
    if (receipt !== null) {
      if (!isRecord(receipt) || receipt.transactionHash !== hash || !isHash(receipt.blockHash))
        throw new Error("Invalid transaction receipt");
      quantity(receipt.blockNumber);
      const status = quantity(receipt.status);
      if (status === 0n) throw new Error("Transaction reverted");
      if (status !== 1n) throw new Error("Invalid transaction status");
      return;
    }
    if (expected?.nonce !== undefined) {
      const chain = quantity(await options.provider.request({ method: "qrl_chainId" }));
      if (chain !== quantity(expected.chainId))
        throw new Error("Network changed while waiting for confirmation");
      const confirmed = quantity(
        await options.provider.request({
          method: "qrl_getTransactionCount",
          params: [expected.from, "latest"],
        }),
      );
      if (confirmed > quantity(expected.nonce)) throw new ReplacedTransactionError();
    }
    if (Date.now() >= until) break;
    await new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 3000));
  } while (Date.now() <= until);
  throw new PendingTransactionError(hash);
}

async function assertSigner(options: RegistrationOptions): Promise<void> {
  options.signal?.throwIfAborted();
  await assertNetwork(options.provider, options.config);
  await assertNetwork(options.wallet, options.config);
  const accounts = await options.wallet.request({ method: "qrl_accounts" });
  if (
    !Array.isArray(accounts) ||
    accounts.length !== 1 ||
    canonicalAddress(accounts[0]) !== canonicalAddress(options.account)
  ) {
    throw new Error("Wallet account changed. Reconnect and check the name before continuing.");
  }
  options.signal?.throwIfAborted();
}

async function send(
  step: RegistrationStep,
  input: string,
  options: RegistrationOptions,
): Promise<void> {
  let hash: string | undefined;
  let nonce: string | undefined;
  let requested = false;
  try {
    await assertSigner(options);
    const tx = registrationTransaction(input, options.account, step, options.config);
    const estimate = quantity(
      await options.provider.request({ method: "qrl_estimateGas", params: [tx] }),
    );
    const gas = (estimate * 120n + 99n) / 100n;
    if (gas <= 0n || gas > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid gas estimate");
    await assertSigner(options);
    options.onUpdate({ step, status: "approval" });
    requested = true;
    const result = await options.wallet.request({
      method: "qrl_sendTransaction",
      params: [
        options.transport === "extension"
          ? { ...tx, value: "0", gas: Number(gas), type: "0x2" }
          : { ...tx, gas: toQuantity(gas) },
      ],
    });
    if (!isHash(result))
      throw new Error(
        "Wallet returned an invalid transaction hash. Check wallet activity before retrying.",
      );
    hash = result;
    options.onUpdate({ step, status: "pending", hash });
    await waitForReceipt(hash, {
      ...options,
      expected: tx,
      onNonce: (submittedNonce) => {
        nonce = submittedNonce;
        options.onUpdate({ step, status: "pending", hash: result, nonce });
      },
    });
    const state = await readRegistrationState(input, options.account, options);
    if (!state.complete[step])
      throw new Error(
        "The expected name record is still incomplete. Re-check name state to continue.",
      );
    options.onUpdate({
      step,
      status: "confirmed",
      hash,
      ...(nonce !== undefined ? { nonce } : {}),
    });
    options.onState?.(state);
  } catch (error) {
    options.onUpdate({
      step,
      status:
        requested &&
        !(isRecord(error) && error.code === 4001) &&
        !(error instanceof Error && error.message === "Transaction reverted")
          ? "unconfirmed"
          : "failed",
      ...(hash ? { hash } : {}),
      ...(nonce !== undefined ? { nonce } : {}),
      message: error instanceof Error ? error.message : "Transaction failed",
    });
    throw error;
  }
}

/** Each write confirms before the next. Existing owner records allow recovery after interruption. */
export async function registerName(input: string, options: RegistrationOptions): Promise<string> {
  const { name, node } = registrationName(input);
  const account = canonicalAddress(options.account);
  if (account === ZERO_ADDRESS) throw new Error("Connect a nonzero account");
  await assertDeployment(options);
  await assertSigner(options);
  const registry = requireContract(options.config, "QNSRegistry");
  const resolver = requireContract(options.config, "QRLPublicResolver");
  const readConfig = { registry, provider: options.provider };
  const owner = await nameOwner(name, options);
  if (owner !== null && owner !== account)
    throw new Error("This name is already owned by another account");
  if (owner === null) {
    if (!(await isAvailable(name, options))) throw new Error("This name is no longer available");
    await send("register", name, options);
  } else options.onUpdate({ step: "register", status: "skipped" });
  async function requireOwner(): Promise<void> {
    if ((await nameOwner(name, options)) !== account)
      throw new Error("Name ownership changed. Check the name before continuing.");
  }
  await requireOwner();
  if (
    decodeAddress(
      await call(options.provider, registry, "resolver(bytes32)", bytes32Word(node)),
    ) !== resolver
  ) {
    await send("resolver", name, options);
  } else options.onUpdate({ step: "resolver", status: "skipped" });
  await requireOwner();
  if (
    decodeAddress(await call(options.provider, resolver, "addr(bytes32)", bytes32Word(node))) !==
    account
  ) {
    await send("address", name, options);
  } else options.onUpdate({ step: "address", status: "skipped" });
  await requireOwner();
  const resolved = await resolveName(name, readConfig);
  if (resolved === null || canonicalAddress(resolved) !== account)
    throw new Error("Forward resolution is not confirmed. Check records before continuing.");
  if (
    decodeString(await call(options.provider, resolver, "name(bytes32)", bytes32Word(node))) !==
    name
  ) {
    await send("name", name, options);
    if (
      decodeString(await call(options.provider, resolver, "name(bytes32)", bytes32Word(node))) !==
      name
    )
      throw new Error("Name spelling verification failed");
  } else options.onUpdate({ step: "name", status: "skipped" });
  await requireOwner();
  if (options.primary) {
    if ((await verifyReverse(account, readConfig)) !== name) {
      await send("primary", name, options);
      if ((await verifyReverse(account, readConfig)) !== name)
        throw new Error("Primary name verification failed");
    } else options.onUpdate({ step: "primary", status: "skipped" });
  }
  return name;
}
