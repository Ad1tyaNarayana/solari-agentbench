# Methodology

This submission implements a deterministic, five-node executable model of the Raft consensus protocol described by Ongaro and Ousterhout. It uses logical ticks instead of wall-clock time and a seeded pseudorandom election choice, so identical inputs produce byte-identical summaries and traces. Each trace event records the complete local log, its SHA-256 digest, term, role, commit index, and operation-specific evidence.

The five pinned scenarios exercise stable election and replication, leader failure and re-election, minority isolation, majority-side recovery, and repair of a divergent uncommitted suffix. Client entries commit only when visible to at least three active, connected nodes. Applied commands are emitted only after commit-index advancement. When a partition heals, the current leader's log replaces conflicting follower suffixes and a repair event records the change.

The submission writes machine-readable `summary.json` and `trace.jsonl` files plus a static HTML trace viewer. The benchmark verifier does not trust the summary's PASS claims: it independently parses the trace, derives election safety, log matching, leader completeness, state-machine safety, and quorum behavior, and checks pinned terminal expectations. It also executes every scenario twice and compares output bytes to catch hidden wall-clock or nondeterministic behavior.
