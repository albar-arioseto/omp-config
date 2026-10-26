# omp-config

Versioned omp agent configuration for this machine: the pieces that survive
omp updates because they live outside the binary — custom providers and
runtime extensions.

## Layout

```
extensions/
  arilo-stream-retry.ts   # auto-retry for gateway stream errors omp cannot classify
models.example.yml        # custom gateway providers (secret kept in env, never here)
```

Install by copying (or symlinking) into the agent directory omp reads:

```
~/.omp/agent/extensions/     # auto-discovered .ts extensions
~/.omp/agent/models.yml      # custom providers; apiKey values come from env
```

## arilo-stream-retry

**Problem.** A gateway stream that dies mid-flight surfaces as
`✘ [provider] stream error` and the turn stops. omp's own auto-retry
(`retry.enabled`, default 10 attempts with backoff) does **not** engage,
because its error classifier matches the message text against a fixed set of
transient patterns — `stream error` alone is not `stream read error`, not
`stream error.*received from peer` (TLS), and matches nothing in the big
overloaded/rate-limit/network set. Unclassifiable → `isRetryableError()`
returns false → the turn dies and the thinking already paid for is discarded.

**Fix.** The extension registers omp's `session_stop` hook, which fires on
every settle *including* failed turns and honors an advisory
`{ continue: true, additionalContext }` (host-capped at 8 per run). When the
last assistant message has `stopReason === "error"` and its text matches a
stream-failure pattern, the hook continues the run with a short note telling
the model to resume the interrupted work.

**Guards.**

- only `stopReason === "error"` turns trigger it; healthy settles reset the
  staleness clock instead
- caller aborts are never revived (`/abort/i` gate)
- own cap of 3 continuations, reset after 10 quiet minutes — a run that dies
  instantly in a loop gets 3 free retries, then stops
- every payload access is defensive: a future omp that changes the
  `session_stop` event shape makes the extension a no-op, never an error

**Tuning.**

| Env var | Effect |
|---|---|
| `OMP_STREAM_RETRY_EXTRA_PATTERN` | extra regex (case-insensitive) ORed with the built-in pattern |
| cap / reset window | constants at the top of the file (`MAX_AUTO_CONTINUES`, `COUNTER_RESET_MS`) |

**Update-safety.** Depends only on the documented `session_stop` contract
(fires on error settles, advisory continue, 8-continuation cap) and the
`agent_start` event. Verified against omp 18.12.6; designed to degrade
silently on later releases rather than break the session.

## Root-cause record (omp 18.12.6, 2026-10-27)

The error path, verified in the binary:

1. gateway SSE ends with an `error` event whose message text is
   `[arilo] stream error` (the `[arilo]` prefix is the gateway's own;
   its 429s carry the same prefix)
2. omp's provider wrapper finalizes the message through the AI-error
   classifier; with no HTTP status attached (the failure is in-band), the
   classification is text-only
3. the text matches none of the transient patterns → errorId 0
4. `TurnRecovery.isRetryableError()` requires a retryable classification →
   false → no retry chain, turn settles as failed

The real fix is on the gateway side (forward upstream error text and status;
emit SSE keepalives during long thinking stretches so nothing in front of the
model times it out). This extension is the client-side safety net.

## Install

```bash
cp extensions/arilo-stream-retry.ts ~/.omp/agent/extensions/
# restart omp sessions; verify with any long thinking-heavy turn
```
