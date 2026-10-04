/**
 * Isolated non-idempotent effect ledger for the P2 harness.
 *
 * The endpoint records every attempted operation and every applied effect
 * without deduplicating, so a repeated effect is visible even when the caller
 * believes it succeeded. It is separate from the evaluated implementation.
 */

export type Effect = {
  effect: string;
  operationId: string;
  owner: string;
  at: number;
};

export class EffectLedger {
  private readonly entries: Effect[] = [];

  apply(effect: string, operationId: string, owner: string, at = Date.now()): void {
    this.entries.push({ effect, operationId, owner, at });
  }

  all(): readonly Effect[] {
    return [...this.entries];
  }

  count(effect: string): number {
    return this.entries.filter((entry) => entry.effect === effect).length;
  }

  /** Effects applied more than once for the same logical operation. */
  duplicates(): Effect[] {
    const seen = new Map<string, number>();
    for (const entry of this.entries) {
      const key = `${entry.operationId}:${entry.effect}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return this.entries.filter((entry) => (seen.get(`${entry.operationId}:${entry.effect}`) ?? 0) > 1);
  }
}
