/**
 * Session-scoped routing and lifecycle state. One pi process serves a host and
 * worker sessions (Slate) through the host's provider, while a worker's lifecycle
 * events may run in another copy of this module. Tool-call ids are not unique
 * across sessions, so every check here is per pi session.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCtx } from "../src/query-state.js";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-session-scoped-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const PROVIDER_ID = "claude-bridge";
const SERVING_MARKER = Symbol.for("claude-bridge:activeStreamSimple");

const mod = await import("../src/index.js");
const {
	setQuery, resetSharedSession, setSharedSession, getSharedSession, activeQueryContexts,
	historyRewrittenBySession, markRebuildForSession, isQueryAbandoned, reportLeaks, getPiLink,
} = mod.__test;

// pi appends handlers per event, so the mock does too.
function activateWithMockPi(activate) {
	const handlers = new Map();
	let providerConfig;
	activate({
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerProvider: (_name, config) => { providerConfig = config; },
		registerTool: () => {},
	});
	const emit = (event, ...args) => { for (const handler of handlers.get(event) ?? []) handler(...args); };
	return { emit, providerConfig };
}

// The host activation: the first one, so it registers the provider and owns the marker.
const hostPi = activateWithMockPi(mod.default);
const streamSimple = hostPi.providerConfig.streamSimple;
const model = hostPi.providerConfig.models[0];

const sessionCtx = (sessionId, { hasUI = false, ui = { notify() {} }, mode = "print" } = {}) => ({
	cwd: process.cwd(), hasUI, ui, mode,
	sessionManager: { getSessionId: () => sessionId },
	modelRegistry: { getProvider: (id) => (id === PROVIDER_ID ? { name: id } : undefined) },
});

const calls = [];
const scripts = [];
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const text = (t) => [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const result = (t) => ({ type: "result", subtype: "success", is_error: false, result: t });

let clock = 0;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const asst = (content, stopReason) => ({ role: "assistant", content, api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus", usage, stopReason, timestamp: clock++ });
const toolCall = (id) => asst([{ type: "toolCall", id, name: "read", arguments: { path: "a" } }], "toolUse");
const toolResult = (id, t = "file") => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: t }], isError: false, timestamp: clock++ });
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const settle = () => new Promise((r) => setTimeout(r, 20));
const replyText = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("");

const H = "pi-host", W = "pi-worker";
const controllers = [];
const liveSignal = () => { const c = new AbortController(); controllers.push(c); return c.signal; };
// Pi's shape for a cancelled call: the signal is already aborted.
const cancelledSignal = () => { const c = new AbortController(); c.abort(); return c.signal; };

/** Start a turn for `sessionId` that parks at tool call `toolId`. */
async function park(sessionId, toolId, signal = liveSignal()) {
	scripts.push({ label: `park ${sessionId}`, steps: [init(`cc-${sessionId}`), ...toolUse(toolId), (killed) => killed] });
	const ask = user(`task for ${sessionId}`);
	const reply = await streamSimple(model, { messages: [ask], tools }, { sessionId, signal }).result();
	assert.equal(reply.stopReason, "toolUse", "precondition: the query parked at the tool call");
	const c = [...activeQueryContexts].find((q) => q.piSessionId === sessionId && q.activeQuery);
	assert.ok(c, "precondition: the parked query is in the routing set");
	return { c, history: [ask, reply] };
}

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	resetCtx();
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		const call = { label: script.label, resume: options.resume, closed: false };
		calls.push(call);
		let onClose;
		const killed = new Promise((r) => { onClose = r; });
		const gen = (async function* () {
			call.prompt = (await prompt[Symbol.asyncIterator]().next()).value.message.content[0].text;
			for (const step of script.steps) {
				if (call.closed) return;
				if (typeof step === "function") { await step(killed); continue; }
				yield options.resume && step.type === "system" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => { call.closed = true; onClose(); };
		return gen;
	});
});

afterEach(async () => {
	for (const c of controllers.splice(0)) c.abort();
	await settle();
	setQuery(null);
});

describe("tool-result routing", () => {
	for (const order of [[W, H], [H, W]]) {
		it(`sends each result only to its own session's query when both park on one id (${order[0]} delivers first)`, async () => {
			const parked = { [H]: await park(H, "toolu_same"), [W]: await park(W, "toolu_same") };

			for (const sessionId of order) {
				streamSimple(model, { messages: [...parked[sessionId].history, toolResult("toolu_same", `${sessionId} file`)], tools },
					{ sessionId, signal: liveSignal() });
			}

			assert.equal(parked[H].c.pendingResults.get("toolu_same")?.content[0].text, `${H} file`);
			assert.equal(parked[W].c.pendingResults.get("toolu_same")?.content[0].text, `${W} file`);
			assert.equal(calls.length, 2, "a delivered result starts no query");
		});
	}

	it("leaves a host query marked for rebuild untouched by a worker's cancelled call on the same id", async () => {
		const host = await park(H, "toolu_same");
		const hostQuery = host.c.activeQuery;
		markRebuildForSession(H, "session_compact:threshold");
		assert.equal(host.c.historyStale, true, "precondition: the host query is armed for discard");

		const reply = await streamSimple(model, { messages: [user("w"), toolCall("toolu_same"), toolResult("toolu_same")], tools },
			{ sessionId: W, signal: cancelledSignal() }).result();

		assert.equal(reply.stopReason, "stop");
		assert.equal(replyText(reply), "", "the worker call ends empty");
		assert.equal(calls.length, 1, "no query starts");
		assert.ok(activeQueryContexts.has(host.c), "the host query is still routable");
		assert.equal(host.c.activeQuery, hostQuery);
		assert.equal(isQueryAbandoned(hostQuery), false, "the host query was not discarded");
		assert.equal(host.c.historyStale, true, "its own rebuild mark stays for its own result");
		assert.equal(host.c.pendingResults.size, 0, "nothing was delivered into it");
	});

	it("ends a cancelled call that arrives after the abort but before the context leaves the routing set", async () => {
		const controller = new AbortController();
		const host = await park(H, "toolu_a", controller.signal);
		controller.abort();
		assert.ok(activeQueryContexts.has(host.c), "precondition: the killed query has not finished yet");

		const late = streamSimple(model, { messages: [...host.history, toolResult("toolu_a")], tools },
			{ sessionId: H, signal: controller.signal });

		assert.equal(host.c.pendingResults.size, 0, "nothing is delivered into the aborting query");
		assert.notEqual(host.c.currentPiStream, late, "the aborting query does not claim the stream");
		const reply = await late.result();
		assert.equal(reply.stopReason, "stop", "the turn ends");
		assert.equal(replyText(reply), "");
		assert.equal(calls.length, 1, "no query starts");
	});

	it("closes a parked query when its run signal aborts, with no further provider call", async () => {
		const controller = new AbortController();
		const worker = await park(W, "toolu_w", controller.signal);

		controller.abort();
		await settle();

		assert.equal(calls[0].closed, true, "the query was closed");
		assert.equal(activeQueryContexts.has(worker.c), false, "the context left the routing set");
		assert.equal(calls.length, 1, "no further query");
	});

	it("handles late results per session: cancelled ends empty, uncancelled resumes only its own conversation", async () => {
		// The worker's earlier turn gives it a conversation of its own.
		scripts.push({ label: "worker turn 1", steps: [init("cc-w"), ...text("hi"), result("hi")] });
		const u1 = user("first"), a1 = asst([{ type: "text", text: "hi" }], "stop");
		await streamSimple(model, { messages: [u1], tools }, { sessionId: W, signal: liveSignal() }).result();
		assert.equal(getSharedSession(W).sessionId, "cc-w");
		const host = await park(H, "toolu_same");
		const late = [u1, a1, user("second"), toolCall("toolu_same"), toolResult("toolu_same", "worker file")];

		const cancelled = await streamSimple(model, { messages: late, tools }, { sessionId: W, signal: cancelledSignal() }).result();
		assert.equal(replyText(cancelled), "", "the cancelled late result ends empty");
		assert.equal(calls.length, 2, "and starts no query");

		scripts.push({ label: "worker resumed", steps: [init("cc-other"), ...text("worker resumed"), result("worker resumed")] });
		const resumed = await streamSimple(model, { messages: late, tools }, { sessionId: W, signal: liveSignal() }).result();
		assert.equal(calls.length, 3, "the uncancelled late result starts a fresh query");
		assert.equal(calls[2].resume, "cc-w", "on the worker's own conversation");
		assert.match(calls[2].prompt, /interrupted and resumed/);
		assert.equal(replyText(resumed), "worker resumed");
		assert.equal(host.c.pendingResults.size, 0, "the host query received nothing");
		assert.ok(activeQueryContexts.has(host.c), "the host query is still parked");
	});
});

describe("session lifecycle across module copies", () => {
	const mirror = (piSessionId, sessionId) => ({ sessionId, cursor: 2, cwd: process.cwd(), piSessionId: piSessionId ?? undefined });

	it("clears only the named session in the serving copy when a second copy delivers the event", async () => {
		const { default: activateCopy } = await import("../src/index.js?worker-copy");
		const workerPi = activateWithMockPi(activateCopy);
		const W2 = "pi-worker-2";
		setSharedSession(H, mirror(H, "cc-h"));
		setSharedSession(W, mirror(W, "cc-w"));
		setSharedSession(W2, mirror(W2, "cc-w2"));
		setSharedSession(null, mirror(null, "cc-none"));
		for (const id of [H, W, W2]) markRebuildForSession(id, "session_compact:threshold");

		workerPi.emit("session_start", { reason: "startup" }, sessionCtx(W));
		assert.ok(getSharedSession(W), "a startup does not clear");

		workerPi.emit("session_shutdown", { reason: "quit" }, sessionCtx(W));
		assert.equal(getSharedSession(W), null, "the ended session's mirror is gone from the serving copy");
		assert.equal(historyRewrittenBySession.has(W), false, "and so is its rewrite mark");

		workerPi.emit("session_start", { reason: "new" }, sessionCtx(W2));
		assert.equal(getSharedSession(W2), null, "a new session clears its own id");
		assert.equal(historyRewrittenBySession.has(W2), false);

		assert.equal(getSharedSession(H)?.sessionId, "cc-h", "the sibling's mirror stays");
		assert.equal(getSharedSession(H).needsRebuild, true, "with its rebuild mark");
		assert.ok(historyRewrittenBySession.has(H), "and its rewrite mark");
		assert.equal(getSharedSession(null)?.sessionId, "cc-none", "the (none) bucket stays");
	});

	it("counts only the ending session's queries in the leak report", async () => {
		await park(H, "toolu_h");

		assert.equal(reportLeaks("session_shutdown", W), false, "a worker end ignores the host's parked query");
		assert.equal(reportLeaks("session_shutdown", H), true, "the host's own end reports it");
	});

	it("keeps the UI link of a session with a UI when a session without one starts", () => {
		const hostUI = { notify() {} }, workerUI = { notify() {} };
		hostPi.emit("session_start", { reason: "startup" }, sessionCtx(H, { hasUI: true, ui: hostUI, mode: "tui" }));
		const workerPi = activateWithMockPi(mod.default);

		workerPi.emit("session_start", { reason: "startup" }, sessionCtx(W, { hasUI: false, ui: workerUI, mode: "print" }));

		assert.equal(getPiLink().ui, hostUI);
		assert.equal(getPiLink().mode, "tui");
	});

	// Last: it releases the marker.
	it("keeps the serving marker through a worker end in a shared copy, and releases it on the registering session's end", () => {
		assert.equal(globalThis[SERVING_MARKER], streamSimple, "precondition: the host activation registered");
		hostPi.emit("session_start", { reason: "startup" }, sessionCtx(H, { hasUI: true }));
		const workerPi = activateWithMockPi(mod.default);
		workerPi.emit("session_start", { reason: "startup" }, sessionCtx(W));

		workerPi.emit("session_shutdown", { reason: "quit" }, sessionCtx(W));
		assert.equal(globalThis[SERVING_MARKER], streamSimple, "a worker end keeps the host's marker");

		hostPi.emit("session_shutdown", { reason: "quit" }, sessionCtx(H));
		assert.equal(globalThis[SERVING_MARKER], undefined, "the registering session's end releases it");
	});
});
