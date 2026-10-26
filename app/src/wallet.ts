// Extension sessions and relay connections follow myqrlwallet-connect.
import { isCurrentQrlAddress, QRLConnect, type QRLConnectOptions } from "@qrlwallet/connect";
import { canonicalAddress, type NetworkConfig, type RpcProvider } from "@qns/sdk";
import { errorMessage, isRecord } from "./rpc";
import {
  createExtensionSession,
  type ExtensionSession,
  type ExtensionSessionState,
} from "@qrlwallet/connect-ui/extension";

type Handler = (payload?: unknown) => void;
type WalletEvent =
  "connect" | "accountsChanged" | "chainChanged" | "disconnect" | "statusChanged" | "late_response";
export interface WalletProvider extends RpcProvider {
  listen(event: WalletEvent, handler: Handler): () => void;
}
export interface Relay extends WalletProvider {
  getConnectionURI(): Promise<string>;
  newConnection(): Promise<string>;
  disconnect(): Promise<void>;
  hasStoredSession(): boolean;
  getAccounts(): string[];
  isConnected(): boolean;
}

export function createRelay(options: QRLConnectOptions): Relay {
  const qrl = new QRLConnect(options);
  return {
    request: (args) => qrl.request(args),
    getConnectionURI: () => qrl.getConnectionURI(),
    newConnection: () => qrl.newConnection(),
    disconnect: () => qrl.disconnect(),
    hasStoredSession: () => qrl.hasStoredSession(),
    getAccounts: () => qrl.getAccounts(),
    isConnected: () => qrl.isConnected(),
    listen(event, handler) {
      qrl.on(event, handler);
      return () => {
        qrl.off(event, handler);
      };
    },
  };
}

export function requireAccount(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error("Select one QRL 2.0 account in your wallet");
  return canonicalAddress(value[0]);
}

export interface WalletChoice {
  id: string;
  name: string;
  provider: WalletProvider;
}
export interface WalletState {
  choices: WalletChoice[];
  account: string | null;
  provider: WalletProvider | null;
  transport: "extension" | "relay" | null;
  uri: string | null;
  status: string;
  error: string | null;
  busy: boolean;
  revision: number;
  lateTransaction: { id: string | number; hash: string | null; rejected: boolean } | null;
}

const extensionProviders = new WeakMap<object, WalletProvider>();
const revocationTimeoutMs = 10_000;
const revocationTimeoutMessage =
  "Disconnected on this page. The wallet did not answer; remove this site in the extension if it still shows as connected.";

async function settlesWithinTimeout(work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, revocationTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Validate announcements before calling page-supplied providers. */
export function extensionAnnouncement(value: unknown): WalletChoice | null {
  if (!isRecord(value) || !isRecord(value.info) || !isRecord(value.provider)) return null;
  const { info, provider } = value;
  if (info.rdns !== "com.qrlwallet.extension" && info.rdns !== "theqrl.org") return null;
  if (typeof info.uuid !== "string" || !info.uuid || typeof info.name !== "string") return null;
  const request = provider.request;
  if (typeof request !== "function") return null;
  let walletProvider = extensionProviders.get(provider);
  if (!walletProvider) {
    walletProvider = {
      async request(args) {
        const result: unknown = Reflect.apply(request, provider, [args]);
        return await result;
      },
      listen(event, handler) {
        if (typeof provider.on === "function")
          Reflect.apply(provider.on, provider, [event, handler]);
        return () => {
          const remove = provider.removeListener ?? provider.off;
          if (typeof remove === "function") Reflect.apply(remove, provider, [event, handler]);
        };
      },
    };
    extensionProviders.set(provider, walletProvider);
  }
  return {
    id: info.rdns,
    name: info.rdns === "com.qrlwallet.extension" ? "MyQRLWallet Extension" : "QRL Web3 Wallet",
    provider: walletProvider,
  };
}

export class WalletController {
  private state: WalletState = {
    choices: [],
    account: null,
    provider: null,
    transport: null,
    uri: null,
    status: "Disconnected",
    error: null,
    busy: false,
    revision: 0,
    lateTransaction: null,
  };
  private listeners = new Set<() => void>();
  private relay: Relay | null = null;
  private relayRetirement: Promise<void> | null = null;
  private extension: {
    choice: WalletChoice;
    session: ExtensionSession;
    ready: Promise<void> | null;
    activation: number;
    cancelActivation: (() => void) | null;
    explicitDisconnect: boolean;
    waiting: boolean;
    closing: Promise<void> | null;
  } | null = null;
  private revocations = new WeakMap<WalletProvider, Set<Promise<void>>>();
  private extensionChainId: string | null = null;
  private relaySubscriptions: (() => void)[] = [];
  private generation = 0;
  private expectedLateResponse: string | number | undefined;
  private authorizing: Promise<void> | null = null;
  private mode: "extension" | "relay" | null = null;
  private readonly storageKey: string;

  constructor(
    private config: NetworkConfig,
    private relayFactory = createRelay,
  ) {
    this.storageKey = `qns:wallet:${config.chainId}:${config.contracts.QNSRegistry ?? "pending"}`;
  }
  getSnapshot = (): WalletState => this.state;
  expectLateResponse(id: string | number | undefined): void {
    this.expectedLateResponse = id;
  }
  clearLateTransaction(): void {
    this.update({ lateTransaction: null });
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<WalletState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private remembered(): string | null {
    try {
      return localStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
  }
  private remember(value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(this.storageKey);
      else localStorage.setItem(this.storageKey, value);
    } catch {
      /* Pairing also works without persistent storage. */
    }
  }
  private clear(): void {
    this.generation++;
    this.expectedLateResponse = undefined;
    this.mode = null;
    this.authorizing = null;
    this.extension?.cancelActivation?.();
    this.extension?.session.dispose();
    this.extension = null;
    this.extensionChainId = null;
    this.update({
      account: null,
      provider: null,
      transport: null,
      uri: null,
      busy: false,
      status: "Disconnected",
      lateTransaction: null,
      revision: this.state.revision + 1,
    });
  }
  start(): () => void {
    const announce = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const value: unknown = event.detail;
      const choice = extensionAnnouncement(value);
      if (!choice || this.state.choices.some((item) => item.id === choice.id)) return;
      this.update({ choices: [...this.state.choices, choice] });
      if (this.remembered() === choice.id && this.mode === null)
        void this.connectExtension(choice, true);
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    if (this.remembered() === "relay") {
      this.mode = "relay";
      const relay = this.getRelay();
      if (relay.hasStoredSession()) {
        this.update({ status: "Reconnecting" });
        if (relay.isConnected()) this.authorizeRelay();
      } else {
        this.remember(null);
        this.clear();
      }
    }
    return () => {
      window.removeEventListener("eip6963:announceProvider", announce);
      this.extension?.cancelActivation?.();
      this.extension?.session.dispose();
      this.extension = null;
      for (const remove of this.relaySubscriptions) remove();
      this.generation++;
    };
  }
  private getRelay(): Relay {
    if (this.relay) return this.relay;
    const relay = this.relayFactory({
      dappMetadata: { name: "QNS", url: location.origin, redirectUrl: location.href },
      chainId: `0x${this.config.chainId.toString(16)}`,
      storageKey: `${this.storageKey}:session`,
      autoReconnect: true,
      announceProvider: false,
    });
    this.relay = relay;
    this.relaySubscriptions = [
      relay.listen("late_response", (value) => {
        if (this.mode !== "relay" || !isRecord(value) || value.method !== "qrl_sendTransaction")
          return;
        if (
          !(typeof value.id === "string" && value.id.length > 0) &&
          !(typeof value.id === "number" && Number.isSafeInteger(value.id))
        )
          return;
        const id = value.id;
        // Connect 5.0.2 exposes late IDs without an outgoing-ID hook. Unbound responses
        // require explicit transaction lookup or name-state recovery.
        if (id !== this.expectedLateResponse) return;
        if (typeof value.result === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.result)) {
          this.update({ lateTransaction: { id, hash: value.result, rejected: false } });
        } else if (isRecord(value.error) && value.error.code === 4001) {
          this.update({ lateTransaction: { id, hash: null, rejected: true } });
        }
      }),
      relay.listen("connect", () => {
        if (this.mode === "relay" && !this.state.busy) this.authorizeRelay();
      }),
      relay.listen("accountsChanged", (accounts) => {
        if (this.mode === "relay" && !this.state.busy)
          this.accountsChanged(accounts, relay, "relay");
      }),
      relay.listen("chainChanged", () => {
        if (this.mode === "relay") this.update({ revision: this.state.revision + 1 });
      }),
      relay.listen("statusChanged", (status) => {
        if (this.mode === "relay" && typeof status === "string") this.update({ status });
      }),
      relay.listen("disconnect", () => {
        if (this.mode !== "relay" || this.state.busy) return;
        if (relay.hasStoredSession()) {
          this.update({ status: "Wallet away. Reopen it to continue." });
          return;
        }
        this.remember(null);
        this.clear();
      }),
    ];
    return relay;
  }
  private accountsChanged(
    accounts: unknown,
    provider: WalletProvider,
    transport: "extension" | "relay",
  ): void {
    try {
      const account = requireAccount(accounts);
      if (account !== this.state.account) this.expectedLateResponse = undefined;
      this.update({
        lateTransaction: null,
        account,
        provider,
        transport,
        uri: null,
        status: "Connected",
        error: null,
        revision: this.state.revision + (account === this.state.account ? 0 : 1),
      });
    } catch {
      if (transport === "relay") {
        this.update({ account: null, provider: null, revision: this.state.revision + 1 });
        void this.disconnect();
      } else {
        this.remember(null);
        this.clear();
      }
    }
  }
  private authorizeRelay(): void {
    if (this.authorizing) return;
    const generation = this.generation;
    const relay = this.getRelay();
    const work = (async () => {
      try {
        const cached = relay.getAccounts();
        const accounts: unknown = cached.length
          ? cached
          : await relay.request({ method: "qrl_requestAccounts" });
        if (generation !== this.generation || this.mode !== "relay") return;
        const account = requireAccount(accounts);
        this.remember("relay");
        this.update({
          account,
          provider: relay,
          transport: "relay",
          uri: null,
          error: null,
          status: "Connected",
          revision: this.state.revision + (account === this.state.account ? 0 : 1),
        });
      } catch (error) {
        if (generation !== this.generation || this.mode !== "relay") return;
        this.update({ error: errorMessage(error) });
        await this.disconnect();
      }
    })();
    this.authorizing = work;
    void work.finally(() => {
      if (this.authorizing === work) this.authorizing = null;
    });
  }
  private extensionChanged(state: ExtensionSessionState, choice: WalletChoice): void {
    const active = state.intent || state.status === "disconnecting";
    this.mode = active ? "extension" : null;
    if (state.intent) this.remember(choice.id);
    else this.remember(null);

    let account: string | null = null;
    let status = "Disconnected";
    let error = state.error?.message ?? null;
    if (state.status === "pending") status = `Unlock and approve in ${choice.name}`;
    else if (state.status === "locked")
      status = "Wallet locked. Unlock the extension, or press Disconnect.";
    else if (state.status === "disconnecting") status = "Disconnecting";
    else if (state.status === "connected") {
      try {
        account = requireAccount(state.accounts);
        status = "Connected";
      } catch (cause) {
        status = errorMessage(cause);
      }
    } else if (state.status === "disconnected" && error && this.extension?.explicitDisconnect)
      error = `Disconnected on this page. The wallet reported: ${error}`;

    const provider = active ? choice.provider : null;
    const changed =
      account !== this.state.account ||
      provider !== this.state.provider ||
      state.chainId !== this.extensionChainId;
    if (changed) this.expectedLateResponse = undefined;
    this.extensionChainId = state.chainId;
    this.update({
      account,
      provider,
      transport: active ? "extension" : null,
      uri: null,
      status,
      error,
      busy: state.status === "pending" || state.status === "disconnecting",
      lateTransaction: null,
      revision: this.state.revision + (changed ? 1 : 0),
    });
  }
  private trackRevocation(provider: WalletProvider, request: Promise<unknown>): void {
    let pending = this.revocations.get(provider);
    if (!pending) {
      pending = new Set();
      this.revocations.set(provider, pending);
    }
    const settled = request.then(
      () => {
        // The barrier only needs completion; discard the revocation response.
      },
      () => {
        // Release the barrier on failure too; the session receives the original rejection.
      },
    );
    pending.add(settled);
    void settled.then(() => {
      pending.delete(settled);
    });
  }
  private revocationBarrier(provider: WalletProvider): Promise<boolean> | null {
    // This barrier lasts for this page; wallets must order writes across reloads.
    const pending = this.revocations.get(provider);
    if (!pending?.size) return null;
    return settlesWithinTimeout(
      (async () => {
        // A disposed helper can still dispatch its already scheduled revoke.
        while (pending.size) await Promise.all([...pending]);
      })(),
    );
  }
  async connectExtension(choice = this.extension?.choice, restore = false): Promise<void> {
    if (!choice || (this.state.busy && this.mode !== "extension")) return;
    this.remember(choice.id);
    if (this.extension?.choice.provider !== choice.provider) {
      this.clear();
      this.mode = "extension";
      const generation = this.generation;
      const subscriptions = new Map<(value: unknown) => void, () => void>();
      const session = createExtensionSession(
        {
          request: ({ method, params }) => {
            const request = choice.provider.request({
              method,
              ...(params ? { params: [...params] } : {}),
            });
            if (method === "wallet_revokePermissions")
              this.trackRevocation(choice.provider, request);
            return request;
          },
          on: (event, handler) => {
            subscriptions.set(handler, choice.provider.listen(event, handler));
          },
          removeListener: (_event, handler) => {
            subscriptions.get(handler)?.();
            subscriptions.delete(handler);
          },
        },
        {
          validateAccount: isCurrentQrlAddress,
          // This page runs its own revocation deadline and revoke barrier (see
          // disconnect() and trackRevocation), so the helper's built-in deadline
          // is set to its maximum and the page's tested behaviour stays as is.
          revokeTimeoutMs: 2_147_483_647,
          onStateChange: (state) => {
            // Activation owns the UI while the helper finishes its previous revoke.
            if (generation === this.generation && !this.extension?.waiting)
              this.extensionChanged(state, choice);
          },
        },
      );
      const relay = this.relay;
      this.extension = {
        choice,
        session,
        ready: relay
          ? (this.relayRetirement ??= Promise.resolve().then(() => relay.disconnect()))
          : null,
        activation: 0,
        cancelActivation: null,
        explicitDisconnect: false,
        waiting: false,
        closing: null,
      };
    }
    const selected = this.extension;
    selected.cancelActivation?.();
    const activation = ++selected.activation;
    const cancelled = new Promise<void>((resolve) => {
      selected.cancelActivation = resolve;
    });
    selected.explicitDisconnect = false;
    selected.waiting = true;
    this.mode = "extension";
    if (this.state.account !== null) this.expectedLateResponse = undefined;
    this.update({
      account: null,
      provider: choice.provider,
      transport: "extension",
      busy: true,
      error: null,
      status: `Unlock and approve in ${choice.name}`,
      revision: this.state.revision + (this.state.account === null ? 0 : 1),
    });
    try {
      if (selected.ready) await Promise.race([selected.ready, cancelled]);
      if (this.extension !== selected || selected.activation !== activation) return;
      if (this.relayRetirement === selected.ready) this.relayRetirement = null;
      const barrier = this.revocationBarrier(choice.provider);
      if (barrier) {
        this.update({
          account: null,
          busy: true,
          status: `Finishing disconnect in ${choice.name}`,
        });
        const settled = await Promise.race([barrier, cancelled]);
        if (this.extension !== selected || selected.activation !== activation) return;
        if (!settled) {
          this.remember(null);
          this.clear();
          this.update({ error: revocationTimeoutMessage });
          return;
        }
      }
      selected.waiting = false;
      await Promise.race([
        restore ? selected.session.restore() : selected.session.connect(),
        cancelled,
      ]);
    } catch (error) {
      if (this.extension === selected && selected.activation === activation) {
        if (this.relayRetirement === selected.ready) this.relayRetirement = null;
        this.remember(null);
        this.clear();
        if (!restore) this.update({ error: errorMessage(error) });
      }
    } finally {
      if (selected.activation === activation) {
        selected.cancelActivation?.();
        selected.cancelActivation = null;
      }
    }
  }
  async pair(fresh = false): Promise<void> {
    if (this.state.busy && this.mode !== "extension") return;
    this.clear();
    this.mode = "relay";
    const generation = this.generation;
    this.update({ busy: true, error: null, status: "Preparing connection" });
    try {
      const relay = this.getRelay();
      // Extension selection may still be retiring this relay's previous channel.
      const retirement = this.relayRetirement;
      if (retirement) {
        try {
          await retirement;
        } finally {
          if (this.relayRetirement === retirement) this.relayRetirement = null;
        }
        if (generation !== this.generation) return;
      }
      const uri = fresh ? await relay.newConnection() : await relay.getConnectionURI();
      if (generation !== this.generation) return;
      this.remember("relay");
      this.update({ uri, status: "Waiting for wallet", busy: false });
      if (relay.isConnected()) this.authorizeRelay();
    } catch (error) {
      if (generation === this.generation) {
        this.update({ error: errorMessage(error), busy: false });
        await this.disconnect();
      }
    }
  }
  async reconnect(): Promise<void> {
    if (this.mode === "extension" && this.extension) {
      const choice = this.extension.choice;
      this.clear();
      await this.connectExtension(choice, true);
    } else {
      await this.disconnect();
    }
  }
  async disconnect(): Promise<void> {
    if (this.mode === "extension" && this.extension) {
      // Cancel activation even when the previous relay is still retiring.
      const selected = this.extension;
      this.remember(null);
      selected.explicitDisconnect = true;
      selected.activation++;
      selected.cancelActivation?.();
      selected.cancelActivation = null;
      selected.waiting = false;
      if (selected.closing) {
        await selected.closing;
        return;
      }
      const closing = selected.session.disconnect();
      // Reserve the provider barrier before the helper dispatches its revoke.
      // The provider wrapper also tracks the actual request across disposal.
      this.trackRevocation(selected.choice.provider, closing);
      const work = settlesWithinTimeout(closing).then((settled) => {
        if (!settled && this.extension === selected && !selected.waiting) {
          this.clear();
          this.update({ error: revocationTimeoutMessage });
        }
      });
      selected.closing = work;
      await work;
      if (selected.closing === work) selected.closing = null;
      return;
    }
    if (this.state.busy) return;
    const wasRelay = this.mode === "relay";
    this.update({ busy: true });
    try {
      if (wasRelay && this.relay) await this.relay.disconnect();
      this.remember(null);
      this.clear();
    } catch (error) {
      this.update({ error: errorMessage(error), busy: false });
    }
  }
}
