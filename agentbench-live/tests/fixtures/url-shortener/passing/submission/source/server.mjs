import http from "node:http";
import { randomBytes } from "node:crypto";

const redirects = new Map();
const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 3000;
const hostIndex = process.argv.indexOf("--hostname");
const hostname = hostIndex >= 0 ? process.argv[hostIndex + 1] : "0.0.0.0";

const html = `<!doctype html><html><body>
  <label for="long-url">Long URL</label>
  <input id="long-url" type="url">
  <button id="shorten">Shorten</button>
  <a id="short-url"></a>
  <script>
    document.querySelector('#shorten').addEventListener('click', async () => {
      const url = document.querySelector('#long-url').value;
      const response = await fetch('/api/shorten', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({url})
      });
      const result = await response.json();
      const link = document.querySelector('#short-url');
      link.href = result.shortUrl;
      link.textContent = result.shortUrl;
    });
  </script>
</body></html>`;

http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
    return;
  }
  if (request.method === "POST" && request.url === "/api/shorten") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { url } = JSON.parse(body);
      const slug = randomBytes(4).toString("hex");
      redirects.set(slug, url);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ shortUrl: `/${slug}` }));
    });
    return;
  }
  const slug = request.url?.slice(1);
  if (slug && redirects.has(slug)) {
    response.writeHead(302, { location: redirects.get(slug) });
    response.end();
    return;
  }
  response.writeHead(404);
  response.end("not found");
}).listen(port, hostname);
