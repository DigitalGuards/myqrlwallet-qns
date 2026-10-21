import { MockChain } from "../../../sdk/src/__tests__/mockProvider";
import type { Relay } from "../wallet";

export class TestWallet extends MockChain implements Relay {
  private handlers = new Map<string, Set<(value?: unknown) => void>>();
  connected = false;
  stored = false;
  disconnected = 0;
  resets = 0;
  uri = "qrlconnect://?q=fixture";
  listen(event: string, handler: (value?: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
    };
  }
  emit(event: string, value?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
  getAccounts(): string[] {
    return this.accounts;
  }
  isConnected(): boolean {
    return this.connected;
  }
  hasStoredSession(): boolean {
    return this.stored;
  }
  getConnectionURI(): Promise<string> {
    return Promise.resolve(this.uri);
  }
  newConnection(): Promise<string> {
    this.resets++;
    this.emit("disconnect");
    this.emit("accountsChanged", []);
    return Promise.resolve(this.uri + "-fresh");
  }
  disconnect(): Promise<void> {
    this.disconnected++;
    this.stored = false;
    this.emit("disconnect");
    return Promise.resolve();
  }
}
