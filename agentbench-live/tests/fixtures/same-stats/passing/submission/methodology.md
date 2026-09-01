# Seed

The run uses the fixed random seed 1729.

# Objective function

Candidate moves reduce the target-circle distance while penalizing summary-statistic drift.

# Temperature schedule

The simulated-annealing temperature decays geometrically after each proposal.

# Acceptance rule

Improving moves are accepted; worse moves are accepted with probability exp(-delta / temperature).
