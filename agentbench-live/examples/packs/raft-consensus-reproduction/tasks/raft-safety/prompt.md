# Reproduce Raft safety under controlled faults

Build a dependency-light, deterministic five-node simulator for the Raft consensus algorithm described by Diego Ongaro and John Ousterhout in “In Search of an Understandable Consensus Algorithm (Extended Version),” USENIX ATC 2014.

Your `submission/run` entry point must accept exactly three arguments: a scenario JSON path, an integer seed, and an output directory. It must run without network access and emit `summary.json`, `trace.jsonl`, and `viewer/index.html` beneath that directory. Use a logical clock and seeded pseudo-randomness; canonical files must contain no wall-clock timestamps, random UUIDs, machine paths, or network-derived values.

Implement five nodes, randomized leader election, one vote per term, heartbeats, replicated logs, majority commit, stopped/restarted nodes, bidirectional partitions, and divergent-follower log repair. Persistence across operating-system process restarts, membership changes, snapshots, and log compaction are out of scope.

Every JSONL trace event must include `tick`, `type`, `term`, `node`, `role`, `commitIndex`, `logDigest`, and the node’s ordered log entries. Message and transition events must also include the relevant peer, entry, index, command, or partition fields. The HTML viewer must work with no remote assets and expose stable `data-testid` elements for scenario, current term, leader, partition state, commit index, and the five invariant results.

`results.json` declares the implementation contract. `methodology.md` must identify the implemented subset and map election safety, log matching, leader completeness, state-machine safety, and quorum recovery to the corresponding paper sections. `provenance.json` records the paper URL, implementation language/runtime, and deterministic seed policy.

The evaluator will run every pinned scenario twice, compare canonical bytes, and independently derive all claims from your traces. It will then inspect a normalized trace report in a recorded Solari browser. Do not hard-code a passing summary: unsupported claims fail even when `summary.json` says they pass.

## Exact submission contract

Create `submission/results.json` with exactly these fields (no additional keys).
This is metadata, not your simulation output or a self-assigned score:

<!-- results-contract -->
```json
{
  "paper": "https://www.usenix.org/system/files/conference/atc14/atc14-paper-ongaro.pdf",
  "protocol": "raft",
  "nodeCount": 5,
  "deterministic": true,
  "artifacts": ["summary.json", "trace.jsonl", "viewer/index.html"]
}
```

The runner invokes `sh /submission/run <scenario-json> <seed> <output-directory>`
on Linux. Use an LF-terminated shell entry point that resolves its source relative
to itself. Do not assume a particular current directory. Keep dependencies minimal
and write all generated files only under the supplied output directory.

## Scenario input protocol

Read the supplied scenario file at runtime; do not branch on known scenario IDs
or substitute precomputed traces. Its fields are `id`, `seed`, `maxTicks`,
`operations` and `expectations`. Use the CLI seed argument for randomness.
Nodes are named `n1` through `n5`. Execute operations in their listed order:

- `elect`: run an election among active reachable nodes.
- `client`: submit the operation's `command` to the current leader.
- `heartbeat`: send a leader heartbeat.
- `stopLeader`: stop the current leader, retaining its in-memory persistent state.
- `restart`: restart the named `node` with that state.
- `partitionLeaderMinority`: isolate the current leader with one active follower;
  the other three nodes form the majority side. Communication is bidirectional
  within each group and blocked between groups.
- `clientNoQuorum`: submit `command` to the isolated leader; it must not commit.
- `electMajority`: elect a leader within the three-node majority partition.
- `heal`: restore communication between groups.
- `repair`: reconcile active follower logs with the current leader through Raft
  consistency checking, truncating conflicting uncommitted suffixes.

Expectations may specify `minimumTerms`, `minimumCommits`,
`minorityCannotCommitCommand`, `recoveryCommitsCommand` and `requiresLogRepair`.
They constrain the outcome; they are not permission to fabricate it. Logical ticks
must stay within `maxTicks`; these fixtures describe a compact, event-driven
simulation, not real-time sleeping or thousands of idle heartbeat ticks.

## Trace output protocol

`trace.jsonl` is one JSON event per line, in deterministic execution order.
Every event carries integer `tick` and `term`, string `type`, `node`, `role`,
integer `commitIndex`, string `logDigest`, and a full ordered `log` array.
Each log entry has integer `term` and string `command`; log indices are one-based
while JSON array offsets are zero-based. Hash canonical serialized log contents
for `logDigest`. Emit honest node snapshots at each transition, not just a final
aggregate. Use these exact event names where applicable:

- `leader_elected`: emitted when a node becomes leader; include its complete log.
- `commit_advanced`: include `index` and `command`, with that entry in `log`.
- `apply`: include the applied `index` and `command`.
- `client_rejected_no_quorum`: include the uncommitted `command` and `index`.
- `log_repaired`: emitted after a conflicting follower log is reconciled.
- `partition`: include `partition: "minority"` and the node-ID `groups`.
- `partition_healed`, `node_stopped`, `node_restarted`, `heartbeat`,
  `vote_granted`, `client_append` and `append_accepted` describe other transitions.
  Include relevant peers/indices/commands. Additional truthful events are allowed.

The independent verifier derives election safety from leaders per term, log
matching from overlapping log prefixes, leader completeness from prior commits
in later leaders' logs, state-machine safety from applied commands per index,
and quorum behavior from rejected/committed commands. Omitting these events
prevents meaningful verification and will not satisfy terminal expectations.

## Summary and viewer output

`summary.json` must include `scenario` equal to the input ID, integer `seed`,
integer `ticks`, integer `finalTerm`, string `finalLeader`, integer `commitIndex`,
boolean `partitionObserved`, boolean `passed`, and an `invariants` object.
The invariant keys are `electionSafety`, `logMatching`, `leaderCompleteness`,
`stateMachineSafety`, and `quorumBehavior`, each boolean. Derive them from your
execution; the evaluator compares your claims with its own trace checks. A
successful summary alone earns no reproduction pass.

`viewer/index.html` must be self-contained with no remote assets. Expose
`data-testid` values `scenario`, `term`, `leader`, `partition`, `commit-index`,
`invariant-election-safety`, `invariant-log-matching`,
`invariant-leader-completeness`, `invariant-state-machine-safety`, and
`invariant-quorum-behavior`. The verifier separately builds the normalized
multi-scenario viewer used for scored browser checks.

Before optional UI polish, check the exact results metadata and required files.
Leave time for independent evaluation. You are implementing the simulator;
do not copy a reference submission or modify the benchmark verifier.
