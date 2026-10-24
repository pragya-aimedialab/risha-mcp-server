#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const swagger = JSON.parse(readFileSync(join(__dirname, "swagger.json"), "utf8"));
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

const defaultBaseUrl = `${swagger.schemes?.[0] ?? "https"}://${swagger.host}${swagger.basePath ?? ""}`;
const baseUrl = (process.env.RISHA_API_BASE_URL || defaultBaseUrl).replace(/\/$/, "");
const transportMode = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const rishaEmail = process.env.RISHA_EMAIL || process.env.RISHA_USERNAME || "";
const rishaPassword = process.env.RISHA_PASSWORD || "";

// Per-session state: stdio has one context from env, HTTP mode has one per MCP session.
function createContext({ token = "", refreshToken = "", allowPasswordLogin = false, authMode = "token" } = {}) {
  return {
    token,
    refreshToken,
    allowPasswordLogin,
    authMode,
    loading: null,
    mediaUrlCache: new Map(),
    startupState: {
      initialized: false,
      initializedAt: null,
      login: null,
      me: null,
      capabilities: [],
      capabilitiesSource: null,
      creditBalance: null,
      creditWallet: null,
      creditSummary: null,
      errors: []
    }
  };
}

function resolveRef(obj) {
  if (!obj || !obj.$ref) return obj;
  const parts = obj.$ref.replace(/^#\//, "").split("/");
  let current = swagger;
  for (const part of parts) current = current?.[part];
  return current ?? obj;
}

function operationParameters(pathItem, operation) {
  return [...(pathItem.parameters || []), ...(operation.parameters || [])].map((p) => resolveRef(p));
}

function summarizeSchema(schema, depth = 0) {
  schema = resolveRef(schema);
  if (!schema || depth > 5) return schema || null;
  if (schema.$ref) return summarizeSchema(schema, depth + 1);
  const out = { ...schema };
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, summarizeSchema(v, depth + 1)])
    );
  }
  if (out.items) out.items = summarizeSchema(out.items, depth + 1);
  return out;
}

const operations = [];
const byId = new Map();
for (const [path, pathItem] of Object.entries(swagger.paths || {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.has(method)) continue;
    const params = operationParameters(pathItem, operation);
    const bodyParam = params.find((p) => p.in === "body");
    const formParams = params.filter((p) => p.in === "formData");
    const op = {
      operationId: operation.operationId,
      method: method.toUpperCase(),
      path,
      url: `${baseUrl}${path}`,
      tags: operation.tags || [],
      summary: operation.summary || operation.description || "",
      description: operation.description || "",
      pathParameters: params.filter((p) => p.in === "path").map(parameterInfo),
      queryParameters: params.filter((p) => p.in === "query").map(parameterInfo),
      headerParameters: params.filter((p) => p.in === "header").map(parameterInfo),
      bodySchema: bodyParam ? summarizeSchema(bodyParam.schema) : null,
      formParameters: formParams.map(parameterInfo),
      consumes: operation.consumes || swagger.consumes || ["application/json"],
      produces: operation.produces || swagger.produces || ["application/json"],
      responses: operation.responses || {}
    };
    operations.push(op);
    byId.set(op.operationId, op);
  }
}

function parameterInfo(p) {
  return {
    name: p.name,
    in: p.in,
    required: Boolean(p.required),
    type: p.type || p.schema?.type || (p.schema?.$ref ? p.schema.$ref : undefined),
    description: p.description || "",
    enum: p.enum,
    default: p.default
  };
}

function toText(data) {
  return [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrivateMediaUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value, baseUrl);
    return url.origin === new URL(baseUrl).origin && url.pathname.startsWith(`${new URL(baseUrl).pathname}/media/asset/`);
  } catch {
    return false;
  }
}


async function resolveMediaUrl(ctx, privateUrl) {
  const absoluteUrl = new URL(privateUrl, baseUrl).toString();
  if (ctx.mediaUrlCache.has(absoluteUrl)) return ctx.mediaUrlCache.get(absoluteUrl);
  await ensureAuthenticated(ctx);
  const res = await fetch(absoluteUrl, {
    method: "GET",
    redirect: "manual",
    headers: { Authorization: `Bearer ${ctx.token}`, Accept: "*/*" }
  });
  const location = res.headers.get("location");
  const resolved = location ? new URL(location, absoluteUrl).toString() : absoluteUrl;
  ctx.mediaUrlCache.set(absoluteUrl, resolved);
  return resolved;
}

async function resolveMediaUrlsDeep(ctx, value, state = { count: 0 }) {
  if (state.count >= 50) return value;
  if (isPrivateMediaUrl(value)) {
    state.count += 1;
    return resolveMediaUrl(ctx, value);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveMediaUrlsDeep(ctx, item, state)));
  }
  if (value && typeof value === "object") {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveMediaUrlsDeep(ctx, item, state)]));
    return Object.fromEntries(entries);
  }
  return value;
}

function buildUrl(op, pathParams = {}, query = {}) {
  let path = op.path;
  for (const p of op.pathParameters) {
    const value = pathParams[p.name];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required path parameter: ${p.name}`);
    }
    path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
  }
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
    else url.searchParams.set(key, String(value));
  }
  return url;
}

const HOSTED_LOGIN_MESSAGE = "Password login is disabled in hosted mode: your MCP client signs you in with Risha OAuth. Reconnect the Risha connector if your session has expired.";

async function loginWithPassword(ctx) {
  if (!ctx.allowPasswordLogin) throw new Error(HOSTED_LOGIN_MESSAGE);
  if (!rishaEmail || !rishaPassword) {
    throw new Error("Missing credentials. Set RISHA_EMAIL and RISHA_PASSWORD, or set RISHA_API_TOKEN.");
  }

  const res = await fetch(`${baseUrl}/auth/login/`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ email: rishaEmail, password: rishaPassword })
  });
  const raw = await res.text();
  let data = raw;
  try { data = raw ? JSON.parse(raw) : {}; } catch {}

  if (!res.ok) {
    throw new Error(`Login failed (${res.status} ${res.statusText}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  const access = data?.tokens?.access || data?.access;
  const refresh = data?.tokens?.refresh || data?.refresh;
  if (!access) {
    throw new Error(`Login succeeded but no access token was returned: ${JSON.stringify(data)}`);
  }
  ctx.token = access;
  if (refresh) ctx.refreshToken = refresh;
  return { authenticated: true, user: data?.user, requires_verification: data?.requires_verification, requires_subscription: data?.requires_subscription };
}

async function refreshAccessToken(ctx) {
  if (!ctx.refreshToken) return false;
  const res = await fetch(`${baseUrl}/token/refresh/`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: ctx.refreshToken })
  });
  if (!res.ok) return false;
  const data = await res.json();
  if (data.access) ctx.token = data.access;
  if (data.refresh) ctx.refreshToken = data.refresh;
  return Boolean(data.access);
}

async function ensureAuthenticated(ctx) {
  if (ctx.token) return;
  await loginWithPassword(ctx);
}

const publicOps = new Set(["auth_login", "token_obtain_create", "token_refresh_create", "auth_register", "auth_register_register_quick", "auth_password_reset", "auth_password-reset_password_reset_confirm"]);

async function callRisha(ctx, op, { pathParams, query, body, headers } = {}, retry = true) {
  if (!publicOps.has(op.operationId)) await ensureAuthenticated(ctx);

  const url = buildUrl(op, pathParams, query);
  const requestHeaders = {
    Accept: op.produces?.[0] || "application/json",
    ...(headers || {})
  };
  if (ctx.token && !requestHeaders.Authorization && !publicOps.has(op.operationId)) requestHeaders.Authorization = `Bearer ${ctx.token}`;

  const init = { method: op.method, headers: requestHeaders };
  if (!["GET", "HEAD"].includes(op.method) && body !== undefined && body !== null) {
    requestHeaders["Content-Type"] = requestHeaders["Content-Type"] || op.consumes?.[0] || "application/json";
    if (requestHeaders["Content-Type"].includes("application/json")) init.body = JSON.stringify(body);
    else init.body = String(body);
  }

  const res = await fetch(url, init);
  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();
  let data = raw;
  if (contentType.includes("application/json") && raw) {
    try { data = JSON.parse(raw); } catch {}
  }
  if (res.status === 401 && retry && await refreshAccessToken(ctx)) {
    return callRisha(ctx, op, { pathParams, query, body, headers }, false);
  }
  if (res.ok) data = await resolveMediaUrlsDeep(ctx, data);
  return { ok: res.ok, status: res.status, statusText: res.statusText, url: url.toString(), data };
}

function extractResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  return data ? [data] : [];
}

async function fetchAllPages(ctx, operationId, query = {}) {
  const op = byId.get(operationId);
  if (!op) throw new Error(`Unknown operationId: ${operationId}`);
  const first = await callRisha(ctx, op, { query: { page_size: 200, ...query } });
  if (!first.ok) throw new Error(`${operationId} failed (${first.status}): ${JSON.stringify(first.data)}`);

  let data = first.data;
  let items = extractResults(data);
  let next = data?.next;
  let page = Number(query.page || 1);
  while (next && page < 100) {
    page += 1;
    const result = await callRisha(ctx, op, { query: { page_size: 200, ...query, page } });
    if (!result.ok) break;
    data = result.data;
    items = items.concat(extractResults(data));
    next = data?.next;
  }
  return items;
}

function pickCreditBalance(summary, wallet, me) {
  const candidates = [
    summary?.balance,
    summary?.available_balance,
    summary?.available_credits,
    summary?.total_balance,
    summary?.credits,
    wallet?.balance,
    wallet?.available_balance,
    wallet?.available_credits,
    wallet?.total_balance,
    wallet?.credits,
    me?.credit_wallet?.balance,
    me?.credit_wallet?.available_balance,
    me?.credit_wallet?.available_credits,
    me?.credit_wallet?.total_balance,
    me?.credit_wallet?.credits
  ];
  return candidates.find((value) => value !== undefined && value !== null) ?? null;
}

async function waitForGeneration(ctx, requestId, { timeoutSeconds = 300, pollSeconds = 5 } = {}) {
  const readOp = byId.get("generation-requests_read");
  if (!readOp) throw new Error("generation-requests_read operation is missing from Swagger");

  const started = Date.now();
  const timeline = [];
  let last = null;
  while (Date.now() - started < timeoutSeconds * 1000) {
    const result = await callRisha(ctx, readOp, { pathParams: { id: requestId } });
    if (!result.ok) throw new Error(`Poll failed (${result.status}): ${JSON.stringify(result.data)}`);
    last = result.data;
    const status = last?.status;
    timeline.push({ at: new Date().toISOString(), status });
    if (["completed", "failed", "cancelled"].includes(status)) {
      return { request: last, status, timeline, elapsedSeconds: Math.round((Date.now() - started) / 1000) };
    }
    await sleep(Math.max(1, pollSeconds) * 1000);
  }
  return { request: last, status: last?.status || "timeout", timeline, elapsedSeconds: Math.round((Date.now() - started) / 1000), timedOut: true };
}

async function createGeneration(ctx, { capability, title, prompt_data, wait = true, timeoutSeconds = 300, pollSeconds = 5 }) {
  const createOp = byId.get("generation-requests_create");
  if (!createOp) throw new Error("generation-requests_create operation is missing from Swagger");
  const createResult = await callRisha(ctx, createOp, { body: { capability, title, prompt_data } });
  if (!createResult.ok) throw new Error(`Create failed (${createResult.status}): ${JSON.stringify(createResult.data)}`);

  const requestId = createResult.data?.id;
  if (!wait || !requestId) return { created: createResult.data };
  const final = await waitForGeneration(ctx, requestId, { timeoutSeconds, pollSeconds });
  return { created: createResult.data, ...final };
}

async function initializeRishaSession(ctx) {
  const startupState = ctx.startupState;
  startupState.initializedAt = new Date().toISOString();
  startupState.errors = [];

  try {
    startupState.login = ctx.token ? { authenticated: true, mode: ctx.authMode } : await loginWithPassword(ctx);
  } catch (error) {
    startupState.errors.push(`login: ${error?.message || String(error)}`);
    startupState.initialized = false;
    return startupState;
  }

  for (const [key, operationId] of [["me", "auth_me"], ["creditSummary", "credits_wallets_my_summary"], ["creditWallet", "credits_wallets_my_wallet"]]) {
    try {
      const result = await callRisha(ctx, byId.get(operationId));
      if (result.ok) startupState[key] = result.data;
      else startupState.errors.push(`${operationId}: ${result.status} ${JSON.stringify(result.data)}`);
    } catch (error) {
      startupState.errors.push(`${operationId}: ${error?.message || String(error)}`);
    }
  }

  try {
    startupState.capabilities = await fetchAllPages(ctx, "customer_capabilities_list", { is_active: "true" });
    startupState.capabilitiesSource = "customer_capabilities_list";
  } catch (error) {
    startupState.errors.push(`customer_capabilities_list: ${error?.message || String(error)}`);
    try {
      startupState.capabilities = await fetchAllPages(ctx, "capabilities_list", { is_active: "true" });
      startupState.capabilitiesSource = "capabilities_list";
    } catch (fallbackError) {
      startupState.errors.push(`capabilities_list: ${fallbackError?.message || String(fallbackError)}`);
    }
  }

  startupState.creditBalance = pickCreditBalance(startupState.creditSummary, startupState.creditWallet, startupState.me);
  startupState.initialized = true;
  return startupState;
}

// Loads me/capabilities/credits once per context; retries on the next call if it failed.
async function ensureContextLoaded(ctx) {
  ctx.loading ??= initializeRishaSession(ctx);
  const state = await ctx.loading;
  if (!state.initialized) ctx.loading = null;
  return state;
}

function createMcpServer(ctx) {
  const server = new McpServer({ name: "risha-mcp-server", version: "1.0.0" });

  server.tool(
    "risha_list_operations",
    "List Risha API operations from the Swagger document. Use filter to search operationId, path, tag, or summary.",
    {
      filter: z.string().optional().describe("Case-insensitive text filter"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50)
    },
    async ({ filter = "", method, tag, limit }) => {
      const q = filter.toLowerCase();
      const results = operations.filter((op) => {
        const haystack = [op.operationId, op.path, op.summary, ...(op.tags || [])].join(" ").toLowerCase();
        return (!method || op.method === method) && (!tag || op.tags.includes(tag)) && (!q || haystack.includes(q));
      }).slice(0, limit).map(({ operationId, method, path, tags, summary }) => ({ operationId, method, path, tags, summary }));
      return { content: toText({ count: results.length, totalOperations: operations.length, results }) };
    }
  );

  server.tool(
    "risha_get_operation",
    "Get details for one Risha API operation, including required path/query parameters and request body schema.",
    { operationId: z.string() },
    async ({ operationId }) => {
      const op = byId.get(operationId);
      if (!op) return { isError: true, content: toText(`Unknown operationId: ${operationId}`) };
      return { content: toText(op) };
    }
  );

  server.tool(
    "risha_login",
    "Login to Risha using RISHA_EMAIL and RISHA_PASSWORD and cache the returned JWT for this MCP server session. Not available in hosted mode, where the MCP client signs in with OAuth.",
    {},
    async () => {
      if (!ctx.allowPasswordLogin) return { content: toText(HOSTED_LOGIN_MESSAGE) };
      try {
        const result = await loginWithPassword(ctx);
        return { content: toText(result) };
      } catch (error) {
        return { isError: true, content: toText(error?.message || String(error)) };
      }
    }
  );

  server.tool(
    "risha_startup_state",
    "Show the Risha session context: login status, user, capabilities count, and credit balance.",
    {},
    async () => {
      const state = await ensureContextLoaded(ctx);
      return { content: toText({ ...state, capabilities: undefined, capabilitiesCount: state.capabilities.length }) };
    }
  );

  server.tool(
    "risha_capabilities",
    "Return the capabilities loaded for this session. Use filter to search name/slug/category/provider fields.",
    {
      filter: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100)
    },
    async ({ filter = "", limit }) => {
      const state = await ensureContextLoaded(ctx);
      const q = filter.toLowerCase();
      const results = state.capabilities.filter((cap) => !q || JSON.stringify(cap).toLowerCase().includes(q)).slice(0, limit);
      return { content: toText({ count: results.length, total: state.capabilities.length, source: state.capabilitiesSource, results }) };
    }
  );

  server.tool(
    "risha_credit_balance",
    "Return the credit balance/wallet data loaded for this session.",
    {},
    async () => {
      const state = await ensureContextLoaded(ctx);
      return { content: toText({ balance: state.creditBalance, summary: state.creditSummary, wallet: state.creditWallet, userCreditWallet: state.me?.credit_wallet }) };
    }
  );

  server.tool(
    "risha_refresh_context",
    "Refresh the session context: current user, all capabilities, and credit balance (logs in again with env credentials in local stdio mode).",
    {},
    async () => {
      ctx.loading = initializeRishaSession(ctx);
      const state = await ctx.loading;
      return { isError: state.errors.length > 0 && !state.initialized, content: toText({ ...state, capabilities: undefined, capabilitiesCount: state.capabilities.length }) };
    }
  );

  server.tool(
    "risha_resolve_media_url",
    "Convert a private Risha /api/media/asset/... URL into its signed public/CDN URL.",
    { url: z.string().describe("Private Risha media URL from file_url/output_url/etc.") },
    async ({ url }) => {
      try {
        if (!isPrivateMediaUrl(url)) return { isError: true, content: toText("This does not look like a Risha private media asset URL.") };
        const publicUrl = await resolveMediaUrl(ctx, url);
        return { content: toText({ privateUrl: url, publicUrl }) };
      } catch (error) {
        return { isError: true, content: toText(error?.message || String(error)) };
      }
    }
  );

  server.tool(
    "risha_create_generation",
    "Create a Risha generation request and optionally poll until completed/failed. Use this instead of manual create/read polling.",
    {
      capability: z.number().int().describe("Risha capability ID"),
      title: z.string().optional(),
      prompt_data: z.record(z.any()).describe("Prompt payload expected by the capability"),
      wait: z.boolean().default(true),
      timeoutSeconds: z.number().int().min(10).max(1200).default(300),
      pollSeconds: z.number().int().min(1).max(30).default(5)
    },
    async ({ capability, title, prompt_data, wait, timeoutSeconds, pollSeconds }) => {
      try {
        const result = await createGeneration(ctx, { capability, title: title || `MCP generation ${new Date().toISOString()}`, prompt_data, wait, timeoutSeconds, pollSeconds });
        return { isError: ["failed", "cancelled", "timeout"].includes(result.status), content: toText(result) };
      } catch (error) {
        return { isError: true, content: toText(error?.message || String(error)) };
      }
    }
  );

  server.tool(
    "risha_generate_image",
    "Convenience text-to-image tool. Defaults to the lightweight Nano Banana 2 text-to-image capability and waits for the final public image URL.",
    {
      prompt: z.string(),
      title: z.string().optional(),
      capability: z.number().int().default(21),
      aspect_ratio: z.string().default("1:1"),
      resolution: z.string().default("0.5k"),
      extraPromptData: z.record(z.any()).optional(),
      timeoutSeconds: z.number().int().min(10).max(1200).default(300),
      pollSeconds: z.number().int().min(1).max(30).default(5)
    },
    async ({ prompt, title, capability, aspect_ratio, resolution, extraPromptData = {}, timeoutSeconds, pollSeconds }) => {
      try {
        const prompt_data = { prompt, aspect_ratio, resolution, ...extraPromptData };
        const result = await createGeneration(ctx, { capability, title: title || prompt.slice(0, 120), prompt_data, wait: true, timeoutSeconds, pollSeconds });
        return { isError: ["failed", "cancelled", "timeout"].includes(result.status), content: toText(result) };
      } catch (error) {
        return { isError: true, content: toText(error?.message || String(error)) };
      }
    }
  );

  server.tool(
    "risha_call",
    "Call a Risha API operation by operationId, authenticated as the current Risha user.",
    {
      operationId: z.string(),
      pathParams: z.record(z.any()).optional().describe("Values for {path} parameters"),
      query: z.record(z.any()).optional().describe("Query string parameters"),
      body: z.any().optional().describe("JSON request body for POST/PUT/PATCH"),
      headers: z.record(z.string()).optional().describe("Extra HTTP headers")
    },
    async (args) => {
      const op = byId.get(args.operationId);
      if (!op) return { isError: true, content: toText(`Unknown operationId: ${args.operationId}`) };
      try {
        const result = await callRisha(ctx, op, args);
        return { isError: !result.ok, content: toText(result) };
      } catch (error) {
        return { isError: true, content: toText(error?.message || String(error)) };
      }
    }
  );

  server.tool(
    "risha_api_info",
    "Show Risha API server/configuration info loaded from Swagger.",
    {},
    async () => {
      const state = await ensureContextLoaded(ctx);
      const authMode = ctx.token ? ctx.authMode : (ctx.allowPasswordLogin && rishaEmail && rishaPassword ? "email_password" : "none");
      const username = ctx.allowPasswordLogin ? rishaEmail || undefined : state.me?.email;
      return { content: toText({ title: swagger.info?.title, version: swagger.info?.version, baseUrl, transport: transportMode, authenticated: Boolean(ctx.token), authMode, username, startupInitialized: state.initialized, capabilitiesCount: state.capabilities.length, creditBalance: state.creditBalance, startupErrors: state.errors, operationCount: operations.length, tags: [...new Set(operations.flatMap((op) => op.tags))].sort() }) };
    }
  );

  return server;
}

async function startStdio() {
  const ctx = createContext({
    token: process.env.RISHA_API_TOKEN || process.env.RISHA_BEARER_TOKEN || "",
    refreshToken: process.env.RISHA_REFRESH_TOKEN || "",
    allowPasswordLogin: true
  });
  const state = await ensureContextLoaded(ctx);
  if (state.initialized) {
    console.error(`[risha-mcp] logged in, loaded ${state.capabilities.length} capabilities, credit balance: ${state.creditBalance ?? "unknown"}`);
  } else {
    console.error(`[risha-mcp] startup initialization failed: ${state.errors.join("; ")}`);
  }
  await createMcpServer(ctx).connect(new StdioServerTransport());
}

const TOKEN_CACHE_MS = 60_000;
const SESSION_IDLE_MS = 60 * 60_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version, WWW-Authenticate"
};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res, status, code, message, headers) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Parse error: invalid JSON"), { status: 400, rpcCode: -32700 });
  }
}

function startHttp() {
  const port = Number(process.env.PORT ?? 3000);
  const oauthIssuer = (process.env.RISHA_OAUTH_ISSUER || new URL(baseUrl).origin).replace(/\/$/, "");
  const tokenCache = new Map();
  const sessions = new Map();
  let publicUrl = process.env.MCP_PUBLIC_URL || "";

  const protectedResourceMetadata = () => ({
    resource: publicUrl,
    authorization_servers: [oauthIssuer],
    scopes_supported: ["risha"],
    bearer_methods_supported: ["header"],
    resource_name: "Risha"
  });

  function unauthorized(res, error) {
    const metadataUrl = `${new URL(publicUrl).origin}/.well-known/oauth-protected-resource`;
    const challenge = `Bearer resource_metadata="${metadataUrl}"${error ? `, error="${error}"` : ""}`;
    jsonRpcError(res, 401, -32001, error ? "Invalid or expired access token" : "Missing bearer token", { "WWW-Authenticate": challenge });
  }

  // Returns { userKey } for a valid token, null for one Risha rejects with 401.
  async function validateToken(token) {
    const cached = tokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const res = await fetch(`${baseUrl}/auth/me/`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.status === 401) return null;
    if (!res.ok) throw Object.assign(new Error(`Risha API rejected the token check (${res.status})`), { status: res.status === 403 ? 403 : 502 });
    const me = await res.json().catch(() => ({}));
    const identity = { userKey: String(me?.id ?? me?.email ?? token), expiresAt: Date.now() + TOKEN_CACHE_MS };
    for (const [key, value] of tokenCache) if (value.expiresAt <= Date.now()) tokenCache.delete(key);
    tokenCache.set(token, identity);
    return identity;
  }

  async function handleMcp(req, res) {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    if (!match) return unauthorized(res);
    const token = match[1].trim();
    const identity = await validateToken(token);
    if (!identity) return unauthorized(res, "invalid_token");

    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return jsonRpcError(res, 404, -32001, "Session not found");
      if (session.userKey !== identity.userKey) return jsonRpcError(res, 403, -32003, "Session belongs to a different user");
      session.ctx.token = token; // clients refresh tokens mid-session
      session.lastSeen = Date.now();
      return session.transport.handleRequest(req, res, body);
    }

    const isInit = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
    if (req.method !== "POST" || !isInit) return jsonRpcError(res, 400, -32000, "Bad Request: no valid session ID provided");

    const ctx = createContext({ token, authMode: "oauth" });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { ctx, transport, userKey: identity.userKey, lastSeen: Date.now() });
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await createMcpServer(ctx).connect(transport);
    return transport.handleRequest(req, res, body);
  }

  const httpServer = createServer(async (req, res) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
    const { pathname } = new URL(req.url, "http://localhost");
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      if (pathname === "/healthz" && req.method === "GET") return sendJson(res, 200, { status: "ok" });
      if ((pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") && req.method === "GET") {
        return sendJson(res, 200, protectedResourceMetadata());
      }
      if (pathname === "/mcp") {
        if (!["GET", "POST", "DELETE"].includes(req.method)) return jsonRpcError(res, 405, -32000, "Method not allowed", { Allow: "GET, POST, DELETE, OPTIONS" });
        return await handleMcp(req, res);
      }
      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      console.error(`[risha-mcp] ${req.method} ${pathname} failed: ${error?.message || String(error)}`);
      if (res.headersSent) return res.end();
      const status = error?.status || 500;
      return jsonRpcError(res, status, error?.rpcCode ?? (status === 400 ? -32700 : -32603), status === 500 ? "Internal server error" : error.message);
    }
  });

  const sweep = setInterval(() => {
    for (const [id, session] of sessions) {
      if (Date.now() - session.lastSeen <= SESSION_IDLE_MS) continue;
      sessions.delete(id);
      session.transport.close().catch(() => {});
    }
  }, 5 * 60_000);
  sweep.unref();

  const shutdown = () => {
    for (const { transport } of sessions.values()) transport.close().catch(() => {});
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  httpServer.listen(port, () => {
    const actualPort = httpServer.address().port;
    publicUrl ||= `http://localhost:${actualPort}/mcp`;
    console.error(`[risha-mcp] HTTP transport listening on port ${actualPort}, resource ${publicUrl}, issuer ${oauthIssuer}`);
  });
}

if (transportMode === "http") startHttp();
else if (transportMode === "stdio") await startStdio();
else {
  console.error(`[risha-mcp] unknown MCP_TRANSPORT "${transportMode}"; use "stdio" or "http"`);
  process.exit(1);
}
