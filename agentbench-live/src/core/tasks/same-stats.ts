import type { TaskManifest } from "@/core/domain/task";
import type {
  SummaryStatistics,
  TargetCircle,
} from "@/core/verifiers/geometry";

export const sameStatsExpected: SummaryStatistics = {
  meanX: 54.27,
  meanY: 47.84,
  varianceX: 280.9,
  varianceY: 725.23,
  correlation: -0.07,
};

export const sameStatsTarget: TargetCircle = {
  centerX: 54.27,
  centerY: 47.84,
  radiusX: 16.76,
  radiusY: 26.93,
};

export const sameStatsSeedCsv = `x,y
76.44149070,45.34623833
69.94761143,71.20564790
54.27000000,83.37777783
38.59238857,74.73235947
32.09850930,50.33376167
38.59238857,24.47435210
54.27000000,12.30222217
69.94761143,20.94764053
`;

export const sameStatsTask: TaskManifest = {
  id: "same-stats-different-graph",
  version: "1.0.0",
  title: "Same Stats, Different Graph",
  prompt: `Reimplement the core simulated-annealing idea from “Same Stats,
Different Graphs”: transform a supplied seed dataset toward a circle while
preserving its selected summary statistics.

Provide source/reproduce.py with this exact CLI:
python3 reproduce.py --input <seed.csv> --output <directory> --target circle --seed 1729

The command must deterministically create <directory>/results.json,
<directory>/points.csv, and <directory>/comparison.png. Compute and report
sample means, sample variances (n - 1), and Pearson correlation. Document the
random seed, objective function, temperature schedule, and simulated-annealing
acceptance rule in methodology.md. Include requirements.txt even when the
implementation uses only the Python standard library.

Write the complete submission under submission/. The benchmark independently
re-executes the command and does not trust claimed findings in results.json.`,
  allowedPrimitives: ["sandbox", "browser"],
  requiredEvidence: ["sandbox"],
  budget: {
    totalMs: 180_000,
    browserMs: 60_000,
    sandboxMs: 120_000,
    desktopMs: 0,
  },
  verifier: "same-stats-different-graph",
};
