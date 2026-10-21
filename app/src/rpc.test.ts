import { afterEach, describe, expect, it, vi } from "vitest";
import { httpProvider, errorMessage } from "./rpc";

afterEach(() => vi.unstubAllGlobals());
describe("RPC boundary", () => {
  it("checks response IDs and propagates RPC errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "0x1" })));
    vi.stubGlobal("fetch", fetch);
    await expect(
      httpProvider("https://example.test").request({ method: "qrl_chainId" }),
    ).rejects.toThrow("Invalid network response");
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "RPC unavailable" } }),
      ),
    );
    await expect(
      httpProvider("https://example.test").request({ method: "qrl_chainId" }),
    ).rejects.toThrow("RPC unavailable");
  });
  it("uses plain rejection copy", () => {
    expect(errorMessage({ code: 4001 })).toContain("Request declined");
  });
});

it("preserves range-limit RPC errors returned with HTTP 400", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32602,
            message: "qrl_getLogs block range exceeds maximum 1000 blocks",
            data: { limit: 1000 },
          },
        }),
        { status: 400 },
      ),
    ),
  );
  await expect(
    httpProvider("https://example.test").request({ method: "qrl_getLogs" }),
  ).rejects.toMatchObject({
    message: "qrl_getLogs block range exceeds maximum 1000 blocks",
    code: -32602,
    data: { limit: 1000 },
  });
});

it("reports an HTTP failure when the endpoint returns a non-JSON error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));
  await expect(
    httpProvider("https://example.test").request({ method: "qrl_getLogs" }),
  ).rejects.toThrow("Network request failed (503)");
});
