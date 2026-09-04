# Reproduce Raft safety under controlled faults

Build a dependency-light, deterministic five-node simulator for the Raft consensus algorithm described by Diego Ongaro and John Ousterhout in “In Search of an Understandable Consensus Algorithm (Extended Version),” USENIX ATC 2014.

Your `submission/run` entry point must accept exactly three arguments: a scenario JSON path, an integer seed, and an output directory. It must run without network access and emit `summary.json`, `trace.jsonl`, and `viewer/index.html` beneath that directory. Use a logical clock and seeded pseudo-randomness; canonical files must contain no wall-clock timestamps, random UUIDs, machine paths, or network-derived values.

Implement five nodes, randomized leader election, one vote per term, heartbeats, replicated logs, majority commit, stopped/restarted nodes, bidirectional partitions, and divergent-follower log repair. Persistence across operating-system process restarts, membership changes, snapshots, and log compaction are out of scope.

Every JSONL trace event must include `tick`, `type`, `term`, `node`, `role`, `commitIndex`, `logDigest`, and the node’s ordered log entries. Message and transition events must also include the relevant peer, entry, index, command, or partition fields. The HTML viewer must work with no remote assets and expose stable `data-testid` elements for scenario, current term, leader, partition state, commit index, and the five invariant results.

`results.json` declares the implementation contract. `methodology.md` must identify the implemented subset and map election safety, log matching, leader completeness, state-machine safety, and quorum recovery to the corresponding paper sections. `provenance.json` records the paper URL, implementation language/runtime, and deterministic seed policy.

The evaluator will run every pinned scenario twice, compare canonical bytes, and independently derive all claims from your traces. It will then inspect a normalized trace report in a recorded Solari browser. Do not hard-code a passing summary: unsupported claims fail even when `summary.json` says they pass.
