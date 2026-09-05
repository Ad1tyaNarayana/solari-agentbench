/** Quality stays unchanged. Only explicitly opted-in runs receive an efficiency score. */
export function timeAdjustedScore(quality: number | null | undefined, elapsedMs: number, targetMs?: number): number | undefined {
  if (quality == null || !Number.isFinite(quality) || targetMs === undefined || !Number.isFinite(targetMs) || targetMs <= 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
  return Math.round(quality * Math.min(1, targetMs / Math.max(1, elapsedMs)) * 100) / 100;
}
