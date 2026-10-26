// arilo-stream-retry: continue the run when a provider stream dies with an
// error omp's own retry engine cannot classify.
//
// Root cause (verified against omp 18.12.6 binary, 2026-10-27): the arilo
// gateway (models.yml, https://api.arilo.id/v1) ends SSE streams with an
// error event whose message text is "[arilo] stream error". omp's error
// classifier (packages/ai/src/error/provider.ts) matches that text against
// NO transient pattern — "stream error" alone is not "stream read error"
// (A9t), not "stream error.*received from peer" (the TLS regex), and matches
// nothing in the big transient set (q4e). So TurnRecovery.isRetryableError()
// returns false: no auto-retry, no backoff, the turn dies with
// "✘ [arilo] stream error" and the thinking tokens already paid for are
// discarded.
//
// This extension adds the missing classification at the session layer, on
// the surface omp already provides for it: the `session_stop` hook, which
// fires on every settle INCLUDING error turns and honors an advisory
// `{ continue: true, additionalContext }` (capped at 8 continuations per run
// by the host). On a failed turn whose message matches the retryable set,
// the hook continues the run with a short developer-voice note. omp's own
// auto-retry (429/5xx/etc.) is untouched: those turns never settle as
// stopReason="error" while the retry engine is still working.
//
// Update-safety: the hook relies only on the documented `session_stop`
// contract (events fire on error settles, advisory `{ continue: true }`,
// 8-continuation cap) and on `event.last_assistant_message` /
// `event.messages`, all part of the extension event surface. If a future
// omp release changes the payload shape, every access below is defensive and
// the extension degrades to "never continues" instead of erroring.

interface AssistantMessageLike {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

function isAssistantLike(value: unknown): value is AssistantMessageLike {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as AssistantMessageLike).role === "assistant"
	);
}

function messageText(message: AssistantMessageLike): string {
	const text = message.errorMessage;
	return typeof text === "string" ? text : "";
}

function lastAssistantOf(event: unknown): AssistantMessageLike | undefined {
	if (!event || typeof event !== "object") return undefined;
	const shape = event as {
		last_assistant_message?: unknown;
		messages?: unknown;
	};
	if (isAssistantLike(shape.last_assistant_message)) {
		return shape.last_assistant_message;
	}
	const messages = shape.messages;
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isAssistantLike(messages[i])) {
			return messages[i];
		}
	}
	return undefined;
}

/** Extension default: the opaque gateway stream failure plus the generic
 * transient shapes a gateway may start emitting once it forwards upstream
 * error text. Matches plain "stream error" (the observed payload) and the
 * stalled/closed/disconnected forms. omp already classifies and retries the
 * 429/5xx wording itself; those turns never reach here as stopReason
 * "error" while the retry engine is alive, and if they do (budget
 * exhausted) a continuation is the right call anyway. */
const DEFAULT_PATTERN =
	/\bstream error\b|\bstream[_ -]?read[_ -]?error\b|\bstream stalled\b|\bstream closed before\b|\bstream (?:disconnected|ended|interrupted)\b/i;

/** Extra patterns from env, ORed with the default. Empty/unset = default only. */
function extraPatternFromEnv(): RegExp | undefined {
	const raw = process.env.OMP_STREAM_RETRY_EXTRA_PATTERN;
	if (!raw) return undefined;
	try {
		return new RegExp(raw, "i");
	} catch {
		return undefined;
	}
}

const MAX_AUTO_CONTINUES = 3;
/** Reset the per-run counter when the run has been healthy for this long. */
const COUNTER_RESET_MS = 10 * 60_000;

interface ExtensionApi {
	on: (event: string, handler: (event: unknown) => unknown) => void;
}

export default function (pi: unknown) {
	const api = pi as ExtensionApi;
	const extra = extraPatternFromEnv();
	const pattern = extra
		? new RegExp(`${DEFAULT_PATTERN.source}|${extra.source}`, "i")
		: DEFAULT_PATTERN;

	let continues = 0;
	let lastProgressAt = Date.now();

	api.on("agent_start", async () => {
		// A run starting long after the last continuation resets the cap, so a
		// fresh work session gets a full budget rather than inheriting a dead
		// one from hours ago.
		if (Date.now() - lastProgressAt > COUNTER_RESET_MS) {
			continues = 0;
		}
	});

	api.on("session_stop", async (event: unknown) => {
		const assistant = lastAssistantOf(event);
		if (!assistant) return;

		// Gate 1: only a FAILED turn. Healthy settles are the counter reset.
		if (assistant.stopReason !== "error") {
			lastProgressAt = Date.now();
			return;
		}

		const text = messageText(assistant);
		if (!text || !pattern.test(text)) return;

		// Gate 2: caller aborts are never ours to revive.
		if (/\babort/i.test(text)) return;

		// Gate 3: bounded. A run that keeps dying instantly must not loop
		// forever (the host's own cap is 8 per prompt; ours is tighter and
		// counts across prompts within the reset window).
		if (continues >= MAX_AUTO_CONTINUES) {
			continues = 0; // give the next run a fresh budget rather than a dead one
			return;
		}
		continues += 1;
		lastProgressAt = Date.now();

		return {
			continue: true,
			additionalContext: `The previous turn failed with a provider stream error (${text.trim()}). The failure was transient and nothing of that turn was kept. Continue the interrupted work from where the conversation left off; do not re-do completed tool calls, do not mention this note.`,
		};
	});
}
