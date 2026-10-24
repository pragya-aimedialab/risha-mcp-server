# Risha.ai MCP Server

A Model Context Protocol (MCP) server for the Risha.ai API.

This server lets MCP clients such as **Codex**, **Claude Code**, Claude Desktop, Claude.ai and ChatGPT discover Risha API operations, inspect capabilities, check credit balance and create generation requests.

It runs in two modes:

- **Local (stdio)**, the default: you run it on your machine and it signs in with your email/password or an API token from environment variables.
- **Hosted (Streamable HTTP)**: one shared server at a URL such as `https://mcp.risha.ai/mcp`. Each user signs in with their own Risha account through OAuth in their MCP client; no credentials are stored on the server. See [Hosted mode](#hosted-mode-streamable-http--oauth).

## Features

- Email/password authentication using Risha `/auth/login/`
- Automatic login at MCP startup
- Automatic startup context loading:
  - current user
  - active capabilities
  - credit wallet / balance
- Generic Swagger-backed API caller for all Risha operations
- Convenience generation helpers:
  - `risha_generate_image`
  - `risha_create_generation`
- Automatic polling for generation completion

## Requirements

- Node.js 18+
- A valid Risha.ai account (www.risha.ai)
- An MCP-capable client, for example:
  - Codex
  - Claude Code
  - Claude Desktop

## Install

```bash
git clone https://github.com/aimedialab/risha-mcp-server.git
cd risha-mcp-server
npm install
```

## Environment variables

Required for email/password login:

```bash
RISHA_EMAIL="you@example.com"
RISHA_PASSWORD="your-password"
```

Optional:

```bash
RISHA_API_BASE_URL="https://adminxcore-api.risha.ai/api"
```

Token-based auth is also supported, but email/password is the recommended flow:

```bash
RISHA_API_TOKEN="your-access-token"
RISHA_REFRESH_TOKEN="your-refresh-token"
```

> Never commit real credentials. Put them in your MCP client config or a local `.env` file. `.env` is ignored by git.

## Run manually

```bash
RISHA_EMAIL="you@example.com" RISHA_PASSWORD="your-password" npm start
```

Expected startup log:

```text
[risha-mcp] logged in, loaded 32 capabilities, credit balance: 72621
```

An MCP stdio server normally waits silently after startup. That is expected.

## Hosted mode (Streamable HTTP + OAuth)

Set `MCP_TRANSPORT=http` to serve MCP over Streamable HTTP at `/mcp` instead of stdio.

In this mode the server is an OAuth 2.1 *resource server*. Risha (`RISHA_OAUTH_ISSUER`) is the authorization server: the MCP client discovers it, registers itself, signs the user in (authorization code + PKCE) and refreshes tokens on its own. The server only checks the bearer token on each request against Risha's `/auth/me/` endpoint (cached for 60 seconds per token) and then calls the Risha API as that user.

- `POST|GET|DELETE /mcp` – MCP endpoint. Requests without a valid `Authorization: Bearer` token get `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, which tells the client where to start the OAuth flow.
- `GET /.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) – RFC 9728 protected resource metadata.
- `GET /healthz` – liveness check.

Each MCP session is bound to the Risha user who opened it; a request for that session with another user's token is rejected with `403`. Password login (`risha_login`) is disabled in this mode, and `risha_refresh_context` only reloads the user, capabilities and credits.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `http` for hosted mode |
| `PORT` | `3000` | HTTP port |
| `MCP_PUBLIC_URL` | `http://localhost:$PORT/mcp` | Public URL of the MCP endpoint, used as the OAuth `resource` |
| `RISHA_API_BASE_URL` | `https://adminxcore-api.risha.ai/api` | Risha API base URL |
| `RISHA_OAUTH_ISSUER` | origin of `RISHA_API_BASE_URL` | Risha OAuth authorization server |

### Run locally

```bash
MCP_TRANSPORT=http PORT=3000 npm start
```

### Docker

```bash
docker build -t risha-mcp-server .
docker run --rm -p 3000:3000 \
  -e MCP_PUBLIC_URL="https://mcp.risha.ai/mcp" \
  -e RISHA_API_BASE_URL="https://adminxcore-api.risha.ai/api" \
  risha-mcp-server
```

The image runs as a non-root user with `MCP_TRANSPORT=http` and a `/healthz` health check. Put it behind HTTPS; OAuth clients require it for non-localhost URLs.

### Connect a client to the hosted server

In every client you only enter the server URL; the client opens a Risha sign-in page the first time you use it.

- **Claude.ai / Claude Desktop**: Settings → Connectors → *Add custom connector*, then enter `https://mcp.risha.ai/mcp`.
- **Claude Code**:

  ```bash
  claude mcp add --transport http risha https://mcp.risha.ai/mcp
  ```

  Then run `/mcp` in Claude Code and choose *Authenticate* for `risha`.
- **ChatGPT**: Settings → Connectors (Apps) → *Create*, with `https://mcp.risha.ai/mcp` as the MCP server URL and OAuth as the authentication. Custom connectors are only available on some ChatGPT plans and may require developer mode to be enabled.
- **Codex** (`~/.codex/config.toml`):

  ```toml
  [mcp_servers.risha]
  url = "https://mcp.risha.ai/mcp"
  ```

  Then run `codex mcp login risha`.
- **Cursor** (`~/.cursor/mcp.json`):

  ```json
  {
    "mcpServers": {
      "risha": { "url": "https://mcp.risha.ai/mcp" }
    }
  }
  ```

## Available MCP tools

### `risha_api_info`

Shows API metadata, authentication mode, startup status, capabilities count, credit balance, and Swagger tag list.

### `risha_startup_state`

Shows the context loaded at startup:

- login state
- current user
- capabilities count
- credit balance
- startup errors, if any

### `risha_capabilities`

Returns the active capabilities retrieved at startup.

Input example:

```json
{
  "filter": "image",
  "limit": 20
}
```

### `risha_credit_balance`

Returns credit balance, wallet, summary, and user wallet data.

### `risha_refresh_context`

Reloads the current user, capabilities, and credit data (in local mode, logs in again first if no token is cached).

### `risha_login`

Manually logs in with `RISHA_EMAIL` and `RISHA_PASSWORD` and caches the JWT for the current MCP session. Local mode only; in hosted mode it explains that sign-in happens through the client's OAuth flow.

### `risha_list_operations`

Searches all Swagger operations.

Input example:

```json
{
  "filter": "generation",
  "limit": 20
}
```

### `risha_get_operation`

Returns schema details for one operation.

Input example:

```json
{
  "operationId": "generation-requests_create"
}
```

### `risha_call`

Generic caller for any Swagger operation.

Input example:

```json
{
  "operationId": "auth_me"
}
```

Generation request example:

```json
{
  "operationId": "generation-requests_create",
  "body": {
    "capability": 21,
    "title": "MCP smoke test",
    "prompt_data": {
      "prompt": "a red apple on a white table",
      "resolution": "0.5k",
      "aspect_ratio": "1:1"
    }
  }
}
```

### `risha_create_generation`

Creates any generation request and optionally polls until it reaches a terminal state.

Input example:

```json
{
  "capability": 21,
  "title": "MCP image test",
  "prompt_data": {
    "prompt": "a red apple on a white table",
    "resolution": "0.5k",
    "aspect_ratio": "1:1"
  },
  "wait": true,
  "timeoutSeconds": 300,
  "pollSeconds": 5
}
```

### `risha_generate_image`

Convenience text-to-image tool. Defaults to capability `21`, `0.5k`, `1:1`.

Input example:

```json
{
  "prompt": "a cinematic photo of a red apple on a white table",
  "resolution": "0.5k",
  "aspect_ratio": "1:1",
  "timeoutSeconds": 300,
  "pollSeconds": 5
}
```

### `risha_resolve_media_url`

Converts a private authenticated Risha media URL into a signed public CDN URL.

Input example:

```json
{
  "url": "https://adminxcore-api.risha.ai/api/media/asset/4c6cbe1c-7696-4c13-8790-6456e5d64698/?f=webp&h=600&q=85&w=600"
}
```

## Use with Codex

Codex reads MCP servers from `~/.codex/config.toml`.

Add this block:

```toml
[mcp_servers.risha]
command = "node"
args = ["/absolute/path/to/risha-mcp-server/src/index.js"]
startup_timeout_sec = 60

[mcp_servers.risha.env]
RISHA_EMAIL = "you@example.com"
RISHA_PASSWORD = "your-password"
```

For the local project path created by this agent:

```toml
[mcp_servers.risha]
command = "node"
args = ["/Users/amirhamdani/Documents/risha-mcp-server/src/index.js"]
startup_timeout_sec = 60

[mcp_servers.risha.env]
RISHA_EMAIL = "you@example.com"
RISHA_PASSWORD = "your-password"
```

Restart Codex after editing the config.

### Codex test prompts

```text
Use the Risha MCP server and run risha_api_info.
```

```text
Use the Risha MCP server and show my Risha credit balance.
```

```text
Use the Risha MCP server and list image capabilities.
```

```text
Use Risha MCP to generate a small image of a red apple on a white table.
```

## Use with Claude Code

Claude Code supports MCP servers over stdio. You can add the server using either the CLI or JSON configuration.

### Option A: Claude Code CLI

From the project directory:

```bash
claude mcp add risha \
  --env RISHA_EMAIL="you@example.com" \
  --env RISHA_PASSWORD="your-password" \
  -- node /absolute/path/to/risha-mcp-server/src/index.js
```

Then restart Claude Code or start a new session.

Test prompts:

```text
Use the risha MCP server and run risha_api_info.
```

```text
Use the risha MCP server to show my credit balance.
```

```text
Use the risha MCP server to generate a small image of a robot holding a camera.
```

### Option B: Claude MCP JSON config

If your Claude Code setup uses JSON MCP configuration, add:

```json
{
  "mcpServers": {
    "risha": {
      "command": "node",
      "args": ["/absolute/path/to/risha-mcp-server/src/index.js"],
      "env": {
        "RISHA_EMAIL": "you@example.com",
        "RISHA_PASSWORD": "your-password"
      }
    }
  }
}
```

## Use with Claude Desktop

Add this to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "risha": {
      "command": "node",
      "args": ["/absolute/path/to/risha-mcp-server/src/index.js"],
      "env": {
        "RISHA_EMAIL": "you@example.com",
        "RISHA_PASSWORD": "your-password"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config.

## Test with MCP Inspector

```bash
cd risha-mcp-server
npx @modelcontextprotocol/inspector \
  env RISHA_EMAIL="you@example.com" RISHA_PASSWORD="your-password" \
  node src/index.js
```

Open the Inspector URL printed in the terminal and try:

1. `risha_api_info`
2. `risha_credit_balance`
3. `risha_capabilities`
4. `risha_generate_image`

## Typical workflow for agents

1. Call `risha_api_info` to confirm authentication and startup state.
2. Call `risha_credit_balance` to check credits.
3. Call `risha_capabilities` to pick a capability.
4. Use `risha_generate_image` for simple image generation, or `risha_create_generation` for arbitrary capabilities.
5. Use returned public CDN URLs directly. Private media URLs are resolved automatically when possible.

## Notes on generation time

Image/video generation is asynchronous. The MCP server can create a request immediately, but final completion depends on provider queue and model runtime. `risha_generate_image` and `risha_create_generation` poll until completion or timeout.

Default polling values:

- `timeoutSeconds`: `300`
- `pollSeconds`: `5`

## Development

```bash
npm install
npm test
npm start
```

Project layout:

```text
risha-mcp-server/
  src/
    index.js       # MCP server implementation (stdio and HTTP)
    swagger.json   # Risha Swagger/OpenAPI document
  test/
    server.test.js # node --test suite against a mock Risha API
  Dockerfile
  package.json
  README.md
```

## License

MIT
