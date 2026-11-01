/** Parse a non-negative integer environment variable, failing loudly on garbage. */
export function intFrom(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}
