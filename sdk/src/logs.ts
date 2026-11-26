import { isRecord, toQuantity } from "./abi.js";
import type { RpcProvider } from "./resolver.js";

/** Pages start at 2,000 blocks and shrink to the endpoint's range limit. */
export const LOG_PAGE_BLOCKS = 2000n;

/** Retry only range refusals. An unnamed range limit is discovered by bounded halving. */
export function smallerLogRange(error: unknown, span: bigint): bigint | null {
  const message = isRecord(error) && typeof error.message === "string" ? error.message : "";
  if (
    span <= 1n ||
    !/(?:block|range)/i.test(message) ||
    !/(?:limit|max|exceed|too (?:large|wide)|at most|up to)/i.test(message)
  )
    return null;
  const match =
    /(?:max(?:imum)?(?:[\s_-]+block)?(?:[\s_-]+range)?(?:[\s_-]+(?:limit|size))?(?:\s+(?:is|of))?|limited to|limit(?:\s+(?:is|of))?|up to|at most)\s*[:=]?\s*([\d,]+)\b/i.exec(
      message,
    );
  const limit = match?.[1] ? BigInt(match[1].replaceAll(",", "")) : 0n;
  return limit > 0n && limit < span ? limit : span / 2n;
}

export interface LogFilter {
  address: string | readonly string[];
  topics: readonly (string | null)[];
}

/**
 * Runs every filter over [from, to] in shared pages. A range refusal shrinks the page and
 * retries the same start for all filters, so each filter's result covers the range without gaps.
 */
export async function scanLogs(
  provider: RpcProvider,
  filters: readonly LogFilter[],
  from: bigint,
  to: bigint,
  signal?: AbortSignal,
): Promise<unknown[][]> {
  const results = filters.map((): unknown[] => []);
  let pageSize = LOG_PAGE_BLOCKS;
  for (let start = from; start <= to;) {
    signal?.throwIfAborted();
    const end = start + pageSize - 1n < to ? start + pageSize - 1n : to;
    const page: unknown[][] = [];
    try {
      for (const filter of filters) {
        const logs = await provider.request({
          method: "qrl_getLogs",
          params: [
            {
              address: filter.address,
              fromBlock: toQuantity(start),
              toBlock: toQuantity(end),
              topics: filter.topics,
            },
          ],
        });
        signal?.throwIfAborted();
        if (!Array.isArray(logs)) throw new Error("Invalid log response");
        page.push(logs);
      }
    } catch (error) {
      signal?.throwIfAborted();
      const smaller = smallerLogRange(error, end - start + 1n);
      if (smaller === null) throw error;
      pageSize = smaller;
      continue;
    }
    page.forEach((logs, index) => results[index]?.push(...logs));
    start = end + 1n;
  }
  return results;
}
