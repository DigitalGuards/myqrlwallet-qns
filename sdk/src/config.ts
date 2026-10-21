import { isRecord, quantity } from "./abi.js";
import { CONTRACT_NAMES, type ContractName, type NetworkConfig } from "./networkConfig.js";
import type { RpcProvider } from "./resolver.js";
export { CONTRACT_NAMES, parseNetworkConfig } from "./networkConfig.js";
export type { ContractName, NetworkConfig } from "./networkConfig.js";

export function requireContract(config: NetworkConfig, name: ContractName): string {
  const address = config.contracts[name];
  if (address === null) throw new Error("QNS deployment is pending on this network");
  return address;
}

export function isDeployed(config: NetworkConfig): boolean {
  return CONTRACT_NAMES.every((name) => config.contracts[name] !== null);
}

export async function assertNetwork(provider: RpcProvider, config: NetworkConfig): Promise<void> {
  if (quantity(await provider.request({ method: "qrl_chainId" })) !== BigInt(config.chainId)) {
    throw new Error(`Select chain ${config.chainId} in your wallet`);
  }
  if (config.genesisHash) {
    const block = await provider.request({
      method: "qrl_getBlockByNumber",
      params: ["0x0", false],
    });
    if (
      !isRecord(block) ||
      typeof block.hash !== "string" ||
      block.hash.toLowerCase() !== config.genesisHash
    ) {
      throw new Error("The network genesis does not match the QNS configuration");
    }
  }
}
