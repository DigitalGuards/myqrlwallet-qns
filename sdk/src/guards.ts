/** Validate the byte string returned by an untrusted RPC provider. */
export function isHexBytes(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("0x") &&
    value.length % 2 === 0 &&
    !/[^0-9a-fA-F]/.test(value.slice(2))
  );
}
