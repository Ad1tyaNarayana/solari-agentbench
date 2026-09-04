"use client";
import { useReducer } from "react";
import type { BenchmarkDraft } from "@/core/authoring/types";
import { DEFAULT_EVALUATION_POLICY } from "@/core/benchmarks/types";

export const initialDraft: BenchmarkDraft = { schemaVersion: 1, id: "my-benchmark", name: "My Benchmark", version: "1.0.0", description: "", defaults: { timeoutSeconds: 300, maxConcurrency: 1, submissionDirectory: "submission" }, tasks: [{ id: "first-task", name: "First task", prompt: "Describe what the agent should build or investigate.", fixtures: [], allowedPrimitives: ["sandbox"], planningRequired: true, resourceLimits: { browserSessions: 0, sandboxes: 1, desktops: 0, totalMinutes: 5 }, submission: { directory: "submission", required: ["results.json"] }, evaluationPolicy: { ...DEFAULT_EVALUATION_POLICY }, evaluators: [{ id: "results-exist", type: "file", weight: 100, enabled: true, prerequisites: [], config: { subject: "results.json", assertion: "present" } }] }], agents: [{ id: "codex", name: "Codex", provider: "codex", model: "gpt-5.6-sol", harness: { id: "agentbench-basic-loop", version: "1" }, options: {} }] };
type State = { draft: BenchmarkDraft; dirty: boolean; revision?: Record<string, string>; snapshotDigest?: string };
type Action = { type: "replace"; draft: BenchmarkDraft; revision?: Record<string, string>; snapshotDigest?: string } | { type: "edit"; draft: BenchmarkDraft };
function reducer(state: State, action: Action): State { return action.type === "replace" ? { draft: action.draft, revision: action.revision, snapshotDigest: action.snapshotDigest, dirty: false } : { ...state, draft: action.draft, dirty: true }; }
export function useBenchmarkDraft() { return useReducer(reducer, { draft: initialDraft, dirty: true }); }
