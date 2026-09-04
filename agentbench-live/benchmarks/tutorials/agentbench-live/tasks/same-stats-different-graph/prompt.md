Reimplement the core simulated-annealing idea from “Same Stats,
Different Graphs”: transform a supplied seed dataset toward a circle while
preserving its selected summary statistics.

Provide submission/source/reproduce.py with this exact CLI (run from
submission/source):
python3 reproduce.py --input <seed.csv> --output <directory> --target circle --seed 1729

The command must deterministically create <directory>/results.json,
<directory>/points.csv, and <directory>/comparison.png. Compute and report
sample means, sample variances (n - 1), and Pearson correlation. Document the
random seed, objective function, temperature schedule, and simulated-annealing
acceptance rule in submission/methodology.md. Use these exact Markdown headings
so every required section is machine-verifiable: # Seed, # Objective Function,
# Temperature Schedule, and # Acceptance Rule. Include
submission/source/requirements.txt even when the implementation uses only the
Python standard library. Also write the benchmark-facing summaries to
submission/results.json and submission/provenance.json.

Write the complete submission under submission/. The benchmark independently
re-executes the command and does not trust claimed findings in results.json.