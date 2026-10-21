/** @param {unknown} value
 * @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value
 * @returns {value is string} */
export function isHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** @param {unknown} value */
export function canonicalAddress(value) {
  if (typeof value !== "string") throw new Error("Expected a 64-byte QRL address");
  const hex = value.replace(/^(?:Q|q|0x)/, "");
  if (hex.length !== 128 || /[^0-9a-fA-F]/.test(hex) || hex === value) {
    throw new Error("Expected Q followed by 128 hexadecimal characters");
  }
  return `Q${hex.toLowerCase()}`;
}

export const ZERO_ADDRESS = `Q${"0".repeat(128)}`;

/** @type {readonly ["QNSRegistry", "Root", "FIFSQRLRegistrar", "ReverseRegistrar", "QRLPublicResolver", "QRLSignatureVerifier"]} */
export const CONTRACT_NAMES = [
  "QNSRegistry",
  "Root",
  "FIFSQRLRegistrar",
  "ReverseRegistrar",
  "QRLPublicResolver",
  "QRLSignatureVerifier",
];
/**
 * @typedef {(typeof CONTRACT_NAMES)[number]} ContractName
 * @typedef {{network: string, chainId: number, rpcUrl: string, tld: "qrl",
 * qrl2PrecompileSet: "qrl2-pq-v1", genesisHash?: string, deploymentBlock?: number,
 * contracts: Record<ContractName, string | null>}} NetworkConfig
 */

/**
 * Parse deployment JSON and retain only browser-safe fields.
 * This source is also imported directly by the deployment script before initialization.
 * @param {unknown} value
 * @returns {NetworkConfig}
 */
export function parseNetworkConfig(value) {
  if (!isRecord(value) || !isRecord(value.contracts)) throw new Error("Invalid QNS configuration");
  if (typeof value.network !== "string" || !value.network || value.network.length > 100)
    throw new Error("Missing network name");
  if (
    typeof value.chainId !== "number" ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId <= 0
  )
    throw new Error("Invalid chain ID");
  if (value.tld !== "qrl" || value.qrl2PrecompileSet !== "qrl2-pq-v1")
    throw new Error("Expected the QRL 2.0 .qrl configuration");
  if (typeof value.rpcUrl !== "string") throw new Error("Missing RPC URL");
  const url = new URL(value.rpcUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Use an HTTPS RPC URL or a local HTTP RPC URL without credentials");
  }
  if ((!loopback || value.genesisHash !== undefined) && !isHash(value.genesisHash))
    throw new Error("Missing or invalid genesis hash");
  const deploymentBlock = value.deploymentBlock;
  if (
    deploymentBlock !== undefined &&
    (typeof deploymentBlock !== "number" ||
      !Number.isSafeInteger(deploymentBlock) ||
      deploymentBlock <= 0)
  )
    throw new Error("Deployment block must be a positive integer");
  /** @param {ContractName} name */
  function contract(name) {
    if (!isRecord(value) || !isRecord(value.contracts)) throw new Error("Invalid contracts");
    const address = value.contracts[name];
    if (address === null) return null;
    const canonical = canonicalAddress(address);
    if (canonical === ZERO_ADDRESS) throw new Error(`Invalid ${name} address`);
    return canonical;
  }
  return {
    network: value.network,
    chainId: value.chainId,
    rpcUrl: url.href,
    tld: "qrl",
    qrl2PrecompileSet: "qrl2-pq-v1",
    ...(isHash(value.genesisHash) ? { genesisHash: value.genesisHash.toLowerCase() } : {}),
    ...(deploymentBlock !== undefined ? { deploymentBlock } : {}),
    contracts: {
      QNSRegistry: contract("QNSRegistry"),
      Root: contract("Root"),
      FIFSQRLRegistrar: contract("FIFSQRLRegistrar"),
      ReverseRegistrar: contract("ReverseRegistrar"),
      QRLPublicResolver: contract("QRLPublicResolver"),
      QRLSignatureVerifier: contract("QRLSignatureVerifier"),
    },
  };
}
