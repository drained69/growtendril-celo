/** Compares deployed code with a compiled runtime, ignoring only Solidity's declared immutable slots. */
export function matchesRuntime(code: string, runtime: string, ranges: readonly { start: number; length: number }[]): boolean {
  const mask = (raw: string) => {
    const chars = raw.replace(/^0x/, "").toLowerCase().split("");
    for (const { start, length } of ranges) chars.fill("0", start * 2, (start + length) * 2);
    return chars.join("");
  };
  return /^0x[\da-f]+$/i.test(code) && mask(code) === mask(runtime);
}
