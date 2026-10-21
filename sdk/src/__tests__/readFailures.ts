import { isRecord, selector } from "../abi.js";
import { registrationName } from "../registration.js";
import { reverseNodeFor } from "../resolver.js";
import { ACCOUNT, OTHER, config, MockChain } from "./mockProvider.js";

export const readFailures = [
  "owner",
  "resolver",
  "address",
  "spelling",
  "reverse resolver",
  "reverse spelling",
  "old primary resolver",
  "old primary address",
  "custom address",
  "custom spelling",
  "destination address",
  "destination spelling",
] as const;

export class ReadFailureChain extends MockChain {
  failing = true;
  readonly message = "RPC request failed: missing trie node";
  private readonly target: { to: string; data: string };

  constructor(failure: (typeof readFailures)[number]) {
    super();
    const name = registrationName("alice");
    this.seed(name.name, ACCOUNT);
    this.resolvers.set(name.node, config.contracts.QRLPublicResolver ?? "");
    this.addresses.set(name.node, ACCOUNT);
    this.spellings.set(name.node, name.name);
    this.primary = name.name;
    this.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    const old = registrationName("old");
    this.resolvers.set(old.node, OTHER);
    this.addresses.set(old.node, ACCOUNT);
    if (failure.startsWith("old primary")) this.primary = old.name;
    if (failure.startsWith("custom") || failure.startsWith("destination"))
      this.resolvers.set(name.node, OTHER);
    const registry = config.contracts.QNSRegistry ?? "";
    const resolver = config.contracts.QRLPublicResolver ?? "";
    const targets = {
      owner: [registry, "owner(bytes32)", name.node],
      resolver: [registry, "resolver(bytes32)", name.node],
      address: [resolver, "addr(bytes32)", name.node],
      spelling: [resolver, "name(bytes32)", name.node],
      "reverse resolver": [registry, "resolver(bytes32)", reverseNodeFor(ACCOUNT)],
      "reverse spelling": [resolver, "name(bytes32)", reverseNodeFor(ACCOUNT)],
      "old primary resolver": [registry, "resolver(bytes32)", old.node],
      "old primary address": [OTHER, "addr(bytes32)", old.node],
      "custom address": [OTHER, "addr(bytes32)", name.node],
      "custom spelling": [OTHER, "name(bytes32)", name.node],
      "destination address": [resolver, "addr(bytes32)", name.node],
      "destination spelling": [resolver, "name(bytes32)", name.node],
    } as const;
    const [to, signature, node] = targets[failure];
    this.target = { to, data: selector(signature) + node.slice(2) };
  }

  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    const call = args.params?.[0];
    if (
      this.failing &&
      args.method === "qrl_call" &&
      args.params?.[1] !== "latest" &&
      isRecord(call) &&
      call.to === this.target.to &&
      typeof call.data === "string" &&
      call.data.startsWith(this.target.data)
    )
      return Promise.reject(new Error(this.message));
    return super.request(args);
  }
}
