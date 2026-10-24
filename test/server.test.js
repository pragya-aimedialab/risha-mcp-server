import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const users = { "rsh_at_alice": { id: 1, email: "alice@example.com" }, "rsh_at_alice_2": { id: 1, email: "alice@example.com" }, "rsh_at_bob": { id: 2, email: "bob@example.com" } };

let mockApi;
let mockBase;
let mcp;
let mcpBase;

// Minimal stand-in for the Risha API: auth/me, credits and capabilities.
function startMockApi() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const user = users[(req.headers.authorization || "").replace(/^Bearer /, "")];
      if (!user) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ detail: "Invalid token" }));
      }
      const path = new URL(req.url, "http://x").pathname;
      const bodies = {
        "/api/auth/me/": user,
        "/api/credits/wallets/my-summary/": { balance: 42 },
        "/api/credits/wallets/my-wallet/": { balance: 42 },
        "/api/customer/capabilities/": { results: [{ id: 21, name: "Image" }], next: null }
      };
      res.writeHead(bodies[path] ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(bodies[path] ?? { detail: "Not found" }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function spawnServer(env) {
  return spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH, RISHA_API_BASE_URL: `${mockBase}/api`, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function waitForOutput(stream, pattern) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; got: ${buffer}`)), 10_000);
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = pattern.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    });
  });
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } }
};

function postMcp(body, headers = {}) {
  return fetch(`${mcpBase}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body)
  });
}

async function rpcResult(res) {
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

before(async () => {
  mockApi = await startMockApi();
  mockBase = `http://127.0.0.1:${mockApi.address().port}`;
  mcp = spawnServer({ MCP_TRANSPORT: "http", PORT: "0", MCP_PUBLIC_URL: "https://mcp.example.test/mcp" });
  const [, port] = await waitForOutput(mcp.stderr, /listening on port (\d+)/);
  mcpBase = `http://127.0.0.1:${port}`;
});

after(() => {
  mcp?.kill();
  mockApi?.close();
});

test("protected resource metadata is served at both well-known paths", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await fetch(`${mcpBase}${path}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      resource: "https://mcp.example.test/mcp",
      authorization_servers: [mockBase],
      scopes_supported: ["risha"],
      bearer_methods_supported: ["header"],
      resource_name: "Risha"
    });
  }
});

test("healthz returns 200", async () => {
  const res = await fetch(`${mcpBase}/healthz`);
  assert.equal(res.status, 200);
});

test("missing bearer token gets 401 with a resource_metadata challenge", async () => {
  const res = await postMcp(initializeBody);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"');
  assert.match(res.headers.get("access-control-expose-headers"), /WWW-Authenticate/);
});

test("token rejected by Risha gets 401 invalid_token", async () => {
  const res = await postMcp(initializeBody, { Authorization: "Bearer rsh_at_revoked" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /resource_metadata=".+", error="invalid_token"/);
});

test("valid token opens a session bound to its user", async () => {
  const init = await postMcp(initializeBody, { Authorization: "Bearer rsh_at_alice" });
  assert.equal(init.status, 200);
  const sessionId = init.headers.get("mcp-session-id");
  assert.ok(sessionId);
  assert.equal((await rpcResult(init)).result.serverInfo.name, "risha-mcp-server");

  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "risha_credit_balance", arguments: {} } };
  const refreshed = await postMcp(call, { Authorization: "Bearer rsh_at_alice_2", "mcp-session-id": sessionId });
  assert.equal(refreshed.status, 200);
  assert.equal(JSON.parse((await rpcResult(refreshed)).result.content[0].text).balance, 42);

  const otherUser = await postMcp(call, { Authorization: "Bearer rsh_at_bob", "mcp-session-id": sessionId });
  assert.equal(otherUser.status, 403);

  const unknown = await postMcp(call, { Authorization: "Bearer rsh_at_alice", "mcp-session-id": "nope" });
  assert.equal(unknown.status, 404);
});

test("stdio mode still starts and answers initialize", async () => {
  const child = spawnServer({ RISHA_API_TOKEN: "rsh_at_alice" });
  try {
    await waitForOutput(child.stderr, /loaded 1 capabilities, credit balance: 42/);
    child.stdin.write(`${JSON.stringify(initializeBody)}\n`);
    const [line] = await waitForOutput(child.stdout, /^.*\n/);
    assert.equal(JSON.parse(line).result.serverInfo.name, "risha-mcp-server");
  } finally {
    child.kill();
  }
});
