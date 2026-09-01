import type { TaskManifest } from "@/core/domain/task";

export const urlShortenerTask: TaskManifest = {
  id: "url-shortener",
  version: "1.0.0",
  title: "URL Shortener",
  prompt: `Build a production-ready URL shortener web application.

Requirements:
- Accept a long URL through an input with the stable selector #long-url.
- Create a short URL when the button with selector #shorten is activated.
- Render the resulting link in an element with selector #short-url.
- Redirect a visited short URL to the exact original destination.
- Persist redirects for the lifetime of the server process.
- Include a dependency lockfile and make npm run build succeed.
- Start with: npm start -- --hostname 0.0.0.0 --port 3000.
- Do not call external URL-shortening services.

Write the complete submission under submission/ with source/, results.json,
methodology.md, provenance.json, and any declared artifacts. results.json is
required, but the benchmark will independently verify every claimed result.`,
  allowedPrimitives: ["browser", "sandbox", "desktop"],
  requiredEvidence: ["sandbox", "browser"],
  budget: {
    totalMs: 300_000,
    browserMs: 60_000,
    sandboxMs: 180_000,
    desktopMs: 60_000,
  },
  verifier: "url-shortener",
};
