# timon-mcp

Timon plugin (`behavior`, API 15) that exposes a stateless Streamable HTTP MCP server. An MCP client mandates the pilot. The MCP mandates, the pilot orchestrates: the plugin forwards the mandate and reports the reply. It does not change agents, MCP servers, skills, secrets, or administration.

`POST /mcp` requires a bearer token. Without the URL settings, the OAuth routes answer that the plugin is not configured.

Licensed under the GNU Affero General Public License v3.0 only. See `LICENSE`.

## Install

Node.js 22.13 or newer. From this directory, or from a packed archive:

```bash
timon plugin add .
```

`timon plugin add` accepts a folder, a `.tgz`, or a `.zip`.

The package is not signed. Timon loads an unsigned plugin only on a licensed installation with developer mode open. In `timon.config.json`:

```json
{
  "developer": {
    "unsignedPlugins": true
  }
}
```

Without that flag the package can be installed and is not loaded. Developer mode does not bypass the licence.

Until the plugin is signed, `missions:spawn` stays refused until the id is approved. Tasks created from the background identity go through the same policy and the same quota. In `timon.config.json`:

```json
{
  "pluginPolicy": {
    "spawn": {
      "approved": ["timon-mcp"],
      "max": 5,
      "windowMs": 3600000
    }
  }
}
```

`max` and `windowMs` are the operator's quota (here, 5 starts per hour, as in the Timon documentation example). A signed plugin is approved by its signature and stays subject to the quota.

## Endpoint

`POST /api/plugins/timon-mcp/mcp`

JSON-RPC 2.0, one request per call, response `application/json`. No SSE stream, no session. `Mcp-Session-Id` is optional and ignored. The spoken revisions are `2025-06-18` and `2025-03-26`. An unknown version at initialization receives the latest. A present and unknown `MCP-Protocol-Version` header answers `400`.

`GET /mcp` and `DELETE /mcp` answer `405` when the handler is reached. On the daemon those methods are not public paths: an anonymous client receives `401` before the handler.

The manifest declares seven public paths (`http:public`), at most ten. The daemon limits each one: 60 requests a minute per address, a 64 KiB body, and a cross-site `POST` is refused. An `Origin` from another host is refused (`403`) after authentication. When `Host` carries a port, the `Origin` port (written or implicit) must be the same. When `Host` carries none, an `Origin` of the same host with no port is accepted over http and over https: behind TLS the daemon often sees `Host: example.com` and `Origin: https://example.com`. A non-browser client, with no `Origin`, is accepted. A JSON-RPC batch (an array) is refused.

`GET /health` answers `{ "ok": true, "id": "timon-mcp" }`. This route is not public: it follows the daemon session.

## Authentication

The plugin is both the protected resource and the authorization server (MCP authorization, revision 2025-06-18). Paths have no dot: a segment of `routes.publicPaths` cannot contain one. The `/.well-known/…` URLs are rewrites of the reverse proxy, below. The plugin does not serve them.

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/oauth/protected-resource` | Protected-resource metadata (RFC 9728). `resource` is the public address of the MCP endpoint. `authorization_servers` contains the issuer. |
| `GET` | `/oauth/authorization-server` | Authorization-server metadata (RFC 8414). PKCE `S256` only, grants `authorization_code` and `refresh_token`, client authentication `none`, `registration_endpoint` advertised. |
| `POST` | `/oauth/register` | Dynamic client registration (RFC 7591). Public clients only. No `client_secret`. |
| `GET` | `/oauth/authorize` | Consent page, self-contained HTML, server-side CSRF token. |
| `POST` | `/oauth/authorize` | Decision. An approval issues a single-use code, at most 60 seconds. |
| `POST` | `/oauth/token` | Code exchange (PKCE S256) or refresh-token rotation (RFC 6749, form body or JSON). |
| `POST` | `/mcp` | MCP endpoint. `Authorization: Bearer`. |

OAuth 2.1 here is dynamic client registration plus PKCE S256. `code_challenge_method=plain` is refused.

While `public_url`, `issuer`, or `resource` is missing or is not an absolute `http`/`https` URL, with no userinfo, query, or fragment, these routes answer `503` with `error: not_configured`. The authorization page is then HTML that issues no code. No host is hard-coded.

`resource` (RFC 8707) is required at authorization and at the exchange. It must be exactly the configured address. A token issued for another address is refused at the MCP endpoint.

Without an `Authorization` header, `POST /mcp` answers `401`:

```http
WWW-Authenticate: Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"
```

A token that is present but unusable, unknown, expired, or for another audience adds `, error="invalid_token"`. The JSON body stays `{ "error": "unauthorized", "message": "…" }`. The token is not in it. A token in the query string is ignored. The `Bearer` scheme is case-insensitive. Past 512 characters, the presented value is refused.

The access token is opaque and lasts 15 minutes. The refresh token lasts 30 days, rotates on every use, and can be revoked. Presenting a refresh token that has already rotated revokes its whole family, including the token that replaced it and the access tokens of that family that are still in flight. Until that reuse, the previous access token stays valid until it expires. The authorization code is removed on first presentation, even when the PKCE verifier is wrong.

`redirect_uri` must be `https`, or `http` limited to `localhost` and `127.0.0.1` (local CLIs). `http://localhost.evil.com` is refused. The URI is bound to the registered client, by exact comparison of the registered string. Dynamic clients are capped at 128. When that cap is reached, the same transaction removes clients created more than 24 hours ago that hold no live row: no unrevoked token still before `expires_at`, no code, no consent request. The count is taken again afterwards. Registration answers `403` only when the cap still holds.

The same removal can be run by hand on the plugin database. `cutoff` is the current time minus 24 hours, `now_ms` is the current time, both in Unix milliseconds:

```sql
DELETE FROM oauth_clients
WHERE created_at < :cutoff
  AND client_id NOT IN (
    SELECT client_id FROM oauth_tokens
    WHERE revoked_at IS NULL AND expires_at > :now_ms
  )
  AND client_id NOT IN (SELECT client_id FROM oauth_codes)
  AND client_id NOT IN (SELECT client_id FROM oauth_requests);
```

Codes, tokens, and the CSRF secret are stored only as SHA-256 digests. The subject is the digest of the address, not the address. Expired rows are purged. None of this is written to the logs. The plugin logs only fixed phrases (`oauth: client registered`, `oauth: code issued`, `oauth: tokens issued`, `oauth: refresh rotated`, `oauth: authorization refused`). An unexpected failure is logged as `oauth: request failed (<name>)`, where `<name>` is `error.name` (for example `TypeError`). The error message is not logged.

## Settings

Permission `settings`. Values are read on every request. Empty at the start, except the documentary right.

| Key | Role |
| --- | --- |
| `public_url` | Public origin of the plugin, without a trailing slash. Used for the `resource_metadata` challenge. Fictitious example: `https://mcp.example`. |
| `issuer` | OAuth issuer, without a trailing slash. The plugin is the authorization server. Often the same origin. |
| `resource` | Canonical address of the MCP endpoint, the value of the `resource` parameter. Fictitious example: `https://mcp.example/mcp`. |
| `identity_header` | Header read only on `/oauth/authorize`. While the value is not saved, or is saved blank, the plugin uses the name it ships with, `x-forwarded-email`. A non-empty value replaces it. |
| `expected_right` | Name of the right expected on the surface. Default `timon`. Documentary: no right header is read. It appears on the refusal page. |
| `email_allowlist` | Allowed addresses, separated by commas, spaces, or semicolons. Empty: refuse everyone. |

## Vault secret

One secret, read only: `TIMON_MCP_BEARER_TOKEN`. It is the static token for CLIs on the host. Create it in the vault, then:

```bash
timon secret grant TIMON_MCP_BEARER_TOKEN --scope agent:plugin:timon-mcp
```

Without a grant, `ctx.secrets.get` returns empty: the static token is disabled, and the plugin does not crash. The value is read again on every call. The comparison is of SHA-256 digests, in constant time. The name is the constant shared with the manifest, never a literal in the call.

This token is not bound to an audience. It does not replace OAuth for clients that discover the server from the `401` challenge.

## Identity

Put `/oauth/authorize` behind an authentication proxy (a session cookie, a magic link, or any equivalent). The proxy serves its own login page, then sends the browser back to the requested path, including `/oauth/authorize`. It applies the right before it proxies: only addresses of accounts that hold the right on the surface get through.

It forwards one header upstream. The default name is `x-forwarded-email`, the convention used by authentication proxies such as oauth2-proxy. Set `identity_header` when the proxy uses another name.

There is no header for a right, a level, or an internal or external marker. The plugin assumes none. `expected_right` is only a label.

`IdentityResolver` (`lib/auth/identity.js`) returns `{ subject, email }` or `null`. The header name comes from the setting when that value is non-empty, otherwise from the shipped default `x-forwarded-email`, including when the saved value is blank. It refuses a missing or empty header, and an address that is not on the allowlist. An empty allowlist refuses everyone. The refusal is an HTML page, with no redirect and no code. The address is not shown.

The header is read only on `GET` and `POST /oauth/authorize`. On `/mcp` and on the other routes it is ignored: it does not stand in for a token.

The subject stored with the code and the tokens is the SHA-256 digest of the normalized address (trimmed, lower case). The logs do not contain the address in clear text.

### Threat model

A client on the outside cannot forge the header. The edge strips it on the public paths, then the authentication proxy sets it after checking the session. The strip line targets `x-forwarded-email`, or the name saved in `identity_header` when that setting is non-empty.

Any local process that can reach the daemon can set this header itself. That is an accepted limit on the host: the daemon is not exposed directly.

The allowlist is defense in depth. The proxy has already filtered the right. An empty list grants nothing, even if a header arrives.

### What the reverse proxy must pass through

A reverse proxy often strips `Authorization` and `Cookie` on public paths.

That fits `/oauth/token`, `/oauth/register`, and the metadata documents. Consent does not use a cookie: the CSRF token is in the form and its digest is in the database. `/mcp` needs `Authorization` to reach the plugin, so that path must be public with the header forwarded. That change is on the proxy, not in this repository.

## Reverse proxy

Any TLS reverse proxy rewrites the public URLs onto the plugin prefix. `/.well-known/*` is not a plugin route: the proxy rewrites it. Fictitious host, nothing is installed by this repository:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
rewrite ^/.well-known/oauth-protected-resource$ /api/plugins/timon-mcp/oauth/protected-resource last;
rewrite ^/.well-known/oauth-authorization-server$ /api/plugins/timon-mcp/oauth/authorization-server last;
rewrite ^/oauth/(.*)$ /api/plugins/timon-mcp/oauth/$1 last;
rewrite ^/mcp$ /api/plugins/timon-mcp/mcp last;
```

The daemon compares `Origin` with `Host`. `proxy_set_header Host $host;` forwards the public host the client saw. Without that line the daemon would see the upstream address and refuse an `Origin` of the same site. `proxy_set_header X-Real-IP $remote_addr;` replaces any client-supplied value with the address the proxy actually saw. `/mcp` must forward `Authorization` through to the daemon. Public paths clear the identity header at the edge, before the authentication proxy sets it, as above. `proxy_pass` to the daemon is an operator setting, not a value of the plugin.

## Clients

OAuth clients start from the `401` and from `resource_metadata`, register a public client, then run the authorization-code flow with PKCE S256. The operator fills in the three URLs and the allowlist, and places the authentication proxy in front of `/oauth/authorize`. No token value belongs in the repository.

CLIs on the host use the static token. Same shape, fictitious URL:

```json
{
  "mcpServers": {
    "timon": {
      "type": "http",
      "url": "https://mcp.example/mcp",
      "headers": {
        "Authorization": "Bearer <TIMON_MCP_BEARER_TOKEN>"
      }
    }
  }
}
```

`<TIMON_MCP_BEARER_TOKEN>` names the vault secret. It is not a value to paste.

## Tools

The list is closed. Another name returns an `isError` result, `unknown tool`, with no facade call. Every schema has `additionalProperties: false`.

| Tool | Role |
| --- | --- |
| `ask_main` | Mandate to the pilot. Without `project`, the agent is `_main`. With `project` (`^[a-z0-9][a-z0-9-]{0,39}$`), the agent is `<project>.main`. No other agent name. Without `mission_id`, `missions.spawn({ agent, mission })`. With `mission_id`, `missions.send`. Reply `{ mission_id, agent, status }`. Message limited to 20,000 characters. |
| `get_reply` | Mission state and the agent's last message, through `missions.get` (`missions:read`). |
| `wait` | Same shape as `get_reply`, plus `done`. Server-side wait, 25 s by default, 50 s at most. |
| `list_missions` | Missions of the plugin: `id`, `agent_name`, `status`, `title`, `started_at`, `ended_at`. The prompt is not returned. |
| `list_tasks` | Tasks visible to the plugin, through `ctx.kanban`. The description is not returned. |
| `create_task` | A `chore` task of the project, assigned to `<project>.main`. No backend, model, pipeline, or permission. |

`spawn` sends no override (`model`, `backend`, `extraSkills`, `extraMcp`, `allow`).

`get_reply` does not declare `missions:transcript`. The body of the last message is returned only when the mission already carries it (`last_message` or `messages`). Otherwise the reply contains the `summary` and the state, and `message` is `null`.

`wait` uses `ctx.events.on('turn_complete')` when that call is available. The permission `events:subscribe` is not declared: if the call throws, the plugin polls the state at a short interval. `done` becomes `true` on `turn_complete` for this mission, or when the status is terminal (`completed`, `failed`, `terminated`, `cancelled`). A conversation that is still open stays `running`: polling the status alone can time out with `done: false`.

A policy refusal (`PluginPolicyError`, or `reason: 'spawn_policy'`) is a tool result with `isError`, and the text `waiting for the operator's approval`. It is not an HTTP 500, and the plugin does not retry the call.

## Call identity

A public route has an anonymous caller. In that context, `missions.send` is forbidden and `missions.list` / `get` read every mission. Each tool therefore runs outside the request, under the background task identity `plugin:timon-mcp`, through the pump started in `apply()` (`lib/mcp/job-runner.js`). The plugin then sees only the missions it started and the tasks it created.

## Permissions

`http:public`, `missions:spawn`, `missions:read`, `missions:control`, `kanban:read`, `kanban:write`, `settings`, `secrets:read`, `storage:sql`.

`missions:control` is for `send`. The tools expose neither `kill`, nor `fork`, nor `stopScope`. `secrets:read` is only for the static token. `storage:sql` is only for OAuth clients, codes, and tokens. No configuration right (`agents:*`, `mcp-servers:*`, `skills:*`, `secrets:manage`, `secrets:list`, `secrets:broker`, `admin`, `agents:privileged-config`).

## Standalone mode

This mode runs the same plugin without loading it into the daemon. It is provisional. While a release refuses an unsigned plugin, a small host can serve the routes itself. When a later release loads the plugin, point the reverse proxy back at the daemon. One `proxy_pass` line switches to the host, and the same line pointed at the daemon restores the plugin. The paths stay `/api/plugins/timon-mcp/…`.

The host listens on the loopback interface only. `TIMON_MCP_PORT` chooses the port. When it is unset, the port is 3098. It needs Node.js 22.13 or newer, because `node:sqlite` is only a stable built-in from that release, and has no npm dependency. The process checks the version before it loads that module: an older Node exits with a message on stderr and a non-zero status. The daemon 0.1.7 ships Node 22.23.4, so installing the plugin into the daemon is unchanged. `lib/` is unchanged: the host builds the plugin context and calls `apply()`.

The host calls the local daemon over HTTP. `TIMON_DAEMON_URL` must stay on the loopback. The daemon token is read from a file on every call (`TIMON_DAEMON_TOKEN_FILE`, default `~/.timon/daemon-token`) and is never written to a log. The static bearer is the environment variable `TIMON_MCP_BEARER_TOKEN`. Settings are a JSON file (`TIMON_MCP_SETTINGS`) using the same keys as the manifest. State is a sqlite file (`TIMON_MCP_DB`, default `~/.timon-mcp/state.db`) and uses the plugin migrations.

Only five daemon calls are possible: create a mission, read one mission, send a message to it, create a chore task, and read one task. Any other method or path is refused before the network. The host records the missions and tasks it created. Reading and listing refuse an id it did not create. A list reads at most the 50 newest recorded ids. An id the daemon answers with 404 is dropped from that record. The agent is `_main` or `<project>.main`. Overrides (`model`, `backend`, `extraSkills`, `extraMcp`, `allow`) are not sent.

`spawn`, `send` and task creation share one sliding window. `TIMON_MCP_SPAWN_MAX` is how many of those calls are allowed (default 5). `TIMON_MCP_SPAWN_WINDOW_MS` is the window in milliseconds (default 3600000). Past the ceiling the tool result is `isError`, with the text `waiting for the operator's approval`, and the daemon is not called. The daemon token is a super-administrator, so this ceiling is the host's own quota.

In this mode `summary` is null. The mission route used here does not carry one.

Public paths keep the daemon limits: 60 requests a minute per address, a body of at most 64 KiB, and a cross-site POST is refused. The address is the socket peer. `X-Real-IP` is used only when `TIMON_MCP_TRUST_PROXY=1` and that peer is loopback, which is how the reverse proxy on this machine reaches the host. The proxy must set `proxy_set_header X-Real-IP $remote_addr;`. Any other value of the setting, or a peer that is not loopback, ignores the header. `X-Forwarded-For` is ignored. `GET /health` is not a public path.

Any response sent before that body has been read leaves through one exit: `Connection: close`, then at most 1 MiB of the unread body is discarded over at most 5 seconds, then the socket is destroyed. That covers a non-public path, an unknown prefix, a method this host does not serve, a cross-site POST, a body past 64 KiB, a rate limit, and any later status written while the body is still unread. The server also stops incomplete headers after 10 seconds and an unfinished request after 30 seconds. An idle socket is closed after 80 seconds: the longest `wait` is 50 seconds and writes nothing, the following daemon call is capped at 20 seconds, and 10 seconds of margin keep that call from losing the socket. Incomplete requests are checked every second, so those deadlines fire on time.

An example user unit is `deploy/timon-mcp-standalone.service`. It loads `EnvironmentFile=` and contains no secret. The operator replaces `ExecStart` with the checkout (the program, `host/` and `lib/` stay together) and installs the unit. This package does not install it.

## Tests

No npm dependency: the stateless subset of MCP Streamable HTTP is a small JSON-RPC core in `lib/mcp/`. `@timon-ai/sdk` is not published. The contract tests (`node:test`) follow the documented daemon contract and use the fake context in `test/helpers/fake-ctx.js`. The SQL double in the tests uses `node:sqlite`. The plugin itself calls only `ctx.sql`.

The standalone host is covered by the same command. Those tests speak to an in-process fake daemon and do not call an installed daemon.

```bash
npm test
```

Distribution check, from this directory:

```bash
timon plugin check .
```
