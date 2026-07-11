// Step 1 placeholder — keeps the compose stack green until the Express
// skeleton lands in Step 2, which replaces this file entirely.
const http = require('node:http');

const port = Number(process.env.PORT) || 3005;

const server = http.createServer((req, res) => {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'app skeleton lands in Step 2' }));
});

server.listen(port, () => {
  console.log(`[placeholder] listening on :${port}`);
});
