const STATE = Symbol.for("claude-bridge:test-sdk-state");

function state() {
	return globalThis[STATE] ??= { calls: [], releases: new Map() };
}

async function promptText(prompt) {
	if (typeof prompt === "string") return prompt;
	const first = await prompt[Symbol.asyncIterator]().next();
	const content = first.value?.message?.content ?? first.value?.content ?? [];
	return Array.isArray(content) ? content.map((block) => block.text ?? "").join("") : String(content);
}

function assistant(sessionId, content) {
	return {
		type: "assistant",
		message: {
			model: "claude-sonnet-5", id: `msg-${sessionId}`, type: "message", role: "assistant", content,
			stop_reason: null, stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		parent_tool_use_id: null, session_id: sessionId, uuid: `assistant-${sessionId}`,
	};
}

export function query({ prompt, options }) {
	let closed = false;
	const call = { options, marker: undefined, sessionId: undefined, release: undefined };
	state().calls.push(call);
	const iterable = (async function* () {
		const marker = await promptText(prompt);
		const sessionId = options.resume ?? `sdk-${marker.replace(/[^A-Za-z0-9]/g, "-")}`;
		call.marker = marker;
		call.sessionId = sessionId;
		yield {
			type: "system", subtype: "init", session_id: sessionId, tools: [], mcp_servers: [], model: "claude-sonnet-5",
			permissionMode: "bypassPermissions", uuid: `init-${sessionId}`,
		};
		if (marker.includes("tool")) {
			yield assistant(sessionId, [{ type: "tool_use", id: `tool-${marker}`, name: "mcp__custom-tools__read", input: { path: marker } }]);
		}
		await new Promise((resolve) => {
			call.release = resolve;
			state().releases.set(marker, resolve);
		});
		if (closed) return;
		yield assistant(sessionId, [{ type: "text", text: `answer:${marker}` }]);
		yield { type: "result", subtype: "success", result: `answer:${marker}`, session_id: sessionId, uuid: `result-${sessionId}`,
			is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} };
	})();
	return Object.assign(iterable, {
		interrupt: async () => {},
		close: () => { closed = true; call.release?.(); },
	});
}

export const __fakeSdkState = state;
