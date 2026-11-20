# Free Claude Code Auto

Routes DeepSeek Harness turns through [Free Claude Code](https://github.com/Alishahryar1/free-claude-code)
and other free model providers, and keeps the turn alive when a model fails.

## What it adds

- A `FreeClaudeCode` provider with three routing modes in the model picker:
  **Auto (FreeClaudeCode)**, **FreeClaudeCode - Best Coding**, and
  **FreeClaudeCode - Fast / Subagent**.
- One selector entry per discovered model, taken from the fcc proxy catalog or
  from the provider keys in `~/.fcc/.env`.
- A zero-drop failover runner: HTTP errors, quota notices, first-token
  timeouts, stalled streams, premature closes, empty responses, and truncated
  tool calls switch models instead of failing the turn.
- Mid-stream continuation: text already shown to the user stays in the same
  block and the replacement model continues it.
- A circuit breaker (30 s → 2 min → 10 min for transient failures, 6 h for
  auth/quota/model-missing) with EWMA health ranking.
- A read-only status tool, the Settings connection page, and one log line per turn.

## How it behaves

The Harness sees one provider and a stream that always ends with one terminal
`finish` chunk. Underneath, the plugin tries candidates in ranked order. Nothing
visible is emitted until a fresh response passes a short degeneracy check, and
tool calls are held until their JSON is complete. When a stream dies after
visible text, the next model resumes the same text block through an assistant
prefill (Anthropic wire) or a continuation instruction (OpenAI wire).

If every candidate is cooling down, the router still attempts the least-cool one
rather than returning an error. It reports `NO_MODEL_AVAILABLE` only when no
provider key or model exists.

## Use it

1. Install the bundle and enable it.
2. Start Free Claude Code, or put at least one provider key in `~/.fcc/.env`.
3. Start a new session and select **Auto (FreeClaudeCode)**.
4. Ask `freeclaudecode_status` when you want the live pool and breaker state.

Open **Settings → FreeClaudeCode** to connect the harness to the proxy: set the
proxy URL and the fcc configuration directory, choose whether an installed
`fcc-server` starts automatically, then use **Test connection**, **Start
fcc-server**, **Refresh models**, or **Save connection**. The page shows the
live health dot, the advertised model count, and the ready/total pool. Provider
keys and the optional proxy token stay in `~/.fcc/.env`; the page never stores
or displays secrets.

## Limitations

- Text-only: images and files are projected to plain text by the Harness.
- The routing modes advertise a conservative context window; a request larger
  than every candidate's window ends with the provider's context error so the
  Harness can compact.
- Continuation is best-effort: the replacement may paraphrase the seam.
- Breaker state is in memory and resets when the Harness restarts.
- Free tiers change without notice; provider availability is not guaranteed by
  this plugin.
