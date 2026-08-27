/** Error raised for names that fail QNS normalization. */
export class QnsNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QnsNameError";
  }
}

const LABEL_RE = /^[a-z0-9-]+$/;

/**
 * Normalize a QNS name with a deliberately conservative ASCII profile.
 *
 * This is a strict subset of ENSIP-15: ASCII uppercase letters fold to
 * lowercase, and every label must then match `[a-z0-9-]+`. Anything else
 * (Unicode, whitespace, underscores, empty labels, leading or trailing
 * dots) raises `QnsNameError` instead of silently producing a different
 * namehash. Full UTS-46 processing can widen this later without changing
 * the result for names this profile accepts.
 *
 * The empty string is the ENS root and passes through unchanged.
 */
export function normalize(name: string): string {
  if (name === "") return "";
  let lowered = "";
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    lowered += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : ch;
  }
  const labels = lowered.split(".");
  for (const label of labels) {
    if (label === "") {
      throw new QnsNameError(`empty label in "${name}"`);
    }
    if (!LABEL_RE.test(label)) {
      throw new QnsNameError(
        `unsupported character in label "${label}"; the conservative QNS ` +
          "profile accepts only lowercase a-z, 0-9, and hyphen",
      );
    }
    if (/^..--/.test(label)) {
      throw new QnsNameError(
        `reserved double-hyphen pattern in label "${label}"`,
      );
    }
  }
  return labels.join(".");
}
