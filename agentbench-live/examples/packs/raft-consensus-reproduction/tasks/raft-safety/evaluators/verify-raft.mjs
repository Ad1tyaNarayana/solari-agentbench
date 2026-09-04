import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const scenarioNames = ["stable-election", "leader-failover", "minority-isolation", "majority-recovery", "divergent-log-repair"];

export function deriveInvariants(events, scenario) {
  const leaders = new Map();
  const applied = new Map();
  const snapshots = events.filter((event) => Array.isArray(event.log));
  const committed = new Map();
  let electionSafety = true;
  let stateMachineSafety = true;
  let logMatching = true;
  let leaderCompleteness = true;

  for (const event of events) {
    if (event.type === "leader_elected") {
      const previous = leaders.get(event.term);
      if (previous && previous !== event.node) electionSafety = false;
      leaders.set(event.term, event.node);
    }
    if (event.type === "apply") {
      const previous = applied.get(event.index);
      if (previous !== undefined && previous !== event.command) stateMachineSafety = false;
      applied.set(event.index, event.command);
    }
    if (event.type === "commit_advanced" && !committed.has(event.index)) {
      committed.set(event.index, { command: event.command, term: event.log[event.index - 1]?.term ?? event.term, committedTerm: event.term });
    }
  }

  for (let leftIndex = 0; leftIndex < snapshots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < snapshots.length; rightIndex += 1) {
      const left = snapshots[leftIndex].log;
      const right = snapshots[rightIndex].log;
      const commonLength = Math.min(left.length, right.length);
      for (let index = 0; index < commonLength; index += 1) {
        if (left[index].term !== right[index].term) continue;
        if (JSON.stringify(left.slice(0, index + 1)) !== JSON.stringify(right.slice(0, index + 1))) logMatching = false;
      }
    }
  }

  for (const event of events.filter((item) => item.type === "leader_elected")) {
    for (const [index, entry] of committed) {
      if (event.term <= entry.committedTerm) continue;
      const leaderEntry = event.log[index - 1];
      if (!leaderEntry || leaderEntry.command !== entry.command || leaderEntry.term !== entry.term) leaderCompleteness = false;
    }
  }

  const expectations = scenario.expectations ?? {};
  const committedCommands = new Set(events.filter((event) => event.type === "commit_advanced").map((event) => event.command));
  const rejectedCommands = new Set(events.filter((event) => event.type === "client_rejected_no_quorum").map((event) => event.command));
  let quorumBehavior = true;
  if (expectations.minorityCannotCommitCommand) {
    quorumBehavior = rejectedCommands.has(expectations.minorityCannotCommitCommand)
      && !committedCommands.has(expectations.minorityCannotCommitCommand);
  }
  if (expectations.recoveryCommitsCommand) quorumBehavior = quorumBehavior && committedCommands.has(expectations.recoveryCommitsCommand);
  return { electionSafety, logMatching, leaderCompleteness, stateMachineSafety, quorumBehavior };
}

function runSubmission(submissionRoot, scenarioPath, seed, output) {
  mkdirSync(output, { recursive: true });
  const runPath = join(submissionRoot, "run");
  let command;
  let args;
  if (process.platform === "win32" && existsSync(join(submissionRoot, "source", "raft.mjs"))) {
    command = process.execPath;
    args = [join(submissionRoot, "source", "raft.mjs"), scenarioPath, String(seed), output];
  } else {
    try { chmodSync(runPath, 0o755); } catch {}
    command = "sh";
    args = [runPath, scenarioPath, String(seed), output];
  }
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`submission exited ${result.status}: ${result.stderr || result.stdout}`);
}

function readRun(output) {
  const summaryBytes = readFileSync(join(output, "summary.json"));
  const traceBytes = readFileSync(join(output, "trace.jsonl"));
  const summary = JSON.parse(summaryBytes.toString("utf8"));
  const events = traceBytes.toString("utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { summaryBytes, traceBytes, summary, events };
}

function terminalCheck(summary, events, scenario) {
  const expectations = scenario.expectations ?? {};
  const terms = new Set(events.filter((event) => event.type === "leader_elected").map((event) => event.term));
  const commits = new Set(events.filter((event) => event.type === "commit_advanced").map((event) => event.index));
  return summary.scenario === scenario.id
    && summary.ticks <= scenario.maxTicks
    && events.every((event) => Number.isInteger(event.tick) && event.tick <= scenario.maxTicks)
    && summary.finalTerm >= (expectations.minimumTerms ?? 1)
    && commits.size >= (expectations.minimumCommits ?? 0)
    && (!expectations.requiresLogRepair || events.some((event) => event.type === "log_repaired"))
    && terms.size >= (expectations.minimumTerms ?? 1);
}

function aggregateViewer(records) {
  const serialized = JSON.stringify(records).replaceAll("<", "\\u003c");
  const buttons = records.map((record) => `<button data-testid="scenario-${record.id}" data-scenario="${record.id}">${record.id}</button>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Raft fault trace</title><style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;background:#0d1117;color:#e6edf3}button{margin:.25rem;padding:.5rem;border:1px solid #8b949e;border-radius:.35rem;background:#21262d;color:inherit}.pass{color:#3fb950}dl{display:grid;grid-template-columns:10rem 1fr}dt,dd{padding:.3rem}</style></head><body><h1 data-testid="title">Raft fault trace</h1><nav>${buttons}</nav><dl><dt>Scenario</dt><dd data-testid="scenario"></dd><dt>Term</dt><dd data-testid="term"></dd><dt>Leader</dt><dd data-testid="leader"></dd><dt>Partition</dt><dd data-testid="partition"></dd><dt>Commit index</dt><dd data-testid="commit-index"></dd></dl><ul><li data-testid="invariant-election-safety"></li><li data-testid="invariant-log-matching"></li><li data-testid="invariant-leader-completeness"></li><li data-testid="invariant-state-machine-safety"></li><li data-testid="invariant-quorum-behavior"></li></ul><script>const records=${serialized};const names={electionSafety:'election-safety',logMatching:'log-matching',leaderCompleteness:'leader-completeness',stateMachineSafety:'state-machine-safety',quorumBehavior:'quorum-behavior'};function show(id){const r=records.find(x=>x.id===id);document.querySelector('[data-testid="scenario"]').textContent=r.id;document.querySelector('[data-testid="term"]').textContent=String(r.summary.finalTerm);document.querySelector('[data-testid="leader"]').textContent=r.summary.finalLeader;document.querySelector('[data-testid="partition"]').textContent=r.summary.partitionObserved?'minority partition observed':'no partition';document.querySelector('[data-testid="commit-index"]').textContent=String(r.summary.commitIndex);for(const [key,name] of Object.entries(names)){const el=document.querySelector('[data-testid="invariant-'+name+'"]');el.textContent=key+': '+(r.invariants[key]?'PASS':'FAIL');el.className=r.invariants[key]?'pass':''}}document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>show(b.dataset.scenario)));show(records[0].id);</script></body></html>`;
}

async function main() {
  const submissionRoot = resolve(process.env.AGENTBENCH_SUBMISSION_ROOT ?? "/submission");
  const taskRoot = resolve(process.env.AGENTBENCH_RAFT_TASK_ROOT ?? "/benchmark/tasks/raft-safety");
  const resultRoot = resolve(process.env.AGENTBENCH_RESULT_ROOT ?? "/result");
  const resultFile = resolve(process.env.AGENTBENCH_RESULT ?? join(resultRoot, "evaluator-result.json"));
  mkdirSync(resultRoot, { recursive: true });
  const assertions = [];
  const records = [];

  for (const name of scenarioNames) {
    const scenarioPath = join(taskRoot, "fixtures", `${name}.json`);
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
    const firstRoot = join(resultRoot, "runs", name, "first");
    const secondRoot = join(resultRoot, "runs", name, "second");
    runSubmission(submissionRoot, scenarioPath, scenario.seed, firstRoot);
    runSubmission(submissionRoot, scenarioPath, scenario.seed, secondRoot);
    const first = readRun(firstRoot);
    const second = readRun(secondRoot);
    const deterministic = first.summaryBytes.equals(second.summaryBytes) && first.traceBytes.equals(second.traceBytes);
    const invariants = deriveInvariants(first.events, scenario);
    const terminal = terminalCheck(first.summary, first.events, scenario);
    const claimed = first.summary.passed === true && Object.entries(invariants).every(([key, value]) => first.summary.invariants?.[key] === value);
    assertions.push({ id: `${name}.determinism`, passed: deterministic, summary: `${name} output is byte deterministic`, expected: true, observed: deterministic });
    assertions.push({ id: `${name}.terminal`, passed: terminal, summary: `${name} meets pinned terminal expectations`, expected: true, observed: terminal });
    assertions.push({ id: `${name}.claims`, passed: claimed, summary: `${name} summary agrees with trace-derived results`, expected: true, observed: claimed });
    for (const [key, passed] of Object.entries(invariants)) assertions.push({ id: `${name}.${key}`, passed, summary: `${name}: ${key}`, expected: true, observed: passed });
    records.push({ id: name, summary: first.summary, invariants });
  }

  const outputViewer = join(resultRoot, "viewer");
  mkdirSync(outputViewer, { recursive: true });
  writeFileSync(join(outputViewer, "index.html"), aggregateViewer(records));
  const selected = records.find((record) => record.id === "leader-failover");
  const allPassed = assertions.every((assertion) => assertion.passed);
  const outputs = {
    electionSafety: all(records.map((record) => record.invariants.electionSafety)),
    logMatching: all(records.map((record) => record.invariants.logMatching)),
    leaderCompleteness: all(records.map((record) => record.invariants.leaderCompleteness)),
    stateMachineSafety: all(records.map((record) => record.invariants.stateMachineSafety)),
    quorumBehavior: all(records.map((record) => record.invariants.quorumBehavior)),
    expectedTerm: String(selected.summary.finalTerm), expectedLeader: selected.summary.finalLeader,
  };
  writeFileSync(resultFile, `${JSON.stringify({ assertions, outputs }, null, 2)}\n`);
  if (!allPassed) process.exitCode = 1;
}

function all(values) { return values.every(Boolean) ? "PASS" : "FAIL"; }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
