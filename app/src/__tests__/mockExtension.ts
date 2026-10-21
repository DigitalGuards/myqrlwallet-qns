import { MockChain } from "../../../sdk/src/__tests__/mockProvider";

export function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error("Missing resolver");
      resolve(value);
    },
    reject(error: Error) {
      if (!reject) throw new Error("Missing rejecter");
      reject(error);
    },
  };
}

const events = ["accountsChanged", "chainChanged", "disconnect"];

/** EIP-1193 extension with approval, lock and permission events. */
export class TestExtension extends MockChain {
  locked = true;
  granted = false;
  listeners = new Map<string, Set<(value: unknown) => void>>();
  subscriptionsAtRequest: number[][] = [];
  approvals: ReturnType<typeof deferred<unknown>>[] = [];
  probe: ReturnType<typeof deferred<unknown>> | undefined;
  revocation: ReturnType<typeof deferred<unknown>> | undefined;
  revokeError: Error | undefined;

  on(event: string, listener: (value: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  removeListener(event: string, listener: (value: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  listenerCounts(): number[] {
    return events.map((event) => this.listeners.get(event)?.size ?? 0);
  }
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    switch (args.method) {
      case "qrl_accounts":
        this.calls.push(args);
        this.subscriptionsAtRequest.push(this.listenerCounts());
        if (this.probe) return this.probe.promise;
        if (this.locked) return Promise.resolve([]);
        return this.granted
          ? Promise.resolve(this.accounts)
          : Promise.reject(Object.assign(new Error("Site has no wallet access"), { code: 4100 }));
      case "qrl_requestAccounts": {
        this.calls.push(args);
        this.subscriptionsAtRequest.push(this.listenerCounts());
        if (!this.locked && this.granted) return Promise.resolve(this.accounts);
        const approval = deferred<unknown>();
        this.approvals.push(approval);
        return approval.promise;
      }
      case "wallet_revokePermissions":
        this.calls.push(args);
        if (this.revokeError) return Promise.reject(this.revokeError);
        return (this.revocation?.promise ?? Promise.resolve(null)).then(() => {
          this.granted = false;
          this.emit("accountsChanged", []);
          return null;
        });
      default:
        return super.request(args);
    }
  }
  approve(): void {
    this.granted = true;
    this.emit("accountsChanged", this.accounts);
    this.approvals.at(-1)?.resolve(this.accounts);
  }
  lock(): void {
    this.locked = true;
    this.emit("accountsChanged", []);
  }
  unlock(): void {
    this.locked = false;
    if (this.granted) this.emit("accountsChanged", this.accounts);
  }
}
