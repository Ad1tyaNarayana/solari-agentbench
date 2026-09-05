import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: stableRefresh, push: vi.fn() }), usePathname: () => "/", notFound: () => { throw new Error("not_found"); } }));
const stableRefresh = vi.hoisted(() => vi.fn());
