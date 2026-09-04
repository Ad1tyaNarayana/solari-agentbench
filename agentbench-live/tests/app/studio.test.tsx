import { fireEvent, render, screen } from "@testing-library/react";
import { StudioShell } from "@/components/studio/studio-shell";
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
