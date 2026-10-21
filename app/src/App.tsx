import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent,
  type ReactNode,
} from "react";
import {
  assertDeployment,
  assertNetwork,
  canonicalAddress,
  isDeployed,
  listOwnedNames,
  normalize,
  registerName,
  registrationName,
  registrationPlan,
  type RegistrationPlan,
  requireContract,
  resolveName,
  verifyReverse,
  checkRegistrationTransaction,
  readRegistrationState,
  TransactionMismatchError,
  RevertedTransactionError,
  type NetworkConfig,
  type OwnedName,
  type RpcProvider,
  type TransactionUpdate,
} from "@qns/sdk";
import { errorMessage } from "./rpc";
import { decideRecovery, type RecoveryCheck, type RecoveryRecords } from "./recovery";
import {
  knownNames,
  readPendingClaim,
  rememberName,
  savePendingClaim,
  type PendingClaim,
} from "./storage";
import { WalletController } from "./wallet";
import { useNameState, type NameResult } from "./useNameState";
import {
  ClaimProgress,
  ClaimSummary,
  remainingApprovals,
  setupComplete,
  transactionOutcomes,
  transactionInFlight,
} from "./ClaimProgress";

const PairingModal = lazy(async () => ({ default: (await import("./PairingModal")).PairingModal }));

interface ClaimScope {
  name: string;
  node: string;
  account: string;
  requestId: string | number;
  attemptId?: string;
}

function claimScope(claim: PendingClaim): ClaimScope {
  const { name, node } = registrationName(claim.name);
  return {
    name,
    node,
    account: claim.account,
    requestId:
      claim.attemptId ??
      claim.update.requestId ??
      `recovery:${node}:${claim.update.step}:${claim.update.nonce ?? "unknown"}`,
    ...(claim.attemptId ? { attemptId: claim.attemptId } : {}),
  };
}

function sameClaimRequest(left: ClaimScope, right: ClaimScope): boolean {
  return (
    left.node === right.node && left.account === right.account && left.requestId === right.requestId
  );
}

function ownedNameStatus(name: OwnedName, account: string | null, config: NetworkConfig): string {
  if (name.records === null) return name.error;
  if (name.records.resolverStatus === "unusable") return "Resolver not usable";
  if (!name.records.address) return "Address record missing";
  if (name.records.address !== account) return "Address record needs updating";
  if (name.records.resolver !== config.contracts.QRLPublicResolver)
    return "Records contract needs setup";
  if (!name.records.spelling) return "Name text missing";
  if (name.records.spelling !== name.name) return "Name text needs updating";
  return name.primary ? "Ready and your primary name" : "Ready";
}

function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd className={mono ? "font-mono break-all" : ""}>{children}</dd>
    </div>
  );
}
function Message({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <p role={error ? "alert" : "status"} className={error ? "message error" : "message"}>
      {children}
    </p>
  );
}
function WalletPicker({
  controller,
  onClose,
}: {
  controller: WalletController;
  onClose: () => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="wallet-dialog"
      onCancel={onClose}
      onClose={onClose}
      aria-labelledby="wallet-title"
    >
      <h2 id="wallet-title">Connect your wallet</h2>
      <p>Choose how to use MyQRLWallet.</p>
      <div className="wallet-options">
        {state.choices.map((choice) => (
          <button
            className="wallet-option"
            key={choice.id}
            onClick={() => {
              onClose();
              void controller.connectExtension(choice);
            }}
          >
            <strong>{choice.name}</strong>
            <span>Browser extension</span>
          </button>
        ))}
        {state.choices.length === 0 && <p className="muted">No QRL extension detected.</p>}
        <button
          className="wallet-option"
          onClick={() => {
            onClose();
            void controller.pair();
          }}
        >
          <strong>MyQRLWallet</strong>
          <span>Web wallet or mobile app</span>
        </button>
      </div>
      <button className="secondary w-full" onClick={onClose}>
        Cancel
      </button>
    </dialog>
  );
}

export function App({
  config,
  provider,
  controller,
}: {
  config: NetworkConfig;
  provider: RpcProvider;
  controller: WalletController;
}) {
  const wallet = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const activeContext = useRef({ config, provider, controller });
  activeContext.current = { config, provider, controller };
  const isCurrentContext = () =>
    activeContext.current.config === config &&
    activeContext.current.provider === provider &&
    activeContext.current.controller === controller;
  const [picker, setPicker] = useState(false);
  const [network, setNetwork] = useState<{ ready: boolean; error: string | null }>({
    ready: false,
    error: null,
  });
  const [networkRevision, setNetworkRevision] = useState(0);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletReady, setWalletReady] = useState(false);
  const [input, setInput] = useState("");
  const { search, searching, searchError, readErrorName, refreshName, getSelection } = useNameState(
    config,
    provider,
    controller,
    wallet.revision,
  );
  const latestRefreshName = useRef(refreshName);
  latestRefreshName.current = refreshName;
  const [primary, setPrimary] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<{ scope: ClaimScope; message: string } | null>(null);
  const [flow, setFlow] = useState<
    | (ClaimScope & {
        primary: boolean;
        plan?: RegistrationPlan;
      })
    | null
  >(null);
  const [updateState, setUpdateState] = useState<{
    scope: ClaimScope;
    items: TransactionUpdate[];
  } | null>(null);
  const [pendingState, setPendingState] = useState<{
    config: NetworkConfig;
    claim: PendingClaim | null;
  }>(() => ({ config, claim: readPendingClaim(config, wallet.account) }));
  const pending =
    pendingState.config === config && pendingState.claim?.account === wallet.account
      ? pendingState.claim
      : null;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  function setPending(claim: PendingClaim | null): void {
    pendingRef.current = claim;
    setPendingState({ config, claim });
  }
  function savedClaim(account: string): PendingClaim | null {
    return isCurrentContext() && pendingRef.current?.account === account
      ? pendingRef.current
      : readPendingClaim(config, account);
  }
  const [checkingPending, setCheckingPending] = useState(false);
  const pendingCheck = useRef<{ node: string; requestId: string } | null>(null);
  const [recoveryHash, setRecoveryHash] = useState("");
  const operation = useRef<AbortController | null>(null);
  const claimLock = useRef(false);
  const claimCard = useRef<HTMLElement>(null);
  const [names, setNames] = useState<OwnedName[]>([]);
  const [namesLoading, setNamesLoading] = useState(false);
  const [namesError, setNamesError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [lookupInput, setLookupInput] = useState("");
  const [lookup, setLookup] = useState<{ label: string; value: string } | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const lookupGeneration = useRef(0);

  function activeClaim(scope: ClaimScope): boolean {
    const selection = getSelection();
    return (
      isCurrentContext() &&
      controller.getSnapshot().account === scope.account &&
      controller.getSnapshot().revision === wallet.revision &&
      (selection.node === scope.node ||
        (selection.requestId === 0 &&
          pendingRef.current !== null &&
          sameClaimRequest(claimScope(pendingRef.current), scope)))
    );
  }
  function claimMessage(scope: ClaimScope, message: string | null): void {
    if (isCurrentContext() && controller.getSnapshot().account === scope.account)
      setClaimError(message === null ? null : { scope, message });
  }

  useEffect(() => controller.start(), [controller]);
  useEffect(() => {
    controller.expectLateResponse(pending?.update.requestId);
    return () => {
      controller.expectLateResponse(undefined);
    };
  }, [controller, pending?.update.requestId, wallet.account]);
  useEffect(() => {
    const response = wallet.lateTransaction;
    if (!response) return;
    if (
      !pending ||
      pending.update.hash ||
      pending.update.requestId !== response.id ||
      wallet.account !== pending.account
    ) {
      controller.clearLateTransaction();
      return;
    }
    const scope = claimScope(pending);
    if (response.rejected) {
      recordSubmission(scope, { ...pending.update, status: "failed" }, pending.primary);
      claimMessage(scope, "Request declined in your wallet. You can continue when ready.");
    } else if (response.hash) {
      recordSubmission(
        scope,
        {
          ...pending.update,
          hash: response.hash,
          status: pending.update.status === "approval" ? "unconfirmed" : pending.update.status,
        },
        pending.primary,
      );
    }
    void refreshName();
    controller.clearLateTransaction();
  }, [wallet.lateTransaction, wallet.account, pending, config, controller, refreshName]);
  useEffect(() => {
    let active = true;
    setNetwork({ ready: false, error: null });
    if (isDeployed(config))
      void assertDeployment({ config, provider })
        .then(() => {
          if (active) setNetwork({ ready: true, error: null });
        })
        .catch((error: unknown) => {
          if (active) setNetwork({ ready: false, error: errorMessage(error) });
        });
    return () => {
      active = false;
    };
  }, [config, provider, networkRevision]);
  useEffect(() => {
    setPending(readPendingClaim(config, wallet.account));
    setUpdateState(null);
    setRecoveryHash("");
    setClaimError(null);
    setCheckingPending(false);
    pendingCheck.current = null;
    setClaiming(false);
    claimLock.current = false;
    operation.current?.abort();
    operation.current = null;
  }, [wallet.account, config]);
  useEffect(() => {
    operation.current?.abort();
    setFlow(null);
    setUpdateState(null);
    let active = true;
    setWalletReady(false);
    setWalletError(null);
    if (wallet.provider && wallet.account)
      void assertNetwork(wallet.provider, config)
        .then(() => {
          if (active) setWalletReady(true);
        })
        .catch((error: unknown) => {
          if (active) setWalletError(errorMessage(error));
        });
    return () => {
      active = false;
      operation.current?.abort();
    };
  }, [wallet.provider, wallet.account, wallet.revision, config, provider, controller]);
  useEffect(() => {
    const abort = new AbortController();
    setNames([]);
    setNamesError(null);
    setNamesLoading(false);
    if (wallet.account && network.ready) {
      setNamesLoading(true);
      void listOwnedNames(wallet.account, { config, provider }, knownNames(config), abort.signal)
        .then((items) => {
          if (!abort.signal.aborted) setNames(items);
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted)
            setNamesError(`Could not read your names: ${errorMessage(error)}`);
        })
        .finally(() => {
          if (!abort.signal.aborted) setNamesLoading(false);
        });
    }
    return () => {
      abort.abort();
    };
  }, [wallet.account, wallet.revision, config, provider, network.ready, refresh]);

  async function searchName(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setFlow(null);
    setClaimError(null);
    setUpdateState(null);
    const result = await refreshName(input);
    if (result) {
      rememberName(config, result.name);
      setRefresh((value) => value + 1);
    }
  }
  // Identity enters through the send response, including a delayed response to that request.
  function recordSubmission(
    scope: ClaimScope,
    update: TransactionUpdate,
    makePrimary = primary,
  ): void {
    const saved = savedClaim(scope.account);
    if (saved && (!sameClaimRequest(claimScope(saved), scope) || saved.update.step !== update.step))
      return;
    const original = saved;
    recordClaim(scope, {
      name: scope.name,
      account: scope.account,
      primary: makePrimary,
      ...(scope.attemptId ? { attemptId: scope.attemptId } : {}),
      ...original,
      update: {
        ...update,
        ...(original?.update.hash ? { hash: original.update.hash } : {}),
        ...(original?.update.nonce !== undefined ? { nonce: original.update.nonce } : {}),
        ...(original?.update.requestId !== undefined
          ? { requestId: original.update.requestId }
          : {}),
      },
    });
  }
  function recordUpdate(
    scope: ClaimScope,
    outcome: Pick<TransactionUpdate, "status" | "message">,
  ): void {
    const saved = savedClaim(scope.account);
    if (!saved || !sameClaimRequest(claimScope(saved), scope)) return;
    const update = { ...saved.update, status: outcome.status };
    delete update.message;
    if (outcome.message !== undefined) update.message = outcome.message;
    recordClaim(scope, { ...saved, update });
  }
  function recordClaim(scope: ClaimScope, next: PendingClaim): void {
    const { name, account, update } = next;
    const saved = savedClaim(account);
    if (saved && !sameClaimRequest(claimScope(saved), scope)) return;
    const visible = isCurrentContext() && controller.getSnapshot().account === account;
    if (activeClaim(scope))
      setUpdateState((previous) => ({
        scope,
        items: [
          ...(previous && sameClaimRequest(previous.scope, scope)
            ? previous.items.filter((item) => item.step !== update.step)
            : []),
          update,
        ],
      }));
    // Settlement refreshes the current selection through the latest wallet context.
    if (update.status !== "approval" && update.status !== "pending") {
      rememberName(config, name);
      void latestRefreshName.current();
      if (visible) setRefresh((value) => value + 1);
    }
    if (transactionOutcomes[update.status].recovery) {
      if (visible) setPending(next);
      savePendingClaim(config, next);
    } else if (
      !transactionInFlight(update) &&
      (update.status === "confirmed" || update.status === "failed")
    ) {
      if (visible) setPending(null);
      savePendingClaim(config, null, account);
    }
  }
  async function claim(target = search, makePrimary = primary): Promise<void> {
    if (
      !target ||
      !target.setup ||
      (!target.available && target.owner !== wallet.account) ||
      setupComplete(target.setup, makePrimary) ||
      !wallet.account ||
      !wallet.provider ||
      !wallet.transport ||
      claimLock.current ||
      pending
    )
      return;
    claimLock.current = true;
    const abort = new AbortController();
    operation.current = abort;
    const name = target.name;
    const account = wallet.account;
    const attemptId = crypto.randomUUID();
    const scope: ClaimScope = {
      name,
      node: target.node,
      account,
      requestId: attemptId,
      attemptId,
    };
    setClaiming(true);
    setClaimError(null);
    const plan =
      target === search && makePrimary === primary && searchPlan
        ? searchPlan
        : registrationPlan(target.setup, makePrimary);
    setFlow({ ...scope, primary: makePrimary, plan });
    setUpdateState(null);
    rememberName(config, name);
    try {
      await registerName(name, {
        config,
        provider,
        wallet: wallet.provider,
        account,
        transport: wallet.transport,
        primary: makePrimary,
        plan,
        signal: abort.signal,
        onUpdate: (update) => {
          // Preserve the original account's submitted operation after a wallet switch.
          const saved = savedClaim(account);
          if (abort.signal.aborted && (!saved || saved.attemptId !== attemptId)) return;
          recordSubmission(scope, update, makePrimary);
        },
      });
      abort.signal.throwIfAborted();
      await latestRefreshName.current();
      abort.signal.throwIfAborted();
    } catch (error) {
      if (operation.current === abort && isCurrentContext())
        claimMessage(
          scope,
          abort.signal.aborted
            ? "Wallet connection changed. Confirm the current transaction, then continue with the name owner."
            : errorMessage(error),
        );
      await latestRefreshName.current();
    } finally {
      if (operation.current === abort) {
        setClaiming(false);
        claimLock.current = false;
        setRefresh((value) => value + 1);
      }
    }
  }
  async function continueName(name: string | null, makePrimary: boolean): Promise<void> {
    if (!name || claimLock.current || pending || checkingPending) return;
    const revision = controller.getSnapshot().revision;
    setInput(name);
    setPrimary(makePrimary);
    setFlow(null);
    setUpdateState(null);
    setClaimError(null);
    claimCard.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    const result: NameResult | null = await refreshName(name);
    if (!isCurrentContext() || controller.getSnapshot().revision !== revision) return;
    if (result?.owner === wallet.account) await claim(result, makePrimary);
  }
  async function recoverPending(stateOnly = false): Promise<void> {
    if (!pending || pendingCheck.current) return;
    const saved = pending;
    const scope = claimScope(saved);
    const check = { node: scope.node, requestId: crypto.randomUUID() };
    pendingCheck.current = check;
    const revision = controller.getSnapshot().revision;
    const current = () =>
      pendingCheck.current === check &&
      isCurrentContext() &&
      controller.getSnapshot().revision === revision &&
      pendingRef.current !== null &&
      sameClaimRequest(claimScope(pendingRef.current), scope) &&
      pendingRef.current.update.hash === saved.update.hash &&
      pendingRef.current.update.nonce === saved.update.nonce &&
      pendingRef.current.trackedHash === saved.trackedHash;
    setCheckingPending(true);
    setClaimError(null);
    setInput(saved.name);
    let result: RecoveryCheck | null = null;
    const trackedChecks = new Map<string, RecoveryCheck>();
    let records: RecoveryRecords | null = null;
    const decide = () =>
      decideRecovery(
        saved,
        {
          original: result,
          tracked: trackedChecks,
        },
        stateOnly,
        records,
      );
    const snapshot = refreshName(saved.name);
    const selection = getSelection();
    const visible = () => current() && getSelection() === selection && activeClaim(scope);
    try {
      await snapshot;
      if (!current()) return;
      const context = { config, provider };
      let decision = decide();
      let appliedUpdate: TransactionUpdate | undefined;
      if (decision.next === "check") {
        const checkTransaction = async (update: TransactionUpdate): Promise<RecoveryCheck> => {
          try {
            return {
              status: await checkRegistrationTransaction(
                saved.name,
                saved.account,
                update,
                context,
              ),
            };
          } catch (error) {
            return {
              status:
                error instanceof TransactionMismatchError
                  ? "mismatched"
                  : error instanceof RevertedTransactionError
                    ? "reverted"
                    : "error",
              message: errorMessage(error),
            };
          }
        };
        const trackedHash = saved.trackedHash;
        if (trackedHash && trackedHash.toLowerCase() !== saved.update.hash?.toLowerCase()) {
          // A separate hash can refresh records. Settlement still requires the original
          // receipt or proof that its sender's nonce was consumed, checked by the SDK.
          const trackedResult = await checkTransaction({
            step: saved.update.step,
            status: "unconfirmed",
            hash: trackedHash,
          });
          if (!current()) return;
          trackedChecks.set(trackedHash.toLowerCase(), trackedResult);
          rememberName(config, saved.name);
          setRefresh((value) => value + 1);
        }
        result = await checkTransaction(saved.update);
        if (!current()) return;
        decision = decide();
      }
      if (decision.next === "read") {
        for (const update of decision.updates) {
          recordUpdate(scope, update);
          appliedUpdate = update;
        }
        try {
          records = {
            status: "read",
            state: await readRegistrationState(saved.name, saved.account, context),
          };
        } catch (error) {
          records = { status: "error", message: errorMessage(error) };
        }
        if (!current()) return;
        decision = decide();
      }
      const trackedResult = saved.trackedHash
        ? trackedChecks.get(saved.trackedHash.toLowerCase())
        : undefined;
      claimMessage(
        scope,
        decision.showFinished
          ? null
          : trackedResult && "message" in trackedResult
            ? `Tracked transaction: ${trackedResult.message}`
            : decision.message,
      );
      if (decision.next !== "delete") {
        for (const update of decision.updates)
          if (update.status !== appliedUpdate?.status || update.message !== appliedUpdate.message)
            recordUpdate(scope, update);
        return;
      }
      const failed = decision.updates.find((update) => update.status === "failed");
      if (visible()) {
        if (!failed) setUpdateState({ scope, items: decision.updates });
        setFlow({ ...scope, primary: saved.primary ?? false });
        setPrimary(saved.primary ?? false);
      }
      if (failed) {
        recordUpdate(scope, failed);
        return;
      }
      rememberName(config, saved.name);
      savePendingClaim(config, decision.pending, saved.account);
      setPending(decision.pending);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (current()) claimMessage(scope, errorMessage(error));
    } finally {
      await latestRefreshName.current();
      if (pendingCheck.current === check) {
        pendingCheck.current = null;
        setCheckingPending(false);
      }
    }
  }
  function discardPending(): void {
    if (!pending) return;
    savePendingClaim(config, null, pending.account);
    setPending(null);
    setUpdateState(null);
    void refreshName(pending.name);
    setInput(pending.name);
    claimMessage(
      claimScope(pending),
      "Pending state discarded. Name availability is being checked before continuing.",
    );
  }
  async function lookUp(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    const generation = ++lookupGeneration.current;
    setLooking(true);
    setLookup(null);
    setLookupError(null);
    try {
      await assertNetwork(provider, config);
      const resolution = { registry: requireContract(config, "QNSRegistry"), provider };
      let result: { label: string; value: string };
      if (/^(?:[Qq]|0x)[0-9a-fA-F]{128}$/.test(lookupInput)) {
        const address = canonicalAddress(lookupInput);
        const name = await verifyReverse(address, resolution);
        result = { label: "Primary name", value: name ?? "No verified primary name" };
      } else {
        const name = lookupInput.includes(".")
          ? normalize(lookupInput)
          : registrationName(lookupInput).name;
        const address = await resolveName(name, resolution);
        result = { label: name, value: address ?? "No address record" };
      }
      if (generation === lookupGeneration.current) setLookup(result);
    } catch (error) {
      if (generation === lookupGeneration.current) setLookupError(errorMessage(error));
    } finally {
      if (generation === lookupGeneration.current) setLooking(false);
    }
  }
  const owned = search?.owner !== null && search?.owner === wallet.account;
  const canClaim = search && (search.available || owned);
  const searchPlan = search?.setup ? registrationPlan(search.setup, primary) : null;
  const approvalPlan = claiming ? flow?.plan : searchPlan;
  const showApprovals = claiming || (canClaim && !setupComplete(search.setup, primary));
  const deployed = isDeployed(config);
  const selection = getSelection();
  const recovery = pending ? { ...claimScope(pending), primary: pending.primary ?? false } : null;
  const tracked =
    flow && flow.node === selection.node
      ? flow
      : recovery && (selection.requestId === 0 || recovery.node === selection.node)
        ? recovery
        : null;
  const updates =
    tracked && updateState && sameClaimRequest(tracked, updateState.scope) ? updateState.items : [];
  const progress =
    deployed && (tracked || (search && canClaim))
      ? {
          name: tracked?.name ?? search?.name ?? "",
          config,
          primary: tracked?.primary ?? primary,
          state: search && (!tracked || tracked.name === search.name) ? search.setup : null,
          updates:
            updates.length > 0
              ? updates
              : pending && tracked && sameClaimRequest(tracked, claimScope(pending))
                ? [
                    {
                      ...pending.update,
                      status:
                        pending.update.status === "approval"
                          ? ("unconfirmed" as const)
                          : pending.update.status,
                    },
                  ]
                : [],
          running: claiming,
          ...(claiming && flow?.plan ? { plan: flow.plan } : {}),
        }
      : null;

  const approvalDetails = showApprovals && approvalPlan && (
    <>
      <dl>
        <Row label="Registration price">Free</Row>
        <Row label="Network fee">Each approval costs a small fee in Quanta.</Row>
        <Row label="Wallet approvals">
          {remainingApprovals(approvalPlan, claiming ? updates : [])} remaining
        </Row>
      </dl>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={primary}
          disabled={claiming || pending !== null || checkingPending}
          onChange={(event) => {
            setPrimary(event.target.checked);
            setFlow(null);
            setUpdateState(null);
          }}
        />
        <span>Use as my primary name</span>
      </label>
      <p className="muted text-sm">Your primary name appears when someone looks up your address.</p>
    </>
  );

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a href="#" className="wordmark" aria-label="QNS home">
          Q<span>NS</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#register">Register</a>
          <a href="#names">My names</a>
          <a href="#lookup">Look up</a>
        </nav>
        <button
          className="secondary"
          disabled={(wallet.busy && wallet.transport !== "extension") || claiming}
          onClick={() => {
            if (wallet.account || wallet.transport === "extension") void controller.disconnect();
            else {
              window.dispatchEvent(new Event("eip6963:requestProvider"));
              setPicker(true);
            }
          }}
        >
          {wallet.account || wallet.transport === "extension"
            ? "Disconnect"
            : wallet.busy
              ? "Connecting..."
              : "Connect wallet"}
        </button>
      </header>
      <main id="main" className="page">
        <div className="intro">
          <p className="eyebrow">QRL NAME SERVICE</p>
          <h1>
            Your name
            <br />
            on <span>QRL.</span>
          </h1>
          <p className="intro-copy">
            One readable name for your QRL address.
            <br className="hidden sm:block" /> Find yours and make it your own.
          </p>
        </div>
        <div className="workspace">
          <div className="main-column">
            <section
              ref={claimCard}
              id="register"
              className="panel"
              aria-labelledby="register-title"
            >
              <div className="section-heading">
                <p className="eyebrow">01 / REGISTER</p>
                <h2 id="register-title">Find your .qrl name</h2>
                <p>Use letters, numbers and hyphens.</p>
              </div>
              {progress && <ClaimSummary {...progress} />}
              {!deployed && (
                <Message>
                  QNS deployment is pending on this network. Search and registration will open when
                  it is ready.
                </Message>
              )}
              {deployed && !network.ready && !network.error && (
                <Message>Checking the QNS deployment...</Message>
              )}
              {network.error && (
                <>
                  <Message error>{network.error}</Message>
                  <button
                    className="text-button"
                    onClick={() => {
                      setNetworkRevision((value) => value + 1);
                      void refreshName();
                    }}
                  >
                    Retry network check
                  </button>
                </>
              )}
              <form
                onSubmit={(event) => {
                  void searchName(event);
                }}
              >
                <label htmlFor="name">Name</label>
                <div className="search-controls">
                  <input
                    id="name"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="alice.qrl"
                    value={input}
                    disabled={claiming}
                    onChange={(event) => {
                      setInput(event.target.value);
                      void refreshName(null);
                      setFlow(null);
                      setUpdateState(null);
                    }}
                  />
                  <button disabled={!network.ready || searching || claiming || !input}>
                    {searching ? "Searching..." : "Search"}
                  </button>
                </div>
              </form>
              {searchError && <Message error>{searchError}</Message>}
              {!search && approvalDetails}
              {search && (
                <div className="search-result">
                  <dl>
                    <Row label="Name">{search.name}</Row>
                    <Row label="Availability">
                      {search.available ? "Available" : owned ? "Owned by you" : "Registered"}
                    </Row>
                    {search.owner && (
                      <Row label="Owner" mono>
                        {search.owner}
                      </Row>
                    )}
                    {search.setup?.resolverStatus === "unusable" && (
                      <Row label="Records">Resolver not usable</Row>
                    )}
                  </dl>
                  {approvalDetails}
                  {wallet.account
                    ? !setupComplete(search.setup, primary) && (
                        <button
                          className="w-full mt-5"
                          disabled={
                            !canClaim ||
                            !search.setup ||
                            !walletReady ||
                            claiming ||
                            pending !== null ||
                            !network.ready
                          }
                          onClick={() => {
                            void claim();
                          }}
                        >
                          {claiming
                            ? "Claim in progress..."
                            : owned
                              ? "Complete name setup"
                              : "Claim name"}
                        </button>
                      )
                    : canClaim && (
                        <button
                          className="w-full mt-5"
                          onClick={() => {
                            setPicker(true);
                          }}
                        >
                          Connect wallet to claim
                        </button>
                      )}
                </div>
              )}
              {progress && <ClaimProgress {...progress} />}
              {claimError && (
                <>
                  {claimError.scope.node !== selection.node && (
                    <p className="muted text-sm">Claim update for {claimError.scope.name}</p>
                  )}
                  <Message error>{claimError.message}</Message>
                </>
              )}
              {pending && !claiming && (
                <div className="pending">
                  <Message>
                    Check the pending transaction for {pending.name} before continuing.
                  </Message>
                  {pending.update.hash && (
                    <a
                      href={`https://zondscan.com/tx/${pending.update.hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View transaction
                    </a>
                  )}
                  {pending.trackedHash && (
                    <a
                      href={`https://zondscan.com/tx/${pending.trackedHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View tracked transaction
                    </a>
                  )}
                  {(pending.update.hash || pending.trackedHash) && (
                    <button
                      className="secondary mt-4 w-full"
                      disabled={checkingPending}
                      onClick={() => {
                        void recoverPending();
                      }}
                    >
                      {checkingPending ? "Checking..." : "Check confirmation"}
                    </button>
                  )}
                  <p className="muted text-sm">
                    You can check the name directly after a cancellation or speed-up, or enter the
                    transaction hash from wallet activity.
                  </p>
                  <label htmlFor="recovery-hash" className="mt-4">
                    Transaction hash
                  </label>
                  <input
                    id="recovery-hash"
                    value={recoveryHash}
                    onChange={(event) => {
                      setRecoveryHash(event.target.value);
                    }}
                    placeholder="0x..."
                  />
                  <button
                    className="secondary mt-4 w-full"
                    disabled={checkingPending || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)}
                    onClick={() => {
                      const next = { ...pending, trackedHash: recoveryHash };
                      setPending(next);
                      savePendingClaim(config, next);
                    }}
                  >
                    Track transaction
                  </button>
                  <button
                    className="secondary mt-4 w-full"
                    disabled={checkingPending}
                    onClick={() => {
                      void recoverPending(true);
                    }}
                  >
                    Re-check name state
                  </button>
                  <p className="muted text-sm">
                    Discarding browser state leaves submitted transactions on the network. Cancel an
                    outstanding approval in your wallet before retrying.
                  </p>
                  <button
                    className="text-button mt-4"
                    disabled={checkingPending}
                    onClick={discardPending}
                  >
                    Discard pending state
                  </button>
                </div>
              )}
            </section>
            <section id="names" className="panel" aria-labelledby="names-title">
              <div className="section-heading">
                <p className="eyebrow">02 / YOUR NAMES</p>
                <h2 id="names-title">My names</h2>
              </div>
              {config.deploymentBlock === undefined && (
                <Message>
                  The registry deployment block is unknown. My names scans from block 1 and may be
                  incomplete.
                </Message>
              )}
              {!wallet.account ? (
                <p className="muted">Connect your wallet to see the names you own.</p>
              ) : !network.ready ? (
                <p className="muted">Names will appear when QNS is available.</p>
              ) : (
                <>
                  <button
                    className="text-button"
                    disabled={namesLoading}
                    onClick={() => {
                      setRefresh((value) => value + 1);
                      void refreshName();
                    }}
                  >
                    Refresh names
                  </button>
                  {namesLoading && <Message>Reading your names...</Message>}
                  {namesError && <Message error>{namesError}</Message>}
                  {!namesLoading && !namesError && names.length === 0 && (
                    <p className="muted mt-4">You do not own any .qrl names yet.</p>
                  )}
                  <ul className="owned-names">
                    {names.map((name) => {
                      const addressReady = name.records?.address === wallet.account;
                      const recordsReady =
                        name.records?.resolverStatus === "usable" &&
                        addressReady &&
                        name.records.resolver === config.contracts.QRLPublicResolver &&
                        name.records.spelling === name.name;
                      return (
                        <li key={name.node}>
                          <dl>
                            <Row label="Name">{name.name ?? "Spelling unavailable"}</Row>
                            {!name.name && (
                              <Row label="Name hash" mono>
                                {name.node}
                              </Row>
                            )}
                            <Row label="State">{ownedNameStatus(name, wallet.account, config)}</Row>
                            {name.primary === false && (
                              <Row label="Primary name">Not set as primary</Row>
                            )}
                          </dl>
                          {name.records === null ? (
                            <button
                              className="text-button"
                              disabled={namesLoading}
                              onClick={() => {
                                setRefresh((value) => value + 1);
                                if (readErrorName === name.name) void refreshName();
                              }}
                            >
                              Retry name records
                            </button>
                          ) : name.name ? (
                            (!recordsReady || !name.primary) && (
                              <button
                                className="text-button"
                                disabled={
                                  claiming ||
                                  checkingPending ||
                                  pending !== null ||
                                  !walletReady ||
                                  readErrorName === name.name
                                }
                                onClick={() => {
                                  void continueName(name.name, recordsReady);
                                }}
                              >
                                {recordsReady ? "Make primary name" : "Finish name setup"}
                              </button>
                            )
                          ) : (
                            <p className="muted text-sm">
                              Search its spelling above to check and complete setup.
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>
            <section id="lookup" className="panel" aria-labelledby="lookup-title">
              <div className="section-heading">
                <p className="eyebrow">03 / LOOK UP</p>
                <h2 id="lookup-title">Find an address or name</h2>
                <p>Primary names are checked against their address record.</p>
              </div>
              <form
                onSubmit={(event) => {
                  void lookUp(event);
                }}
              >
                <label htmlFor="lookup-input">Name or QRL address</label>
                <input
                  id="lookup-input"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="alice.qrl or Q..."
                  value={lookupInput}
                  onChange={(event) => {
                    setLookupInput(event.target.value);
                    setLookup(null);
                    setLookupError(null);
                    setLooking(false);
                    lookupGeneration.current++;
                  }}
                />
                <button
                  className="secondary mt-4"
                  disabled={!network.ready || looking || !lookupInput}
                >
                  {looking ? "Looking up..." : "Look up"}
                </button>
              </form>
              {lookupError && <Message error>{lookupError}</Message>}
              {lookup && (
                <dl className="mt-5" aria-live="polite">
                  <Row label={lookup.label} mono>
                    {lookup.value}
                  </Row>
                </dl>
              )}
            </section>
          </div>
          <aside className="side-column">
            <section className="context-panel">
              <h2>Your connection</h2>
              <dl>
                <Row label="Network">
                  {config.network === "testnet-v3-private"
                    ? "MyQRLWallet Testnet v3"
                    : config.network === "qrl2-kurtosis-local"
                      ? "Local QRL devnet"
                      : config.network}
                </Row>
                <Row label="Chain ID">{config.chainId}</Row>
                <Row label="QNS">
                  {!deployed
                    ? "Deployment pending"
                    : network.ready
                      ? "Ready"
                      : "Checking deployment"}
                </Row>
                <Row label="Wallet">{wallet.account ? "Connected" : wallet.status}</Row>
                {wallet.account && (
                  <Row label="Account" mono>
                    {wallet.account}
                  </Row>
                )}
              </dl>
              {wallet.transport === "extension" && !wallet.account && !wallet.busy && (
                <button
                  className="text-button"
                  onClick={() => {
                    void controller.connectExtension();
                  }}
                >
                  Connect again
                </button>
              )}
              {wallet.error && <Message error>{wallet.error}</Message>}
              {walletError && (
                <>
                  <Message error>{walletError}</Message>
                  <button
                    className="text-button"
                    onClick={() => {
                      void controller.reconnect();
                    }}
                  >
                    Reconnect wallet
                  </button>
                </>
              )}
            </section>
            <section className="context-panel guide">
              <h2>Claim it. Use it.</h2>
              <ol>
                <li>
                  <span>1</span>
                  <div>
                    <h3>Choose a name</h3>
                    <p>Names are claimed on a first-come basis.</p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <h3>Approve the steps</h3>
                    <p>Claim your name, select its resolver and save your records.</p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <h3>Share your .qrl</h3>
                    <p>Your name is ready after every step confirms.</p>
                  </div>
                </li>
              </ol>
              <p className="alpha-note">
                Testnet alpha. Names have no renewal period. This network is for testing.
              </p>
            </section>
          </aside>
        </div>
      </main>
      <footer>
        <span>QNS / QRL Name Service</span>
        <a href="https://github.com/DigitalGuards/myqrlwallet-qns" target="_blank" rel="noreferrer">
          Source code
        </a>
        <a href="https://qrlwallet.com" target="_blank" rel="noreferrer">
          MyQRLWallet
        </a>
      </footer>
      {picker && (
        <WalletPicker
          controller={controller}
          onClose={() => {
            setPicker(false);
          }}
        />
      )}
      {wallet.uri && (
        <Suspense fallback={<Message>Opening pairing...</Message>}>
          <PairingModal uri={wallet.uri} status={wallet.status} wallet={controller} />
        </Suspense>
      )}
    </>
  );
}
