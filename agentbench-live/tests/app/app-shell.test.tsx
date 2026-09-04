import { render, screen } from "@testing-library/react";
import { AppShell } from "@/components/app-shell";
vi.mock("next/navigation", () => ({ usePathname: () => "/studio" }));
test("provides persistent accessible navigation", () => { render(<AppShell><h1>Page</h1></AppShell>); expect(screen.getByRole("navigation", { name: /primary/i })).toBeInTheDocument(); for (const name of ["Benchmarks", "Studio", "Runs", "Providers"]) expect(screen.getByRole("link", { name })).toBeInTheDocument(); expect(screen.getByRole("link", { name: "Studio" })).toHaveAttribute("aria-current", "page"); });
