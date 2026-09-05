Build a production-ready URL shortener web application.

Requirements:
- Accept a long URL through an input with the stable selector #long-url.
- Create a short URL when the button with selector #shorten is activated.
- Render the resulting link in an element with selector #short-url.
- Redirect a visited short URL to the exact original destination.
- Persist redirects for the lifetime of the server process.
- Include a dependency lockfile and make npm run build succeed.
- Start with: npm start -- --hostname 0.0.0.0 --port 3000.
- Do not call external URL-shortening services.

Write the complete submission using this layout:

submission/
  source/
    package.json
    package-lock.json
    (all application source files)
  results.json
  methodology.md
  provenance.json

The application root is submission/source/, not submission/. The evaluator
runs npm install, npm run build, and npm start from that application root.
Do not put package.json or its lockfile at the top of submission/.
Leave only reproducible source and metadata in the final submission: run
builds in a separate scratch copy so dist/, node_modules/, and other generated
caches are not included. results.json is required, but the benchmark will
independently verify every claimed result.
