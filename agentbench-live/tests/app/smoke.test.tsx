import { render, screen } from "@testing-library/react";
import Home from "@/app/page";

test("renders the AgentBench identity", () => {
  render(<Home />);
  expect(
    screen.getByRole("heading", { name: "AgentBench Live" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/evidence-first benchmark/i)).toBeInTheDocument();
});
