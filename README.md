# Free Claude Code Auto for DeepSeek Harness

`dsh-freeclaudecode-auto` is a DeepSeek Harness (Cordis) bundle that integrates
[Free Claude Code](https://github.com/Alishahryar1/free-claude-code) (`fcc`) and
publishes a **zero-drop** model router in the Harness model selector.

The router treats a provider failure as a routing event, not as a turn result.
When a free model errors, exhausts its quota, times out, stalls mid-stream, or
returns a truncated tool call, the turn continues on another free model with no
error shown to the agent loop. Visible text that was already streamed is
continued on the replacement model instead of being thrown away.

- Provider route: `freeclaudecode`
- Selector modes: **Auto (FreeClaudeCode)**, **FreeClaudeCode - Best Coding**,
  **FreeClaudeCode - Fast / Subagent**, plus every model discovered from `fcc`
  or from your own provider keys
- Connection page: **Settings → FreeClaudeCode** — proxy URL, config directory,
  auto-start, test, start, refresh, and save
- Runtime dependencies: none (Node.js built-ins only)
- License: MIT

---

## Table of contents

- [Why this plugin](#why-this-plugin)
- [Architecture](#architecture)
- [Routing modes](#routing-modes)
- [The failover pipeline](#the-failover-pipeline)
- [Catalog discovery](#catalog-discovery)
- [Installation](#installation)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Observability](#observability)
- [Troubleshooting](#troubleshooting)
- [Compatibility and limitations](#compatibility-and-limitations)
- [Development](#development)
- [License](#license)

---

## Why this plugin

Free models are the cheapest way to keep an agent loop running, and the least
reliable part of it. A free endpoint may answer `429` after one request, drop a
stream halfway through, or return a plain-text quota notice with `HTTP 200`.
A stock provider adapter surfaces that as a failed turn: the agent stops, the
user sees an error, and the work that was already streamed is lost.

This bundle sits between the Harness `llm` service and the free backends:

```
		     DeepSeek Harness agent loop
		               │  ctx.llm.stream({ provider: 'freeclaudecode', … })
		               ▼
	     ┌──────────────────────────────────────────┐
	     │  dsh-freeclaudecode-auto                 │
	     │  ┌────────────┐   ┌───────────────────┐  │
	     │  │ router     │   │ attempt pipeline  │  │
	     │  │ (pool plan)│──▶│ watchdog + wire   │  │
	     │  └────────────┘   └─────────┬─────────┘  │
	     └─────────────────────────────│────────────┘
	                                   │  OpenAI Chat Completions or
	                                   │  Anthropic Messages
	               ┌───────────────────┼───────────────────┐
	               ▼                   ▼                   ▼
	        fcc local proxy      free provider A     free provider B
	       (127.0.0.1:8082)      (NVIDIA NIM)        (Groq, …)
```

The Harness only sees one provider and a stream that always ends with a terminal
`finish` chunk. Models are swapped underneath it.

## Architecture

| Layer | Module | Responsibility |
|---|---|---|
| Host entry | `index.js` | Resolves config, mounts the adapter, refreshes the catalog, registers the status tool and route |
| Adapter | `src/adapter.js` | Duck-typed `llm` adapter: provider metadata, model catalog, exact-model resolution, dispatch |
| Runner | `src/runner.js` | One turn across an ordered plan: watchdogs, continuation, block assembly, terminal chunk |
| Pool | `src/pool.js` | Candidate ranking, EWMA health, circuit breaker, retirement, last-resort plan |
| Wires | `src/wire/openai.js`, `src/wire/anthropic.js` | Request projection and SSE translation per protocol |
| Discovery | `src/fcc.js`, `src/providers.js` | `fcc` config/proxy/daemon, direct OpenAI-compatible providers |
| Failure model | `src/failure.js` | Stable failure facts and the reaction classification |
| Observability | `src/status.js` | Turn history, failover history, pool snapshot |
| Client | `src/client/index.js`, `client.js` | Settings connection page; it reads and writes through the plugin's own routes |

The adapter imports nothing from `@deepseek-ai/*`. The `llm` service validates a
registration through `providerInfo`/`providerRetryPolicy` and calls the adapter
methods, so a plain object satisfies the contract and the bundle cannot bind to
a particular Harness build. Harness-level retries are disabled for this route
(`maxRetries: 0`) because the runner already owns failover.

## Routing modes

| Selector entry | Model id | Preference order |
|---|---|---|
| Auto (FreeClaudeCode) | `auto` | coding → general → fast, health-adjusted |
| FreeClaudeCode - Best Coding | `best` | coding (tool-capable first) → general → fast |
| FreeClaudeCode - Fast / Subagent | `fast` | fast → general → coding |
| Discovered model | `fcc:<slug>` or `<provider>/<model>` | that model first, then the Auto order |

Ranking is a score, not a fixed list:

- tier weight for the selected mode,
- `+20` for verified native tool calling when the request declares tools,
- `+30 × EWMA success rate`,
- `− min(EWMA first-token latency / 600, 25)`,
- `− 12` per consecutive failure,
- `+1000 − index` for an entry in `preferredOrder`.

An explicit selection is always attempted first (unless it is retired), and a
failure after that selection falls back to the same pool.

## The failover pipeline

### 1. Attempt

Each candidate is called with a fresh `AbortController` and a merged signal
(user cancellation + watchdogs). The request is serialized by the wire module
that matches the candidate: `anthropic` for `fcc`, `openai` for direct providers.

### 2. Watchdogs

| Watchdog | Default | Behavior |
|---|---|---|
| Time to first byte | 8 s | Abort the socket when no SSE frame arrived; switch |
| Mid-stream stall | 12 s | Abort when no frame or heartbeat arrived since the last one; continue or switch |
| Whole request | 600 s | Abort a turn that never settles |

A one-shot `400` caused by `stream_options` is retried once on the same candidate
with the simplified body before the candidate is blamed.

### 3. Degenerate-response guard

Responses shorter than 160 characters are buffered before release. If the
response turns out to be a quota, rate-limit, or auth notice delivered with
`HTTP 200`, the attempt is discarded and the turn moves to the next model. A
legitimate short answer is released normally.

### 4. Tool-call integrity

Tool calls are buffered until complete and emitted as one `block-start`,
`tool-call-delta`, `block-end` triple after the stream succeeds. A truncated JSON
argument, an unnamed call, or a tool rejection (`400`, tool wording) never
reaches the Harness as a half-built call; the router switches to a tool-capable
candidate and keeps the rejected one for plain chat for 30 minutes.

### 5. Failure classification and breaker

| Observation | Reaction | Effect |
|---|---|---|
| `401`, `403` (auth wording) | `auth` | Retire the candidate for 6 h |
| `402`, quota wording, `403` (quota) | `quota` | Retire for 6 h |
| `404` | `missing` | Retire for 6 h |
| `429` | `rate` | Cooldown 30 s → 2 min → 10 min, honoring `Retry-After`, capped at 10 min |
| `400`/`413`/`422` with tool wording | `tool` | 2 min cooldown, tools disabled for 30 min |
| `400`/`413`/`422` otherwise | `rejected` | 10 min cooldown; a continuation-only rejection applies no cooldown |
| `408`, `409`, `5xx`, network, stall, TTFT, malformed/empty stream | `transient` | 30 s → 2 min → 10 min cooldown |
| Context-window overflow | `context` | **No failover**: the Harness owns compaction |
| User cancellation | `aborted` | No health penalty |

`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, and undici transport failures arrive
as `TRANSPORT` and take the transient path.

If every candidate is cooling down, the plan still attempts the one whose
cooldown ends soonest instead of failing the turn. The router gives up only when
no credential or no model exists, or when retirements leave nothing to try.

### 6. Mid-stream continuation

When a failure happens **after visible text was emitted**, the text block stays
open and the next model receives the partial answer:

- **Anthropic wire (`fcc`)** — the partial text is sent as an assistant prefill,
  which is the protocol's native continuation mechanism.
- **OpenAI wire** — the partial text is appended as an assistant message
  followed by a continuation instruction, and the replacement's deltas are
  appended to the same text block.

The user sees one continuous answer; the Harness sees one text block. If a
continuation also fails, the next candidate receives the updated partial text.
Continuation is best-effort by nature: a replacement may paraphrase the seam,
but it never restarts the task or surfaces a provider error.

When nothing visible was emitted yet, the partial attempt is discarded and the
next model starts from a clean state, so no duplicate preamble reaches the
conversation.

### 7. Terminal guarantees

Every turn ends with exactly one terminal `finish`. `usage` is emitted before
`finish`, tool calls are complete, no `block-start` is left unclosed, and no
recoverable provider error is propagated. A content-filter refusal is the one
recoverable outcome that may surface when text was already streamed.

## Catalog discovery

On startup, every 5 minutes, and after a failover, the catalog is rebuilt:

1. **fcc** — read `~/.fcc/.env`, probe `GET /v1/models?view=messages`, and add
   `MODEL`, `MODEL_OPUS`/`SONNET`/`HAIKU`/`FABLE`, and `MODEL_FALLBACKS` even when
   the listing omits them.
2. **Direct providers** — for each built-in provider with a key in the merged
   environment, call `GET /models` in parallel (4 s timeout). The published
   bootstrap list is used only when the endpoint does not answer.
3. **Merge** — a direct candidate is dropped when `fcc` advertises the same
   `provider/model` slug, because the proxy is the preferred route. The result
   replaces the pool; health history survives the refresh.

Non-chat entries are filtered out of every catalog: embedding, reranking,
guardrail, moderation, PII, translation, speech, OCR, and detector models are
never candidates, even when a provider lists them beside chat models.

When `fcc` is installed but not running and `autoStart` is enabled, the plugin
spawns only a `fcc-server` executable (never an agent CLI), detached with
`stdio: 'ignore'` and its own copy of the environment. It never edits
`~/.fcc/.env`, `ANTHROPIC_BASE_URL`, or any global variable.

## Installation

### From a custom plugin index (recommended)

1. Open **Plugins → Discover** in the DeepSeek Harness Web GUI.
2. Add this index URL:

   ```
   https://raw.githubusercontent.com/luciomerlo/dsh-freeclaudecode-auto/main/index.json
   ```

3. Install **Free Claude Code Auto** from the entry, then start a new session
   and select **Auto (FreeClaudeCode)** in the model picker.

### Manual local build

```bash
git clone https://github.com/luciomerlo/dsh-freeclaudecode-auto.git
cd dsh-freeclaudecode-auto
npm run build     # regenerates client.js, validates locales
npm test          # 46 tests, no network required
```

Then in DeepSeek Harness open **Plugins → Add plugin**, choose the cloned
directory, and enable the bundle. A directory install links the checkout, so
edits to the source are picked up after a Harness reload.

### Verify

- The model picker lists **Auto (FreeClaudeCode)** under the `FreeClaudeCode`
  provider.
- **Settings → FreeClaudeCode** shows the connection state and lets you change
  the proxy URL, the config directory, and auto-start.
- `freeclaudecode_status` (model tool) returns the pool snapshot.
- **Settings → FreeClaudeCode** shows the connection state and the ready/total
  pool, and exposes the test, start, refresh, and save actions.

## Connect from Settings

Open **Settings → FreeClaudeCode**. The page shows the live health dot, the
number of models the proxy advertises, and the ready/total pool.

| Field | Meaning |
|---|---|
| Connect through the Free Claude Code proxy | Turns the `fcc` integration on or off; off leaves only direct providers |
| Proxy URL | Root of the local proxy, default `http://127.0.0.1:8082` |
| Configuration directory | Where fcc stores `.env` and its database, default `~/.fcc` |
| Start fcc-server automatically | Starts an installed `fcc-server` when the proxy is down |

Actions:

- **Test connection** probes the proxy now and reports the advertised model count.
- **Start fcc-server** launches the installed daemon in the background, then refreshes the catalog.
- **Refresh models** rebuilds the pool immediately instead of waiting for the five-minute cycle.
- **Save connection** writes the values to the plugin's own profile row through
  the Harness config editor and restarts the plugin. A host without the config
  editor reports that saving is unavailable instead of pretending.

Provider keys and the optional proxy token are never entered on this page: they
stay in the fcc environment file (`~/.fcc/.env`), which the plugin reads for both
the proxy and the direct providers. The page never stores or displays secrets.

## Configuration

Every key below is an ordinary Cordis row config. Override any of them from the
profile's `cordis.patch.yml` using the row id `llm-freeclaudecode`; a matching
row replaces the whole config, so copy the keys you need.

| Key | Default | Meaning |
|---|---|---|
| `providerId` | `freeclaudecode` | Provider route key (lowercase, digits, `.`, `-`, `_`) |
| `providerName` | `FreeClaudeCode` | Display name in selectors |
| `autoModelId` | `auto` | Model id of the Auto mode |
| `autoModelName` | `Auto (FreeClaudeCode)` | Label of the Auto mode |
| `bestModelName` | `FreeClaudeCode - Best Coding` | Label of the coding profile |
| `fastModelName` | `FreeClaudeCode - Fast / Subagent` | Label of the fast profile |
| `fcc.enabled` | `true` | Use the fcc proxy at all |
| `fcc.directory` | `~/.fcc` | Where fcc stores `.env` |
| `fcc.baseUrl` | `http://127.0.0.1:8082` | fcc proxy root |
| `fcc.autoStart` | `true` | Start an installed `fcc-server` when it is down |
| `fcc.startupTimeoutMs` | `20000` | How long to wait for a started daemon |
| `fcc.probeTimeoutMs` | `1500` | Probe timeout |
| `fcc.binary` | `''` | Explicit `fcc-server` path, bypassing PATH discovery |
| `fcc.envFile` | `''` | Explicit env file instead of `<directory>/.env` |
| `ttftTimeoutMs` | `8000` | First-byte deadline |
| `stallTimeoutMs` | `12000` | Mid-stream stall deadline |
| `maxFailovers` | `8` | Maximum candidates per turn |
| `requestTimeoutMs` | `600000` | Whole-request deadline |
| `continuation` | `true` | Continue visible text on the next model |
| `autoContextWindow` | `131072` | Reported context for the routing modes |
| `autoMaxTokens` | `32768` | Reported output cap for the routing modes |
| `directProviders.enabled` | `true` | Reach providers directly when fcc is down |
| `extraProviders` | `[]` | Custom OpenAI-compatible endpoints |
| `preferredOrder` | `[]` | Catalog ids to rank first |
| `disabledModels` | `[]` | Catalog ids to exclude |
| `refreshCatalogOnFailover` | `true` | Rebuild the catalog after a failure |
| `logTurns` | `true` | Log one line per served turn |
| `statusRoute` | `true` | Expose the read-only status route |

### Custom providers

```yaml
- id: llm-freeclaudecode
  name: dsh-freeclaudecode-auto
  config:
    extraProviders:
      - id: my-gateway
        label: My Gateway
        baseUrl: https://gateway.example/v1
        apiKeyEnv: MY_GATEWAY_KEY
        wire: openai           # or anthropic
        models: [my-coder-1]
        contextWindow: 65536
        maxTokens: 8192
        tier: coding
        tools: true
        headers:
          x-tenant: example
```

Keys are read from `apiKeyEnv`, never from the patch file.

## Authentication

- **fcc proxy** — no token by default. When Proxy Authentication is enabled,
  the proxy token is read from `ANTHROPIC_AUTH_TOKEN` in `~/.fcc/.env` and sent
  as both `x-api-key` and `Authorization: Bearer`.
- **Direct providers** — keys come from the process environment first, then
  from `~/.fcc/.env`, so one file configures both fcc and this plugin.
- **ChatGPT / Copilot OAuth** — these credentials stay inside fcc; select the
  corresponding `fcc:` model and the proxy owns authentication.

The plugin never writes credentials, never prints a key, and the status route
reports only booleans (`authenticated`, `available`) and model metadata.

## Observability

- **Log line** per served turn:

  ```
  freeclaudecode: Auto (FreeClaudeCode) served by fcc:groq/llama-3.3-70b-versatile
  in 1840ms (ttft 220ms, failovers 1, pool 23)
  ```

- **`freeclaudecode_status` tool** — pool counts, per-candidate breaker state,
  last 10 turns, and last 10 failovers. Pass `includeCandidates: true` for the
  full catalog.
- **Settings page** — health dot, advertised model count, ready/total pool, and
  the connection actions described above.
- **Read-only status route** — `GET /plugin/freeclaudecode/status` returns the
  same public summary for a local client.
- **Failure reasons** — each candidate keeps the last failure code and message,
  truncated, so a stalled pool is diagnosable without reading Harness logs.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `NO_MODEL_AVAILABLE` on every turn | fcc is down and no direct key is set | Start Free Claude Code, or add a key to `~/.fcc/.env`, then wait for the 5-minute refresh or restart the session |
| Settings page says `offline`, `pool 0` | Same as above | Same as above |
| Every candidate `retired` for 6 h | All keys were rejected once (`401`/`402`) | Fix or replace the key; restart the Harness to clear the in-memory retirement |
| Turns switch models constantly | Free pools are rate-limited | Add a second provider key, or select `Best Coding` |
| `context` error, no failover | Request exceeds the selected model's window | Let the Harness compact, or select a model with a larger window |
| Settings page missing | Not running the Web host | Use the status tool instead |
| fcc starts but models are missing | Model listing is empty | Set `MODEL` in `~/.fcc/.env` or pick a model in fcc Admin |

## Compatibility and limitations

- DeepSeek Harness with the `llm` service (0.2.x line).
- Node.js 22+; no runtime npm dependencies.
- Text-only route: image attachments are projected to placeholders by the
  Harness before dispatch. File references become handle text.
- The routing modes advertise a conservative context window
  (`autoContextWindow`). A candidate whose advertised window is smaller than the
  estimated request is skipped; if every candidate is too small, the turn ends
  with the provider's context error so compaction can run.
- Continuation is a best-effort seam, not a byte-exact resume.
- Reasoning efforts are not advertised for the free catalog, so the Harness does
  not attach an effort the provider might reject.
- The in-memory breaker state is per profile process and resets on restart.

## Development

```bash
npm run build   # generate client.js from src/client/index.js
npm test        # node:test suite with local mock SSE servers
npm run check   # syntax-check the host and client artifacts
```

The tests cover `429`/`503`/`401` failover, TTFT timeout, mid-stream stall with
continuation, streams closed without a finish reason, degenerate `200` notices,
truncated tool-call JSON, empty responses, exhaustion, context-window handling,
both wire protocols, pool ranking, breaker timing, config parsing, and the host
mount.

## License

MIT © 2026 luciomerlo

Free Claude Code is an independent project, not affiliated with this plugin.
Claude and Claude Code are trademarks of Anthropic.
