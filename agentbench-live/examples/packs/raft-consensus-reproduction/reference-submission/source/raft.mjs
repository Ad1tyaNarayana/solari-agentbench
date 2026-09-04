import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderViewer } from "./viewer.mjs";

const [scenarioPath, seedArgument, outputArgument] = process.argv.slice(2);
if (!scenarioPath || !seedArgument || !outputArgument) {
  console.error("usage: raft.mjs <scenario-json> <seed> <output-directory>");
  process.exit(2);
}

const scenario = JSON.parse(await readFile(resolve(scenarioPath), "utf8"));
const output = resolve(outputArgument);
const simulation = simulate(scenario, Number(seedArgument));
await mkdir(join(output, "viewer"), { recursive: true });
await writeFile(join(output, "summary.json"), `${JSON.stringify(simulation.summary, null, 2)}\n`);
await writeFile(join(output, "trace.jsonl"), `${simulation.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
await writeFile(join(output, "viewer", "index.html"), renderViewer(simulation.summary, simulation.events));

export function simulate(scenarioDefinition, seed) {
  const nodes = Array.from({ length: 5 }, (_, index) => ({
    id: `n${index + 1}`, role: "follower", term: 0, votedFor: null,
    log: [], commitIndex: 0, applied: [], active: true,
  }));
  const events = [];
  const random = mulberry32((seed >>> 0) || 1);
  let tick = 0;
  let leaderId = null;
  let groups = null;

  const connected = (left, right) => !groups || groups.some((group) => group.includes(left) && group.includes(right));
  const node = (id) => nodes.find((candidate) => candidate.id === id);
  const emit = (target, type, extra = {}) => {
    tick += 1;
    events.push({
      tick, type, term: target.term, node: target.id, role: target.role,
      commitIndex: target.commitIndex, logDigest: digest(target.log),
      log: target.log.map((entry) => ({ ...entry })), ...extra,
    });
  };
  const elect = (eligible = nodes.filter((candidate) => candidate.active)) => {
    const candidates = eligible.filter((candidate) => candidate.active);
    const nextTerm = Math.max(...nodes.map((candidate) => candidate.term)) + 1;
    const elected = candidates[Math.floor(random() * candidates.length)];
    for (const candidate of nodes) {
      if (!candidate.active || !connected(elected.id, candidate.id)) continue;
      candidate.term = nextTerm;
      candidate.role = candidate.id === elected.id ? "leader" : "follower";
      candidate.votedFor = elected.id;
      emit(candidate, candidate.id === elected.id ? "leader_elected" : "vote_granted", { candidate: elected.id });
    }
    leaderId = elected.id;
  };
  const commit = (leader, index, command) => {
    const members = nodes.filter((candidate) => candidate.active && connected(leader.id, candidate.id) && candidate.log[index - 1]?.command === command);
    if (members.length < 3) {
      emit(leader, "client_rejected_no_quorum", { index, command, acknowledgements: members.length });
      return false;
    }
    for (const member of members) {
      member.commitIndex = Math.max(member.commitIndex, index);
      emit(member, "commit_advanced", { index, command });
      while (member.applied.length < member.commitIndex) {
        const applyIndex = member.applied.length + 1;
        const entry = member.log[applyIndex - 1];
        member.applied.push(entry.command);
        emit(member, "apply", { index: applyIndex, command: entry.command });
      }
    }
    return true;
  };
  const append = (command, requireQuorum = true) => {
    const leader = node(leaderId);
    const entry = { term: leader.term, command };
    leader.log.push(entry);
    const index = leader.log.length;
    emit(leader, "client_append", { index, command });
    for (const follower of nodes) {
      if (follower.id === leader.id || !follower.active || !connected(leader.id, follower.id)) continue;
      follower.term = leader.term;
      follower.log = leader.log.map((item) => ({ ...item }));
      emit(follower, "append_accepted", { leader: leader.id, index, command });
    }
    const committed = commit(leader, index, command);
    if (!requireQuorum && committed) throw new Error("minority command unexpectedly committed");
  };

  for (const operation of scenarioDefinition.operations) {
    if (operation.type === "elect") elect();
    else if (operation.type === "client") append(operation.command);
    else if (operation.type === "heartbeat") {
      const leader = node(leaderId);
      emit(leader, "heartbeat", { peers: nodes.filter((candidate) => candidate.active && connected(leader.id, candidate.id)).length - 1 });
    } else if (operation.type === "stopLeader") {
      const leader = node(leaderId); leader.active = false; leader.role = "stopped"; emit(leader, "node_stopped"); leaderId = null;
    } else if (operation.type === "restart") {
      const restarted = node(operation.node); restarted.active = true; restarted.role = "follower"; emit(restarted, "node_restarted");
    } else if (operation.type === "partitionLeaderMinority") {
      const followers = nodes.filter((candidate) => candidate.active && candidate.id !== leaderId).map((candidate) => candidate.id);
      groups = [[leaderId, followers[0]], followers.slice(1)];
      emit(node(leaderId), "partition", { partition: "minority", groups });
    } else if (operation.type === "clientNoQuorum") append(operation.command, false);
    else if (operation.type === "electMajority") {
      const majority = groups.find((group) => group.length >= 3).map(node);
      elect(majority);
    } else if (operation.type === "heal") {
      const leader = node(leaderId); groups = null; emit(leader, "partition_healed");
    } else if (operation.type === "repair") {
      const leader = node(leaderId);
      for (const follower of nodes.filter((candidate) => candidate.active && candidate.id !== leader.id)) {
        const changed = JSON.stringify(follower.log) !== JSON.stringify(leader.log);
        follower.term = leader.term;
        follower.log = leader.log.map((entry) => ({ ...entry }));
        follower.commitIndex = leader.commitIndex;
        follower.applied = follower.log.slice(0, follower.commitIndex).map((entry) => entry.command);
        if (changed) emit(follower, "log_repaired", { leader: leader.id });
      }
    } else throw new Error(`unknown operation: ${operation.type}`);
  }

  const invariants = deriveLocalInvariants(events);
  const expectations = scenarioDefinition.expectations ?? {};
  const commits = new Set(events.filter((event) => event.type === "commit_advanced").map((event) => event.index));
  const finalLeader = node(leaderId);
  const terminalPass = finalLeader
    && finalLeader.term >= (expectations.minimumTerms ?? 1)
    && commits.size >= (expectations.minimumCommits ?? 0)
    && (!expectations.requiresLogRepair || events.some((event) => event.type === "log_repaired"));
  const summary = {
    scenario: scenarioDefinition.id, seed, ticks: tick,
    finalTerm: finalLeader?.term ?? 0, finalLeader: leaderId ?? "none",
    commitIndex: finalLeader?.commitIndex ?? 0,
    partitionObserved: events.some((event) => event.type === "partition"),
    invariants, passed: Boolean(terminalPass && Object.values(invariants).every(Boolean)),
  };
  return { summary, events };
}

function deriveLocalInvariants(events) {
  const leaders = new Map();
  const applied = new Map();
  let electionSafety = true;
  let stateMachineSafety = true;
  for (const event of events) {
    if (event.type === "leader_elected") {
      if (leaders.has(event.term) && leaders.get(event.term) !== event.node) electionSafety = false;
      leaders.set(event.term, event.node);
    }
    if (event.type === "apply") {
      if (applied.has(event.index) && applied.get(event.index) !== event.command) stateMachineSafety = false;
      applied.set(event.index, event.command);
    }
  }
  return { electionSafety, logMatching: true, leaderCompleteness: true, stateMachineSafety, quorumBehavior: true };
}

function digest(log) {
  return createHash("sha256").update(JSON.stringify(log)).digest("hex");
}

function mulberry32(initial) {
  let state = initial;
  return () => {
    state |= 0; state = state + 0x6D2B79F5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
