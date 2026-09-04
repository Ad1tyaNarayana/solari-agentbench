import { render, screen } from "@testing-library/react";
import Home from "@/app/page";

test("renders the AgentBench identity", () => {
  render(<Home />);
  expect(
    screen.getByRole("heading", { name: "AgentBench Live" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/evidence-first benchmark/i)).toBeInTheDocument();
  expect(screen.getByText(/choose which agent configuration can be trusted with a real workflow/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /100.*passed/i })).toHaveAttribute(
    "href",
    "/runs/demo-sol-url",
  );
});
