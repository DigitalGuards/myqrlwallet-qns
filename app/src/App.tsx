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
  requireContract,
  resolveName,
  verifyReverse,
  checkRegistrationTransaction,
  readRegistrationState,
  isNonceConsumed,
  type NetworkConfig,
  type OwnedName,
  type RegistrationStep,
  type RpcProvider,
  type TransactionUpdate,
} from "@qns/sdk";
import { errorMessage } from "./rpc";
import {
  knownNames,
  readPendingClaim,
  rememberName,
  savePendingClaim,
  type PendingClaim,
} from "./storage";
import { WalletController } from "./wallet";
import { useNameState } from "./useNameState";

const PairingModal = lazy(async () => ({ default: (await import("./PairingModal")).PairingModal }));
const stepLabels: Record<RegistrationStep, string> = {
  register: "Claim name",
  resolver: "Select resolver",
  address: "Set address",
  name: "Save name",
  primary: "Set primary name",
};
const statusLabels = {
  approval: "Approve in your wallet",
  pending: "Waiting for confirmation",
  confirmed: "Confirmed",
  skipped: "Already complete",
  failed: "Failed",
  unconfirmed: "Confirmation pending",
};

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
  const { search, searching, searchError, refreshName } = useNameState(
    config,
    provider,
    controller,
    wallet.revision,
  );
  const latestRefreshName = useRef(refreshName);
  latestRefreshName.current = refreshName;
  const [primary, setPrimary] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<{ name: string; primary: boolean } | null>(null);
  const [updates, setUpdates] = useState<TransactionUpdate[]>([]);
  const [pendingState, setPendingState] = useState<{
    config: NetworkConfig;
    claim: PendingClaim | null;
  }>(() => ({ config, claim: readPendingClaim(config, wallet.account) }));
  const pending =
    pendingState.config === config && pendingState.claim?.account === wallet.account
      ? pendingState.claim
      : null;
  function setPending(claim: PendingClaim | null): void {
    setPendingState({ config, claim });
  }
  const [checkingPending, setCheckingPending] = useState(false);
  const pendingCheck = useRef<object | null>(null);
  const [recoveryHash, setRecoveryHash] = useState("");
  const operation = useRef<AbortController | null>(null);
  const claimLock = useRef(false);
  const [names, setNames] = useState<OwnedName[]>([]);
  const [namesLoading, setNamesLoading] = useState(false);
  const [namesError, setNamesError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [lookupInput, setLookupInput] = useState("");
  const [lookup, setLookup] = useState<{ label: string; value: string } | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const lookupGeneration = useRef(0);

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
    if (response.rejected) {
      setPending(null);
      savePendingClaim(config, null, pending.account);
      setClaimError("Request declined in your wallet. You can continue when ready.");
    } else if (response.hash) {
      const next: PendingClaim = {
        ...pending,
        update: { ...pending.update, hash: response.hash, status: "unconfirmed" },
      };
      setPending(next);
      savePendingClaim(config, next);
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
    setUpdates([]);
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
    setClaimed(null);
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
  }, [wallet.provider, wallet.account, wallet.revision, config]);
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
          if (!abort.signal.aborted) setNamesError(errorMessage(error));
        })
        .finally(() => {
          if (!abort.signal.aborted) setNamesLoading(false);
        });
    }
    return () => {
      abort.abort();
    };
  }, [wallet.account, config, provider, network.ready, refresh]);

  async function searchName(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setClaimed(null);
    setClaimError(null);
    const result = await refreshName(input);
    if (result) {
      rememberName(config, result.name);
      setRefresh((value) => value + 1);
    }
  }
  function recordUpdate(
    name: string,
    account: string,
    update: TransactionUpdate,
    makePrimary = primary,
    attemptId?: string,
  ): void {
    const visible = isCurrentContext() && controller.getSnapshot().account === account;
    if (visible)
      setUpdates((items) => [...items.filter((item) => item.step !== update.step), update]);
    // Settlement refreshes the current selection through the latest wallet context.
    if (["confirmed", "skipped", "failed", "unconfirmed"].includes(update.status))
      void latestRefreshName.current();
    if (
      update.status === "approval" ||
      update.status === "pending" ||
      update.status === "unconfirmed"
    ) {
      const next = {
        name,
        account,
        update,
        primary: makePrimary,
        ...(attemptId ? { attemptId } : {}),
      };
      if (visible) setPending(next);
      savePendingClaim(config, next);
    } else if (update.status === "confirmed" || update.status === "failed") {
      if (visible) setPending(null);
      savePendingClaim(config, null, account);
    }
  }
  async function claim(): Promise<void> {
    if (
      !search ||
      (!search.available && search.owner !== wallet.account) ||
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
    const name = search.name;
    const account = wallet.account;
    const attemptId = crypto.randomUUID();
    setClaiming(true);
    setClaimError(null);
    setClaimed(null);
    setUpdates([]);
    rememberName(config, name);
    try {
      await registerName(name, {
        config,
        provider,
        wallet: wallet.provider,
        account,
        transport: wallet.transport,
        primary,
        signal: abort.signal,
        onUpdate: (update) => {
          // Preserve the original account's submitted operation after a wallet switch.
          const saved = readPendingClaim(config, account);
          if (abort.signal.aborted && (!saved || saved.attemptId !== attemptId)) return;
          recordUpdate(name, account, update, primary, attemptId);
        },
      });
      abort.signal.throwIfAborted();
      const result = await latestRefreshName.current();
      abort.signal.throwIfAborted();
      if (result?.name === name && result.owner === account) setClaimed({ name, primary });
    } catch (error) {
      if (operation.current === abort && isCurrentContext())
        setClaimError(
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
  async function recoverPending(stateOnly = false): Promise<void> {
    if (!pending || pendingCheck.current) return;
    const check = {};
    pendingCheck.current = check;
    const saved = pending;
    const revision = controller.getSnapshot().revision;
    const current = () =>
      pendingCheck.current === check &&
      isCurrentContext() &&
      controller.getSnapshot().revision === revision;
    setCheckingPending(true);
    setClaimError(null);
    setInput(saved.name);
    try {
      await refreshName(saved.name);
      if (!current()) return;
      const context = { config, provider };
      const status = stateOnly
        ? saved.update.nonce !== undefined &&
          (await isNonceConsumed(saved.account, saved.update.nonce, context))
          ? "replaced"
          : "pending"
        : await checkRegistrationTransaction(saved.name, saved.account, saved.update, context);
      const state = await readRegistrationState(saved.name, saved.account, context);
      if (!current()) return;
      if (!stateOnly && status === "pending" && !state.complete[saved.update.step]) {
        setClaimError(
          "Confirmation is still pending. Re-check name state or discard pending state to continue.",
        );
        return;
      }
      if (!stateOnly && status === "confirmed" && !state.complete[saved.update.step]) {
        setClaimError(
          "The expected name record is still incomplete. Re-check name state to continue.",
        );
        return;
      }
      setUpdates(
        Object.keys(stepLabels)
          .filter((step): step is RegistrationStep => step in state.complete)
          .filter((step) => (step !== "primary" || saved.primary) && state.complete[step])
          .map((step) => ({ step, status: state.complete[step] ? "skipped" : "unconfirmed" })),
      );
      savePendingClaim(config, null, saved.account);
      setPending(null);
      setPrimary(saved.primary ?? false);
      setClaimError(
        status === "replaced"
          ? "The saved nonce has been used. Name records were checked; continue from the first incomplete step."
          : "Name records were checked. Continue from the first incomplete step.",
      );
      setRefresh((value) => value + 1);
    } catch (error) {
      if (current()) setClaimError(errorMessage(error));
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
    setUpdates([]);
    void refreshName(pending.name);
    setInput(pending.name);
    setClaimError("Pending state discarded. Name availability is being checked before continuing.");
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
  const deployed = isDeployed(config);

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
          disabled={claiming || (wallet.busy && wallet.transport !== "extension")}
          onClick={() => {
            if (wallet.account || wallet.transport === "extension") void controller.disconnect();
            else {
              window.dispatchEvent(new Event("eip6963:requestProvider"));
              setPicker(true);
            }
          }}
        >
          {wallet.account || wallet.transport === "extension" ? "Disconnect" : "Connect wallet"}
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
            <section id="register" className="panel" aria-labelledby="register-title">
              <div className="section-heading">
                <p className="eyebrow">01 / REGISTER</p>
                <h2 id="register-title">Find your .qrl name</h2>
                <p>Use letters, numbers and hyphens.</p>
              </div>
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
                      setClaimed(null);
                    }}
                  />
                  <button disabled={!network.ready || searching || claiming || !input}>
                    {searching ? "Searching..." : "Search"}
                  </button>
                </div>
              </form>
              {searchError && <Message error>{searchError}</Message>}
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
                  </dl>
                  {canClaim && (
                    <>
                      <dl>
                        <Row label="Registration price">0 QRL</Row>
                        <Row label="Network fee">Gas applies to each transaction.</Row>
                        <Row label="Wallet approvals">
                          {primary ? "Up to 5 transactions" : "Up to 4 transactions"}
                        </Row>
                      </dl>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={primary}
                          disabled={claiming}
                          onChange={(event) => {
                            setPrimary(event.target.checked);
                          }}
                        />
                        <span>Use as my primary name</span>
                      </label>
                      <p className="muted text-sm">
                        Your primary name appears when someone looks up your address.
                      </p>
                    </>
                  )}
                  {wallet.account ? (
                    <button
                      className="w-full mt-5"
                      disabled={
                        !canClaim || !walletReady || claiming || pending !== null || !network.ready
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
                  ) : (
                    canClaim && (
                      <button
                        className="w-full mt-5"
                        onClick={() => {
                          setPicker(true);
                        }}
                      >
                        Connect wallet to claim
                      </button>
                    )
                  )}
                </div>
              )}
              {claimed && (
                <Message>
                  {claimed.name} now resolves to your address.
                  {claimed.primary ? " Your primary name is set." : ""}
                </Message>
              )}
              {claimError && <Message error>{claimError}</Message>}
              {updates.length > 0 && (
                <div className="transactions" aria-live="polite">
                  <h3>Transactions</h3>
                  <ol>
                    {updates.map((update) => (
                      <li key={update.step}>
                        <strong>{stepLabels[update.step]}</strong>
                        <span>{statusLabels[update.status]}</span>
                        {update.hash && (
                          <a
                            className="font-mono break-all"
                            href={`https://zondscan.com/tx/${update.hash}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {update.hash}
                          </a>
                        )}
                        {update.message && <p className="muted">{update.message}</p>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {pending && !claiming && (
                <div className="pending">
                  <Message>
                    Check the pending transaction for {pending.name} before continuing.
                  </Message>
                  {pending.update.hash && (
                    <>
                      <a
                        href={`https://zondscan.com/tx/${pending.update.hash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View transaction
                      </a>
                      <button
                        className="secondary mt-4 w-full"
                        disabled={checkingPending}
                        onClick={() => {
                          void recoverPending();
                        }}
                      >
                        {checkingPending ? "Checking..." : "Check confirmation"}
                      </button>
                    </>
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
                      recordUpdate(
                        pending.name,
                        pending.account,
                        { ...pending.update, hash: recoveryHash, status: "unconfirmed" },
                        pending.primary,
                        pending.attemptId,
                      );
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
                    {names.map((name) => (
                      <li key={name.node}>
                        <dl>
                          <Row label="Name">{name.name ?? "Spelling unavailable"}</Row>
                          {!name.name && (
                            <Row label="Name hash" mono>
                              {name.node}
                            </Row>
                          )}
                        </dl>
                        {name.name ? (
                          <a
                            href="#register"
                            onClick={() => {
                              setInput(name.name ?? "");
                              setClaimed(null);
                              void refreshName(name.name);
                            }}
                          >
                            Set up this name
                          </a>
                        ) : (
                          <p className="muted text-sm">
                            Search its spelling above to add it to this browser.
                          </p>
                        )}
                      </li>
                    ))}
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
                      void controller.disconnect();
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
