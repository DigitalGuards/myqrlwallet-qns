import { parseNetworkConfig, type NetworkConfig, type RpcProvider } from "@qns/sdk";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  if (isRecord(error) && error.code === 4001)
    return "Request declined in your wallet. You can continue when ready.";
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}

export function httpProvider(url: string): RpcProvider {
  let id = 0;
  return {
    async request({ method, params = [] }) {
      const requestId = ++id;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
        signal: AbortSignal.timeout(20_000),
        credentials: "omit",
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error(`Network request failed (${response.status})`);
      }
      if (!isRecord(body) || body.jsonrpc !== "2.0" || body.id !== requestId)
        throw new Error("Invalid network response");
      if (body.error !== undefined)
        throw Object.assign(
          new Error(
            isRecord(body.error) && typeof body.error.message === "string"
              ? body.error.message
              : "Network request failed",
          ),
          isRecord(body.error) ? { code: body.error.code, data: body.error.data } : {},
        );
      if (!response.ok) throw new Error(`Network request failed (${response.status})`);
      if (!("result" in body)) throw new Error("Missing network result");
      return body.result;
    },
  };
}

export async function loadConfig(): Promise<NetworkConfig> {
  const response = await fetch(`${import.meta.env.BASE_URL}qns-config.json`, { cache: "no-store" });
  if (!response.ok) throw new Error("QNS configuration is unavailable");
  const value: unknown = await response.json();
  return parseNetworkConfig(value);
}
