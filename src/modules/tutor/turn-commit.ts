/** True when this turn may commit history / speak (not barged-in or superseded). */
export function turnStillActive(
  signal: AbortSignal | undefined,
  turnId: number,
  liveTurnId: number | undefined,
): boolean {
  if (signal?.aborted) return false;
  if (turnId > 0 && liveTurnId !== undefined && liveTurnId !== turnId) return false;
  return true;
}
