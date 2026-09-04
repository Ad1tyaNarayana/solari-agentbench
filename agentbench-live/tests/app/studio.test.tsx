import { fireEvent, render, screen } from "@testing-library/react";
import { StudioShell } from "@/components/studio/studio-shell";
import { initialDraft } from "@/components/studio/use-benchmark-draft";
test("renders the complete three-pane authoring frame", () => { render(<StudioShell />); expect(screen.getByRole("heading", { name: /benchmark studio/i, level: 1 })).toBeInTheDocument(); for (const step of ["Basics", "Tasks", "Environment", "Evaluators", "Agents", "Review"]) expect(screen.getByRole("button", { name: step })).toBeInTheDocument(); expect(screen.getByRole("region", { name: /generated files/i })).toBeInTheDocument(); expect(screen.getByRole("status")).toHaveTextContent(/unsaved|checking|valid/i); });

test("supports evaluator lifecycle controls and adding agent presets", () => {
  render(<StudioShell />);
  fireEvent.click(screen.getByRole("button", { name: "Evaluators" }));
  expect(screen.getByRole("checkbox", { name: /enable results-exist/i })).toBeChecked();
  expect(screen.getByRole("button", { name: /move results-exist up/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /remove results-exist/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  fireEvent.click(screen.getByRole("button", { name: /add agent/i }));
  expect(screen.getAllByLabelText("Agent ID")).toHaveLength(2);
});

test("shows deterministic and model-judge weights separately", () => {
  render(<StudioShell />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));

  expect(screen.getByText("Deterministic weight").parentElement).toHaveTextContent("100 points");
  expect(screen.getByText("Model-judge weight").parentElement).toHaveTextContent("0 points");
});

test("requires an explicit warning-bearing opt-in for a model-judge majority", () => {
  const majorityJudgeDraft = structuredClone(initialDraft);
  majorityJudgeDraft.tasks[0].evaluationPolicy = {
    maxModelJudgeWeight: 100,
    allowModelJudgeMajority: false,
  };
  majorityJudgeDraft.tasks[0].evaluators = [{
    id: "subjective-judge",
    type: "model-judge",
    weight: 100,
    enabled: true,
    prerequisites: [],
    config: {
      provider: "codex",
      rubric: "rubric.md",
      rubricText: "Judge correctness.",
      inputs: ["results.json"],
      sampling: {},
    },
  }];

  render(<StudioShell initialDraft={majorityJudgeDraft} />);
  fireEvent.click(screen.getByRole("button", { name: "Evaluators" }));

  expect(screen.getByRole("alert")).toHaveTextContent(/subjective.*majority/i);
  expect(screen.getByRole("checkbox", { name: /allow model-judge majority/i })).not.toBeChecked();
});
