export type Point = { x: number; y: number };

export type SummaryStatistics = {
  meanX: number;
  meanY: number;
  varianceX: number;
  varianceY: number;
  correlation: number;
};

export type TargetCircle = {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
};

export function summaryStats(points: Point[]): SummaryStatistics {
  if (points.length < 2) {
    throw new Error("At least two points are required");
  }
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.length - 1;
  const varianceX =
    points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0) /
    denominator;
  const varianceY =
    points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0) /
    denominator;
  const covariance =
    points.reduce(
      (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
      0,
    ) / denominator;
  const scale = Math.sqrt(varianceX * varianceY);
  return {
    meanX,
    meanY,
    varianceX,
    varianceY,
    correlation: scale === 0 ? 0 : covariance / scale,
  };
}

export function withinStatsTolerance(
  observed: SummaryStatistics,
  expected: SummaryStatistics,
  tolerance: number,
): boolean {
  return (Object.keys(expected) as Array<keyof SummaryStatistics>).every(
    (key) => Math.abs(observed[key] - expected[key]) <= tolerance,
  );
}

export function circleError(points: Point[], target: TargetCircle): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  const squaredError = points.reduce((sum, point) => {
    const radialDistance = Math.hypot(
      (point.x - target.centerX) / target.radiusX,
      (point.y - target.centerY) / target.radiusY,
    );
    return sum + Math.abs(radialDistance - 1) ** 2;
  }, 0);
  return Math.sqrt(squaredError / points.length);
}
