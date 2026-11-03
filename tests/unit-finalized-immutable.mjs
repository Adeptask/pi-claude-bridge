/**
 * Query teardown never rewrites a turn pi already has (issue #181).
 *
 * A turn that ends on a tool call returns its assistant message to pi while
 * Claude Code's query stays parked. pi records that object by reference, so
 * failing it from a later abort, SDK exception or error result changed pi's
 * live copy to aborted/error while the session file kept toolUse. A later
 * Codex/Responses conversion then dropped the failed assistant and kept its
 * tool result, leaving a function_call_output with no function_call.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, getSharedSession, activeQueryContexts } = mod.__test;
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const ev = (event) => ({ type: "stream_event", event });
const toolUse = [
	ev({ type: "message_start", message: { id: "msg_tool", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const textStart = [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
];
const errorResult = { type: "result", subtype: "success", is_error: true, result: "API Error: Overloaded" };
// Claude Code runs a steer it had queued even after an error result.
const steerTurn = [
	{ type: "user", parent_tool_use_id: null, isReplay: true, uuid: "steer", message: { role: "user", content: "steer" } },
	ev({ type: "message_start", message: { id: "msg_steer", usage: {} } }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	{ type: "result", subtype: "success", is_error: false, result: "done" },
];
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

// Streams `steps`, parks until released (by close() or `release`), then runs `after`.
// `parked` resolves once `steps` are consumed; `settled` once teardown has finished.
let release, parked, settled;
function parkingQuery(steps, after = async function* () {}, onQuery = () => {}) {
	let park, settle;
	parked = new Promise((r) => { park = r; });
	settled = new Promise((r) => { settle = r; });
	setQuery(({ prompt, options }) => {
		onQuery(options);
		const gate = new Promise((r) => { release = r; });
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume };
			yield* steps;
			park();
			await gate;
			yield* after();
		})();
		gen.interrupt = async () => {};
		// Teardown closes the query last, after unregistering it; an abort also
		// closes it earlier, while it is still registered.
		gen.close = () => {
			release();
			if (activeQueryContexts.size === 0) settle();
		};
		return gen;
	});
}

const lateFailures = {
	"an abort": { end: (controller) => controller.abort(), stopReason: "aborted" },
	"an SDK exception": { after: async function* () { throw new Error("CLI exited"); }, end: () => release(), stopReason: "error", errorText: "CLI exited" },
	"an error result": { after: async function* () { yield errorResult; yield* steerTurn; }, end: () => release(), stopReason: "error", errorText: "API Error: Overloaded" },
};

// Session events arrive through another copy while the original provider serves.
const ownerCopy = await import("../src/index.js?late-failure-owner");
const handlers = new Map();
ownerCopy.default({
	on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	registerProvider: () => {},
	registerTool: () => {},
});
const sessions = new Set();
function sessionEvent(event, sessionId, hasUI = false, notify = () => {}) {
	for (const handler of handlers.get(event) ?? []) handler({ reason: "startup" }, {
		cwd: process.cwd(), hasUI, ui: { notify }, mode: hasUI ? "tui" : "print",
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: { getProvider: () => ({}) },
	});
	if (event === "session_start") sessions.add(sessionId);
}

let session = 0;
function run(steps, failure, messages = [{ role: "user", content: "go", timestamp: 1 }], owner = {}) {
	parkingQuery(steps, failure.after);
	const controller = new AbortController();
	const piSessionId = `pi-finalized-${session++}`;
	sessionEvent("session_start", piSessionId, owner.hasUI, owner.notify);
	const stream = streamSimple(model, { messages, tools }, { sessionId: piSessionId, signal: controller.signal });
	return { stream, controller, piSessionId };
}

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
});

afterEach(() => {
	setQuery(null);
	for (const id of sessions) sessionEvent("session_shutdown", id);
	sessions.clear();
});

describe("a turn finalized on a tool call", () => {
	for (const [name, failure] of Object.entries(lateFailures)) {
		for (const channel of ["UI", "print", "throwing UI"]) {
			it(`is unchanged after ${name} with a ${channel} owner`, async (t) => {
				const errors = [], writes = [], notifications = [], siblingNotifications = [];
				t.mock.method(console, "error", (...args) => { errors.push(args); });
				t.mock.method(process.stderr, "write", (chunk) => { writes.push(String(chunk)); return true; });
				const { stream, controller, piSessionId } = run(toolUse, failure, undefined, {
					hasUI: channel !== "print",
					notify: (...args) => {
						notifications.push(args);
						if (channel === "throwing UI") throw new Error("UI unavailable");
					},
				});
				const done = await stream.result();
				assert.equal(done.stopReason, "toolUse");
				const snapshot = structuredClone(done);
				// Replace both copies' global UI links while this owner's query is parked.
				const siblingNotify = (...args) => siblingNotifications.push(args);
				sessionEvent("session_start", "pi-ui-sibling", true, siblingNotify);
				mod.__test.setPiUI({ notify: siblingNotify });

				failure.end(controller);
				await settled;

				assert.deepStrictEqual(done, snapshot);
				assert.deepEqual(siblingNotifications, [], "never notify the last UI adopter");
				if (failure.errorText) {
					assert.equal(notifications.length, channel === "print" ? 0 : 1);
					if (notifications.length) assert.equal(notifications[0][1], "error");
					for (const [report] of notifications) {
						assert.ok(report.includes(failure.errorText), "report the original error text");
						assert.ok(report.includes(piSessionId), "identify the failed session");
					}
				} else {
					assert.deepEqual(notifications, [], "a user abort needs no notification");
				}

				if (failure.errorText && channel === "print") {
					let resumeOptions;
					parkingQuery([
						...textStart,
						ev({ type: "content_block_stop", index: 0 }),
						ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
						ev({ type: "message_stop" }),
						{ type: "result", subtype: "success", is_error: false, result: "partial" },
					], undefined, (options) => { resumeOptions = options; });
					const toolResult = {
						role: "toolResult", toolCallId: "toolu_1", toolName: "read",
						content: [{ type: "text", text: "file contents" }], timestamp: 3,
					};
					const next = streamSimple(model, {
						messages: [{ role: "user", content: "go", timestamp: 1 }, done, toolResult], tools,
					}, { sessionId: piSessionId });
					await parked;
					release();
					const reply = await next.result();
					await settled;
					assert.equal(reply.stopReason, "stop", "the next call recovers without a provider error");
					assert.ok(resumeOptions.resume, "recovery resumes a Claude Code session");
					assert.equal(resumeOptions.sessionId, undefined, "recovery does not launch a fresh session");
					assert.deepStrictEqual(done, snapshot, "recovery leaves the published message unchanged");
					assert.deepEqual(notifications, []);
				}
				assert.deepEqual(errors, [], "late failures never call console.error");
				assert.deepEqual(writes, [], "late failures never write to stderr");
				assert.deepEqual(siblingNotifications, [], "recovery never notifies a sibling");
			});
		}
	}
});

it("releases UI ownership on shutdown and on a UI-less session start", () => {
	const registry = globalThis[Symbol.for("claude-bridge:sessionUIs")];
	const id = "pi-ui-lifecycle";
	const sibling = "pi-ui-retained";
	sessionEvent("session_start", id, true);
	sessionEvent("session_start", sibling, true);
	assert.ok(registry.has(id));
	sessionEvent("session_start", id, false);
	assert.equal(registry.has(id), false);
	sessionEvent("session_start", id, true);
	sessionEvent("session_shutdown", id);
	assert.equal(registry.has(id), false);
	assert.ok(registry.has(sibling), "a sibling UI remains registered");
});

describe("a turn still streaming", () => {
	for (const [name, failure] of Object.entries(lateFailures)) {
		it(`reports ${name}`, async () => {
			const { stream, controller } = run(textStart, failure);
			await parked;

			failure.end(controller);
			const reply = await stream.result();
			await settled;

			assert.equal(reply.stopReason, failure.stopReason);
			assert.ok(reply.errorMessage);
		});
	}
});

it("does not publish an imported mirror before any complete assistant progress", async () => {
	const messages = [
		{ role: "user", content: "previous prompt", timestamp: 1 },
		{
			role: "assistant", content: [{ type: "text", text: "previous answer" }],
			api: model.api, provider: model.provider, model: model.id, stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: 2,
		},
		{ role: "user", content: "go", timestamp: 3 },
	];
	const { stream, piSessionId } = run(textStart, lateFailures["an error result"], messages);
	await parked;
	assert.equal(getSharedSession(piSessionId), null, "import seed stays query-local until assistant progress");

	release();
	await stream.result();
	await settled;

	assert.equal(getSharedSession(piSessionId), null);
});
