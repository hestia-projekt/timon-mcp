# timon-mcp

Timon plugin (`behavior`, API 15) that exposes a stateless Streamable HTTP MCP server. An MCP client mandates the pilot. The MCP mandates, the pilot orchestrates: the plugin forwards the mandate and reports the reply. It does not change agents, MCP servers, skills, secrets, or administration.

`POST /mcp` requires a bearer token. Without the URL settings, the OAuth routes answer that the plugin is not configured.

Licensed under the GNU Affero General Public License v3.0 only. See `LICENSE`.

## Install

Node.js >=22.13 <23 || >=23.4. From this directory, or from a packed archive:

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

JSON-RPC 2.0, one request per call, response `application/json`. No SSE stream, no session. `Mcp-Session-Id` is optional and ignored. The spoken revisions are `2025-06-18` and `2025-03-26`. An unknown `params.protocolVersion` at initialization receives the latest. On `initialize`, `MCP-Protocol-Version` is not checked. After `initialize`, including on notifications, a present and unknown `MCP-Protocol-Version` answers `400`. An absent header is accepted.

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

`missions:control` is for `send`. The tools expose neither `kill`, nor `fork`, nor `stopScope`. `secrets:read` is only for the static token. `storage:sql` is for OAuth clients, codes, and tokens. The standalone host uses the same database for `host_pending_cards` and `host_decisions`. No configuration right (`agents:*`, `mcp-servers:*`, `skills:*`, `secrets:manage`, `secrets:list`, `secrets:broker`, `admin`, `agents:privileged-config`).

## Standalone mode

This mode runs the same plugin without loading it into the daemon. It is provisional. While a release refuses an unsigned plugin, a small host can serve the routes itself. When a later release loads the plugin, point the reverse proxy back at the daemon. One `proxy_pass` line switches to the host, and the same line pointed at the daemon restores the plugin. The paths stay `/api/plugins/timon-mcp/…`.

The host listens on the loopback interface only. `TIMON_MCP_PORT` chooses the port. When it is unset, the port is 3098. It needs Node.js >=22.13 <23 || >=23.4, because `node:sqlite` is a stable built-in on that range, and has no npm dependency. The process checks the version before it loads that module: an older Node exits with a message on stderr and a non-zero status. The daemon 0.1.7 ships Node 22.23.4, so installing the plugin into the daemon is unchanged. `lib/` is unchanged: the host builds the plugin context and calls `apply()`.

The host calls the local daemon over HTTP. `TIMON_DAEMON_URL` must stay on the loopback. The daemon token is read from a file on every call (`TIMON_DAEMON_TOKEN_FILE`, default `~/.timon/daemon-token`) and is never written to a log. The static bearer is the environment variable `TIMON_MCP_BEARER_TOKEN`. Settings are a JSON file (`TIMON_MCP_SETTINGS`) using the same keys as the manifest. State is a sqlite file (`TIMON_MCP_DB`, default `~/.timon-mcp/state.db`) and uses the plugin migrations.

Thirty daemon calls are possible. Five of them serve the plugin tools: create a mission, read one mission the host created, send a message to that mission, create a chore task, and read one task. Six more serve the mission tools below: list every mission, read one message, steer a turn, interrupt a mission, stop one mission, and stop an agent or a project. Two more serve the kanban tools: list every task, and change one task (`PUT /api/tasks/:id`). There is no `DELETE /api/tasks/:id`. Four more serve the project and agent tools: list projects (`GET /api/projects`), list agents (`GET /api/agents`), read one agent (`GET /api/agents/:name`), and send a direct message (`POST /api/messages`). None of those four accepts a query. Ten more serve pipelines, workflows, and routines: `GET /api/pipelines`, `GET /api/pipelines/:id`, `GET /api/pipelines/runs/:runId`, `POST /api/pipelines/:id/run`, `GET /api/workflows`, `GET /api/workflows/:id`, `GET /api/workflows/:id/runs`, `POST /api/workflows/:id/run`, `GET /api/routines`, and `GET /api/routines/:id`. None of those ten accepts a query. One more is the read-only `GET /api/permissions`. It takes no query, including no `mission_id`. Two more serve a decision. `POST /api/permissions/:id/resolve` sends only the bodies under Answering a waiting card. The id is a lowercase UUID and the path takes no query. `GET /api/auth/me` is read only to copy `user.id` into the journal. The rest of that payload, including any address, is not logged, not stored, and not returned. No other route under `/api/auth` or `/api/permissions` is called. The host pattern for those ids is `:auto`, so a workflow slug may contain a dot. `runs`, `node-types`, `import`, and `hooks` are not workflow ids: they are their own daemon routes and are refused. Any other method, path, query key, or body field is refused before the network. A query string stuck on the path is refused, including an allowlisted key. Query keys are accepted only as each list's allowlist. The mission list accepts `project`, `agent`, `status` (`running`, `completed`, `failed`, `terminated`), and `limit`. The task list accepts `status` only (`PENDING`, `IN_PROGRESS`, `DONE`, `BLOCKED`). Release 0.1.8 has no `limit`, `project`, `agent`, `type`, or pagination on `GET /api/tasks`. `full` would return the uncut texts and is refused. `done_limit` only windows DONE rows and still returns every other status, so it is not a bound and is not sent. `project`, `agent`, and `type` are applied by the host on the rows that came back. This one response may be read up to 8 MiB. Past that, `list_all_tasks` returns `too_large` and names `status` and `get_task`. It does not report the daemon as unreachable. Each pipeline, workflow, and routine read uses the same 8 MiB ceiling, including a single get: a workflow row carries its draft. Past that, the tool returns `too_large` and names the route template. It does not report the daemon as unreachable. Every other daemon response stays capped at 1 MiB. `GET /api/permissions` uses that cap. Past it, `list_pending` returns `too_large` and does not report the daemon as unreachable. The host sends no query on that route, so it cannot shrink the body. `%2f` and `..` are refused, and so are the daemon's own words `latest`, `search`, and `delegate` used as a mission id. `active`, `spawn`, `ephemeral`, and `main` are not agent names on a path: they are their own daemon routes and are refused. A read accepts a display name (`[A-Za-z0-9._-]{1,255}`, including an ephemeral `_eph-…`). 255 is one directory, the daemon's hard bound on a stored name. That name may be a list filter, the agent of `stop_scope`, or `GET /api/agents/:name`. `.`, `..`, and those four route words are still refused before the call. A launch, a task assignment, and a direct message stay `_main` or `<project>.<role>`. 97 is the longest name release 0.1.8 fabricates (`<slug>.<role>`, a project slug of 1..64 and a role id of 2..32). That length is a read, not a launch. The host still records the missions and tasks it created. The plugin tools `list_missions`, `get_reply`, `ask_main`, `list_tasks`, and `create_task` read and write only those recorded ids. A list of recorded ids reads at most the 50 newest. The same call stops after 60 seconds, checked before each of those reads, and fails with a timeout instead of returning the rows already gathered. One read already started can still finish inside its own 20 second cap, so the list stays inside the idle limit below. An id the daemon answers with 404 is dropped from that record. `list_all_tasks` is one daemon read of `GET /api/tasks`, not that per-id walk.

A launch names an agent that already exists: `_main`, or `<project>.<role>`, where both parts match `^[a-z0-9][a-z0-9-]{0,39}$`, so the name is at most 81 characters. The host does not create the agent. Overrides (`model`, `backend`, `extraSkills`, `extraMcp`, `allow`, `permissionMode`) are refused before the network.

`spawn`, `send`, `steer`, stopping one mission, stopping an agent or a project, task creation, a direct message of kind `request`, running a pipeline, and running a workflow share one sliding window. `TIMON_MCP_SPAWN_MAX` is how many of those calls are allowed (default 5). `TIMON_MCP_SPAWN_WINDOW_MS` is the window in milliseconds (default 3600000). Past the ceiling the tool result is `isError`, with the text `waiting for the operator's approval`, and the daemon is not called. Listing missions, reading a mission, reading one message, and interrupting a turn do not take a slot. Listing tasks, reading a task, updating it, and moving it do not take a slot either. Listing projects, listing agents, reading one agent, and a direct message of kind `msg` do not take a slot. Listing and reading pipelines, workflows, routines, and workflow runs do not take a slot. Listing pending cards does not take a slot. Answering a question, resolving an approval, and reading the decision journal do not take a slot. A run whose input is refused does not take a slot. A run the daemon answers with an error still does: the slot is taken before the call. The daemon token is a super-administrator, so this ceiling is the host's own quota.

The mission tools, the kanban tools, the project and agent tools, and the pipeline, workflow, and routine tools are mounted by the host on `POST /mcp`, in front of the plugin's six tools. They need the same plugin bearer. They are absent when the plugin runs inside the daemon. `lib/` and the manifest are unchanged. The host does not call `ctx.agents`, so `projects:read`, `agents:read`, and `messages:send` are not declared. It does not call `ctx.pipelines`, `ctx.workflows`, or `ctx.routines`, so `pipelines:read`, `pipelines:run`, `workflows:read`, `workflows:run`, and `routines:read` are not declared. It does not call `ctx.questions` or `ctx.events.on`, so `questions:read`, `questions:answer`, and `events:subscribe` are not declared. A run sends exactly `{ input }`. `input` is a JSON object of at most 64 KiB. `draft`, backend, model, permission, and overrides are refused, including as keys of `input`. `draft` would run the unpublished graph, so it is never sent. The projections drop prompts, drafts, run context, triggers, owners, and override fields. A pipeline keeps the `{{input.name}}` keys, so a run still knows what to pass. A workflow get keeps the node id and type only. The list and the detail are projections: the prompt, the transcript, the overrides, the owner, and the working directory are not returned. The message tool reads one event (`GET /api/missions/:id/messages/:eventId`) and returns at most 20,000 characters of its text. A task projection drops the same kind of field: overrides, attachments, and the worktree path. Description and comment are cut at 20,000 characters. A project row is `slug`, `name`, and `status`. An agent list row is `name`, `role`, `project`, and `orchestrator`. A detail adds `reports_to` and `ephemeral`. The system prompt, privileged config, MCP servers, secrets, skills, and absolute paths are not returned. `POST /api/messages` is the only write of this group. `from_mission` and `from_agent` are fixed by the host (`00000000-0000-4000-8000-0000000000aa` and `plugin:timon-mcp`). The caller cannot set them. The body is at most 20,000 characters. `kind` is `msg` or `request`. A work-return payload is refused before the network. No route writes an agent, a file, a skill, an MCP server, or a project.

| Tool | Role |
| --- | --- |
| `list_all_missions` | Every mission. Optional `project`, `agent` (a display name, including `_eph-…`), and `status` (`running`, `completed`, `failed`, `terminated`). No prompt. |
| `get_mission_state` | State of one mission. No prompt. |
| `get_mission_message` | One message of that mission, by `event_id`. The text is cut at 20,000 characters. |
| `send_mission` | Follow-up on any mission. Counts against the window. |
| `steer_mission` | Redirects the turn in progress. Counts against the window. |
| `interrupt_mission` | Interrupts the turn. Does not count against the window. |
| `stop_mission` | Stops one mission. Counts against the window. |
| `stop_scope` | Stops one `agent` (a display name, including `_eph-…`) or one `project`, not both. Counts against the window. |
| `launch_mission` | Starts `_main` or `<project>.<role>`. No override. Counts against the window. |
| `list_all_tasks` | Every task. Optional `project`, `agent` (a display name, including `_eph-…`), `status` (`PENDING`, `IN_PROGRESS`, `DONE`, `BLOCKED`), and `type`. Only `status` is sent. No description. A body past 8 MiB is `too_large`. |
| `get_task` | One task, including description, base, blocked reason, and done comment. |
| `add_task` | Creates `code`, `review`, `merge`, `research`, `doc`, or `chore` on an existing project and an existing agent (`_main` or `<project>.<role>`). Optional `base`, `deps`, and `priority`. No override. Counts against the window. |
| `update_task` | Title, description, priority, dependencies, or agent. At least one. |
| `move_task` | Status. `BLOCKED` requires `reason` (`blocked_reason`). Optional `comment` is `done_comment` on the same request, stored only when the status changes. |
| `list_projects` | Projects: `slug`, `name`, `status`. No absolute path. Optional `limit` (1..100) is applied by the host. No query is sent. |
| `list_agents` | Agents, including an ephemeral `_eph-…`: `name`, `role`, `project`, `orchestrator`. Optional `project` and `limit` are applied by the host. No query is sent. No prompt, config, MCP server, secret, or skill. |
| `get_agent` | One agent by a path-safe display name, including `_eph-…`. Adds `reports_to` and `ephemeral`. Same projection as the list. |
| `send_agent` | Direct message to an existing agent. `from_mission` and `from_agent` are fixed by the host. `kind` is `msg` (default, no wake, no quota) or `request` (wakes, counts against the window). No work-return payload. |
| `list_pipelines` | Pipelines: id, name, description, `{{input.name}}` keys, and steps (id, agent, type, deps_on, priority). No prompt, override, or owner. Optional `limit` (1..100, 50 when omitted) is applied by the host. No query is sent. A body past 8 MiB is `too_large`. |
| `get_pipeline` | One pipeline. Same projection as the list. |
| `run_pipeline` | Runs a pipeline. `input` is the only field sent. Counts against the window. The result is the run id and the step task ids. |
| `get_pipeline_run` | One pipeline run and its steps (task, agent, type, status). The run input and the step prompts are not returned. |
| `list_workflows` | Workflows: id, slug, name, description, project, enabled, published version, agent, and the last run's id and status. No draft, no owner. Optional `project` and `limit` are applied by the host. No query is sent. |
| `get_workflow` | One workflow by id or slug. Adds the node id and type. No node config, prompt, or script. |
| `list_workflow_runs` | Runs of one workflow: id, version, status, start, end, and error. No context, input, trigger, or owner. |
| `run_workflow` | Runs the published version. `input` is the only field sent. `draft` is refused. Counts against the window. |
| `list_routines` | Routines: id, name, agent, task type, cron, enabled, project, and the run times. No prompt, no owner. Does not enable or disable. Optional `project` and `limit` are applied by the host. |
| `get_routine` | One routine. Same projection as the list. |
| `list_pending` | Questions, kanban plans, and tool approvals still waiting. An approval adds `command`: a 160-character redacted preview of the non-empty input command, or, when that is absent, of a tool name that is one backtick segment covering the whole name (`tool_name` is then `shell`). No other input. The same `command` is on the webhook. Optional `mission_id` and `limit` (1..100, 50 when omitted) are applied by the host. No query is sent. A body past 1 MiB is `too_large`. Does not answer a card. |
| `answer_question` | Answers a waiting question or kanban plan. `answers` is keyed by the question text, or `plan` is the kanban answer, or `cancel: true` closes the form. One of the three. Optional `relay_channel` defaults to `hermes`. The status is the one the daemon accepted. Does not take a slot and does not emit the webhook. |
| `resolve_approval` | `allow` or `deny` on a tool approval. `deny` takes an optional `message` of at most 2000 characters. `scope`, `paste`, and a rewritten tool input are refused before the daemon is called. Does not take a slot and does not emit the webhook. |
| `list_decisions` | The decision journal, newest first. Optional `limit` is 1 to 100 and 50 when omitted. No address. Does not call the daemon and does not take a slot. |

`PUT /api/tasks/:id` is the only task write besides creation. The body is a whitelist: `title`, `description`, `agent_name`, `priority`, `deps`, `status`, `blocked_reason`, `done_comment`. Release 0.1.8 stores `done_comment` only when that same request changes the status, so a comment is a field of `move_task` and not its own tool. A comment sent alone is not a call. Creation adds `type`, `project`, and optional `base`. Backend, model, permission, skills, MCP servers, tools, fallback, and any other field are refused before the network. `create_task` stays a chore for `<project>.main`.

In this mode `summary` is null. The mission route used here does not carry one.

Public paths keep the daemon limits: 60 requests a minute per address, a body of at most 64 KiB, and a cross-site POST is refused. The address is the socket peer. `X-Real-IP` is used only when `TIMON_MCP_TRUST_PROXY=1` and that peer is loopback, which is how the reverse proxy on this machine reaches the host. The proxy must set `proxy_set_header X-Real-IP $remote_addr;`. Any other value of the setting, or a peer that is not loopback, ignores the header. `X-Forwarded-For` is ignored. `GET /health` is not a public path.

Any response sent before that body has been read leaves through one exit: `Connection: close`, then at most 1 MiB of the unread body is discarded over at most 5 seconds, then the socket is destroyed. That covers a non-public path, an unknown prefix, a method this host does not serve, a cross-site POST, a body past 64 KiB, a rate limit, and any later status written while the body is still unread. The server also stops incomplete headers after 10 seconds and an unfinished request after 30 seconds. An idle socket is closed after 120 seconds. `wait` writes nothing for up to 50 seconds. That handler can also make three daemon reads: one before the countdown starts, one poll still in flight when the countdown ends, and one final read. Each read is capped at 20 seconds. Ten seconds of margin keep the last read from losing the socket. Incomplete requests are checked every second, so those deadlines fire on time.

Pending cards are read from `GET /api/permissions` and projected before they leave the host. A question (`ask_user` whose payload validates) keeps the whitelist of the question facade: `type` `question`, `id`, `mission_id`, `agent`, `created_at`, `expires_at`, `questions` (`question`, `header`, `options` of `label`, `description`, and `actor` when it is `agent` or `user`, `multi_select`, `placeholder`), and `plan` set to `null`. A kanban plan is `type` `series_plan`, with `questions` empty and `plan` holding `title` (the chantier) and `volets` (`title`, `description`, `group`). Anything else, including an `ask_user` payload that does not validate, is `type` `approval` with `tool_name` (or the literal `tool` when the name is not safe) and `command`. This is a webhook contract change: an approval's webhook now carries `command`, the same value as `list_pending`. `command` is the tool input's `command` when that value is a non-empty string. Otherwise, when `tool_name` is one backtick segment that covers the whole string, `command` is the text inside the backticks and `tool_name` is the literal `shell`. The backticks are not trimmed: a surrounding space, two segments, or a partial wrap stays `tool` and does not supply `command`. A non-empty `input.command` keeps priority and the tool name stays the safe name or `tool`. The preview is cut to 160 characters. A bearer token and a hex run of 32 or more characters are replaced by `[redacted]`. A dashed UUID is not such a run, because the dashes split it. `command` is `null` when neither source is present. The webhook projection of an approval is `type`, `id`, `mission_id`, `agent`, `created_at`, `expires_at`, `tool_name`, and `command`. It has no `entry`, no `input`, no `shell_command`, and no `script_previews`. Every other input field is omitted. `shell_command`, `script_previews`, `tool_use_id`, `scopes`, `choices`, and `onPaste` are never copied, on either path. A question or a kanban plan keeps its whitelist on both paths and does not carry `command`. `expires_at` is `created_at + timeout_ms` when `timeout_ms` is a positive safe integer, otherwise `null`. A card whose id is not a lowercase UUID, whose mission id is not one this host already accepts, whose agent is not a displayable daemon name (`[A-Za-z0-9._-]{1,255}`, one directory, including an ephemeral `_eph-…` id; `.` and `..` are dropped), or whose `created_at` is not a non-negative safe integer is not projected. The host logs `pending card dropped id=<id>` when that id is a string, and `pending card dropped` otherwise. The line carries the id alone and does not include the card. While that id is still in the daemon list, the host treats the raw id as seen and does not emit `resolved`. `resolved` is emitted only when the id is absent from a complete list. `list_pending` returns `{ cards }` from a fresh read. It does not use the sqlite table below.

The host polls that same route on a timer. `TIMON_MCP_PENDING_INTERVAL_MS` is the gap in milliseconds (default 5000, minimum 1000, maximum 60000). An empty value uses the default. Any other value refuses to start, with the text `TIMON_MCP_PENDING_INTERVAL_MS is invalid`. The first poll waits one interval. A tick that arrives while a pass is still reading is ignored. The pass enqueues webhook work and returns without waiting for a try, a retry, or a timeout. Card ids are stored in the host sqlite table `host_pending_cards`, so a restart does not send `pending` again for an id already recorded. Webhook occurrence counts are stored in `host_pending_webhook_seq` and stay when resolved rows are deleted. Resolved rows are kept up to 200 and the oldest are deleted past that. A card that was not stored, or that was stored as `resolved` and has come back, produces the event `pending`. A stored `pending` id that is absent from a complete list produces `resolved`, using the projection that was stored. A stored `pending` id that the list still contains, but that this host cannot project, stays `pending` and is not sent again. A projection that changed while the card is still pending is written back and is not sent again. A poll that fails, or a list of more than 200 cards, changes nothing: a missing tail must not look resolved. The log then says `pending poll failed`, `pending poll too_large`, or `pending list is over the cap`, and does not include the body. With no webhook URL the poll still records ids, and nothing is sent. A recorded id is not sent again as `pending` if a URL is set later. A `resolved` event can arrive for a card that was recorded before that URL was set, once the card leaves a complete list. A card that was never recorded does not produce `resolved`.

`TIMON_MCP_PENDING_WEBHOOK_URL` is that URL. Leave it unset or empty to send nothing. `https` is required. `http` is accepted only when the host is `127.0.0.1`, `localhost`, or `::1`. A userinfo, a query, a hash, a space, or a length past 2000 characters is refused before the process listens, with the text `pending webhook URL is invalid`. The message does not include the URL. Redirects are not followed: a 3xx is a failed attempt. `TIMON_MCP_PENDING_WEBHOOK_SECRET` is required when a URL is set. It is a string of 16 to 512 characters, read from the environment file, and it is never written to the repository, a test, a journal, or a log. A missing or unusable secret refuses to start with the text `pending webhook secret is missing`, and that text does not include the secret. The secret is not a settings key. A secret that starts with `whsec_` is a Standard Webhooks secret: the host base64-decodes the characters after the prefix and uses those bytes as the key of `webhook-signature`. Those characters must be canonical base64 (alphabet `A-Za-z0-9+/`, `=` padding, and encoding the decoded bytes returns the same text). Otherwise the host refuses to start, with the text `pending webhook secret is not valid base64`, and that text does not include the secret. A secret that does not start with `whsec_` uses its UTF-8 bytes as that key. `x-timon-signature` always uses the secret string as given, including a `whsec_` prefix when one is present. It does not use the decoded bytes.

Each event is one `POST` of `{"event":"pending"|"resolved","card":<projection>}`. The headers are `content-type: application/json`, `x-timon-timestamp` (Unix milliseconds, decimal), and `x-timon-signature` (`v1=` plus the hex HMAC-SHA256 of `${timestamp}.${rawBody}`, where `rawBody` is the exact bytes of the POST). The same POST also carries the Standard Webhooks headers. `webhook-id` is `<event>_<card id>_<n>`, for example `pending_` followed by the card UUID and `_1`. `n` is a decimal count of that event for that card, starting at 1. Every attempt of one occurrence sends the same id. The next time that event is recorded for the card, the count is one higher, so `pending`, then `resolved`, then `pending` again are three ids, and a later `resolved` is a fourth. The counts are `pending_seq` and `resolved_seq` in `host_pending_webhook_seq`. They are written in the same transaction as the card row, and only once that occurrence's delivery tries have finished. A restart before that write sends the same occurrence again with the same id. A restart after it does not send the occurrence again. The value is the event name, the card id with control characters removed, underscores, and the decimal count, so it can be an HTTP header. `x-timon-timestamp` and `x-timon-signature` are unchanged. `webhook-timestamp` is that same clock reading, written as Unix seconds. `webhook-signature` is `v1,` plus the base64 HMAC-SHA256 of `${webhook-id}.${webhook-timestamp}.${rawBody}`, using the key rule above. Each attempt takes a new timestamp and signs both headers again. The id does not change, and `x-timon-timestamp` stays the millisecond value: it is not rewritten from the seconds. The receiver should read the raw body, reject a timestamp more than five minutes from its clock, and compare with a constant-time check:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_MS = 5 * 60 * 1000;

function verifyPendingWebhook(secret, rawBody, timestampHeader, signatureHeader) {
  if (!/^[0-9]{1,16}$/.test(timestampHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_SKEW_MS) return false;
  const expected = createHmac('sha256', secret).update(`${timestampHeader}.${rawBody}`).digest('hex');
  const got = signatureHeader.startsWith('v1=') ? signatureHeader.slice(3) : '';
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
```

The Standard Webhooks check uses the same body and the key rule above. Hermes Agent checks these headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_S = 5 * 60;

function standardWebhookKey(secret) {
  if (secret.startsWith('whsec_')) return Buffer.from(secret.slice('whsec_'.length), 'base64');
  return Buffer.from(secret, 'utf8');
}

function verifyStandardWebhook(secret, rawBody, idHeader, timestampHeader, signatureHeader) {
  if (!/^[0-9]{1,16}$/.test(timestampHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > MAX_SKEW_S) return false;
  const expected = createHmac('sha256', standardWebhookKey(secret))
    .update(`${idHeader}.${timestampHeader}.${rawBody}`)
    .digest('base64');
  const got = signatureHeader.startsWith('v1,') ? signatureHeader.slice(3) : '';
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
```

Hermes Agent subscribes the route with the same secret. The command takes the route name, not a URL (`hermes webhook subscribe --help`):

```
hermes webhook subscribe <name> --secret <the same secret>
```

`<name>` is the route name. Hermes receives the POST at `/webhooks/<name>`. Set `TIMON_MCP_PENDING_WEBHOOK_URL` to that URL. Pass `--secret`: without it, Hermes generates a different secret. This package does not create the subscription.

Deliveries run on a separate queue. At most 4 run at once, and at most 32 are outstanding, waiting and in flight together. A card that does not fit is left unrecorded; a later poll tries it again. The log then says `pending delivery queue is full`, with no card body. A delivery is tried three times. The waits before the second and third tries are 200 ms and 800 ms. Each try stops after 5 seconds. The card is recorded after those tries finish, including when they fail, so a later poll does not send that event again. A restart before the record still sends it, with the same `webhook-id`. After the third failure the host logs `pending webhook abandoned event=<event> id=<card id>` and does not log the body, the URL, the secret, the decoded key, or a signature. The caller that receives the webhook is configured by the operator. This package does not wire that caller.

An example user unit is `deploy/timon-mcp-standalone.service`. It loads `EnvironmentFile=-%h/.config/timon-mcp/standalone.env` and contains no secret. `deploy/timon-mcp-standalone.env.example` lists the variable names, including the webhook URL, the webhook secret, and the poll interval, with no values. The operator copies it, fills the secret outside the repository, replaces `ExecStart` with the checkout (the program, `host/` and `lib/` stay together), and installs the unit. This package does not install it.

### Answering a waiting card

`answer_question` answers a question or a kanban plan. `resolve_approval` allows or denies a tool approval. `list_decisions` reads the journal. None of the three is a plugin tool, none takes a spawn slot, and none is present when the plugin runs inside the daemon.

The card id is a lowercase UUID. `answer_question` takes `answers` (an object keyed by the question text; each choice is one of the offered options, and `choices` is accepted only on a multi-select question) or `plan` (`mode`, `roles`, and optional `groups` and `note`). An optional `note` on a question is trimmed and omitted when blank. `cancel: true` sends no answer. `resolve_approval` takes `behavior` `allow` or `deny`, and `deny` takes an optional `message` of at most 2000 characters. `scope`, `paste`, and `updatedInput` are not parameters. A call that names one of them, or any other field, is refused before the daemon is called. `relay_channel` is optional and defaults to `hermes`. It is the only accepted channel. `decided_by` is not a parameter.

Before it posts, the host reads `GET /api/permissions` and uses the card that is there now. A missing id is `card not found`. A question tool on an approval, or an approval tool on a question or a plan, is refused and nothing is posted. The body of `POST /api/permissions/:id/resolve` is then exactly one of:

- `{ "behavior": "allow" }`
- `{ "behavior": "deny" }` or `{ "behavior": "deny", "message": "..." }`
- `{ "behavior": "allow", "updatedInput": { "answers": {}, "note": "..." } }` (`note` only when it has text)
- `{ "behavior": "allow", "updatedInput": { "plan": {} } }`
- a cancel, which is `{ "behavior": "deny", "message": "<the form-cancelled text>" }`

`GET /api/auth/me` runs only after that body is valid, and only to read `user.id`. A null user is recorded as `daemon-token`. Any other shape is refused with `account id is unusable`, and the resolve route is not called. The rest of `/api/auth/me` (the address, the name, the preferences) is not logged, not stored, and not returned by a tool. The host does not serve `/api/auth/me`.

The tool result is `{ id, type, status }`. `status` is what the daemon accepted. `{ "ok": true }` means the body above was accepted: an approval is `allow` or `deny`, a question or a plan is `answered`, and a cancel is `cancelled`. A `behavior` echoed by the daemon replaces the one that was sent. Anything else, including a non-200 that is not 404, is `daemon refused the decision` and is not journalled. 404 is `card not found` and is not journalled.

A successful decision is one row in `host_decisions`: the card id, the type (`question`, `series_plan`, `approval`), the status (`allow`, `deny`, `answered`, `cancelled`), the time, `decided_by`, and `relayed_by`. `relayed_by` is `static:<channel>` for the static bearer, or `<subject>:<channel>` where `<subject>` is the SHA-256 of the OAuth address already stored for that token. The address itself is not written. `list_decisions` returns those columns, newest first. `limit` is 1 to 100 and 50 when omitted. It does not call the daemon.

Answering does not write `host_pending_cards` and does not post the webhook. The next poll sees the card gone and emits `resolved` once, the same way a card that disappears for any other reason does.

### Answering a card by hand

Check to run later against a daemon when a mission is started on purpose. Not part of `npm test`, and it does not use a live Hermes.

1. Start the standalone host against the local daemon, with the static bearer or an OAuth client.
2. Start a mission that asks a question or raises a tool approval.
3. Read `list_pending`, or receive the `pending` webhook.
4. For a question or a kanban plan, call `answer_question`. For a tool approval, call `resolve_approval` with `allow` or `deny`. Do not send `scope`, `paste`, or a rewritten tool input.
5. `list_pending` no longer returns that id. The next poll emits `resolved` once. The mission continues.
6. `list_decisions` shows the card id, the type, the status the daemon accepted, `decided_by` (the account id from the daemon, or `daemon-token`), and `relayed_by` (the OAuth subject digest, or `static`, plus the channel). The address is not in that row.

Wiring this to Hermes on Telegram is a later step and needs an explicit go-ahead. It is not done here.

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
