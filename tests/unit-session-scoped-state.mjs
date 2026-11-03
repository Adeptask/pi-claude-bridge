/**
 * Session-scoped routing and lifecycle state. One pi process serves a host and
 * worker sessions (Slate) through the host's provider, while a worker's lifecycle
 * events may run in another copy of this module. Tool-call ids are not unique
 * across sessions, so every check here is per pi session.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createSession, getSessionPath } from "cc-session-io";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-session-scoped-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));
// The leak report writes to the debug log, read at import time.
process.env.CLAUDE_BRIDGE_DEBUG = "1";

const PROVIDER_ID = "claude-bridge";
const SERVING_MARKER = Symbol.for("claude-bridge:activeStreamSimple");

const mod = await import("../src/index.js");
const {
	setQuery, resetSharedSession, setSharedSession, getSharedSession, activeQueryContexts,
	historyRewrittenBySession, markRebuildForSession, isQueryAbandoned, getPiLink,
} = mod.__test;

// pi appends handlers per event, so the mock does too.
function activateWithMockPi(activate) {
	const handlers = new Map();
	const registered = [];
	activate({
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerProvider: (_name, config) => registered.push(config),
		registerTool: () => {},
	});
	const emit = (event, ...args) => { for (const handler of handlers.get(event) ?? []) handler(...args); };
	return { emit, registered, providerConfig: registered[0] };
}

// The host activation: the first one, so it registers the provider and owns the marker.
const hostPi = activateWithMockPi(mod.default);
const streamSimple = hostPi.providerConfig.streamSimple;
const model = hostPi.providerConfig.models[0];

const sessionCtx = (sessionId, { hasUI = false, ui = { notify() {} }, mode = "print", hasProvider = true } = {}) => ({
	cwd: process.cwd(), hasUI, ui, mode,
	sessionManager: { getSessionId: () => sessionId },
	modelRegistry: { getProvider: (id) => (hasProvider && id === PROVIDER_ID ? { name: id } : undefined) },
});

/** Leak warnings the debug log gained while `action` ran. */
function leakWarnings(action) {
	const path = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
	const read = () => (existsSync(path) ? readFileSync(path, "utf8") : "");
	const before = read().length;
	action();
	return read().slice(before).split("\n").filter((line) => line.includes("WARNING: session_shutdown left a context with no query"));
}

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
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		const id = options.sessionId ?? options.resume;
		const call = { label: script.label, resume: options.resume, id, closed: false };
		calls.push(call);
		let onClose;
		const killed = new Promise((r) => { onClose = r; });
		const path = getSessionPath(id, options.cwd, claudeDir);
		let parent = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(JSON.parse).at(-1)?.uuid : null;
		const record = (role, content, uuid) => {
			const builder = createSession({ projectPath: options.cwd, sessionId: id });
			if (role === "user") builder.addUserMessage(content);
			else builder.addAssistantMessage(content);
			const value = { ...builder.records[0], ...(uuid ? { uuid } : {}), parentUuid: parent };
			parent = value.uuid;
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, JSON.stringify(value) + "\n");
			return value;
		};
		const gen = (async function* () {
			const initial = (await prompt[Symbol.asyncIterator]().next()).value;
			call.prompt = initial.message.content[0].text;
			record("user", initial.message.content, initial.uuid);
			let blocks = [], block, json = "";
			for (const step of script.steps) {
				if (call.closed) return;
				if (typeof step === "function") { await step(killed); continue; }
				const event = step.event;
				if (event?.type === "message_start") blocks = [];
				if (event?.type === "content_block_start") {
					block = { ...event.content_block };
					blocks.push(block);
					json = "";
				}
				if (event?.delta?.type === "text_delta") block.text += event.delta.text;
				if (event?.delta?.type === "input_json_delta") json += event.delta.partial_json;
				if (event?.type === "content_block_stop" && json) block.input = JSON.parse(json);
				if (event?.type === "message_stop") {
					const value = record("assistant", blocks);
					yield { type: "assistant", parent_tool_use_id: null, uuid: value.uuid,
						message: { id: value.uuid, model: model.id, content: blocks } };
				}
				yield step.type === "system" ? { ...step, session_id: id } : step;
				if (step.type === "system") yield { type: "user", isReplay: true, parent_tool_use_id: null,
					uuid: initial.uuid, session_id: id, message: initial.message };
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

// Fresh module imports and real session-file writes need headroom under full-suite load.
describe("tool-result routing", { timeout: 30000 }, () => {
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

	it("ends a cancelled call after abort removes its context from routing", async () => {
		const controller = new AbortController();
		const host = await park(H, "toolu_a", controller.signal);
		controller.abort();
		assert.equal(activeQueryContexts.has(host.c), false, "abort removes routing immediately");

		const late = streamSimple(model, { messages: [...host.history, toolResult("toolu_a")], tools },
			{ sessionId: H, signal: controller.signal });

		assert.equal(host.c.pendingResults.size, 0, "nothing is delivered into the aborting query");
		assert.notEqual(host.c.currentPiStream, late, "the aborting query does not claim the stream");
		const reply = await late.result();
		assert.equal(reply.stopReason, "stop", "the turn ends");
		assert.equal(replyText(reply), "");
		assert.equal(calls.length, 1, "no query starts");
	});

	it("routes a result into a fresh context after an earlier query was aborted", async () => {
		const controller = new AbortController();
		const first = await park(H, "toolu_a", controller.signal);
		controller.abort();
		await settle();
		assert.equal(activeQueryContexts.has(first.c), false, "precondition: the killed query finished");

		const second = await park(H, "toolu_b");
		assert.notEqual(second.c, first.c, "each query has its own context");
		streamSimple(model, { messages: [...second.history, toolResult("toolu_b")], tools }, { sessionId: H, signal: liveSignal() });

		assert.equal(second.c.pendingResults.get("toolu_b")?.content[0].text, "file", "the result reaches the new query");
		assert.equal(calls.length, 2, "and starts no query");
	});

	it("skips a query whose turn ended before it left the routing set", async () => {
		const host = await park(H, "toolu_a");
		// The window between completion clearing activeQuery and .finally removing the context.
		host.c.activeQuery = null;

		const reply = await streamSimple(model, { messages: [...host.history, toolResult("toolu_a")], tools },
			{ sessionId: H, signal: cancelledSignal() }).result();

		assert.equal(host.c.pendingResults.size, 0, "nothing is delivered into the ended query");
		assert.equal(replyText(reply), "");
		assert.equal(calls.length, 1, "no query starts");
	});

	it("retains the recorded prefix for a cancelled late result while another session runs", async () => {
		scripts.push({ label: "host turn 1", steps: [init("cc-h"), ...text("hi"), result("hi")] });
		const u1 = user("first"), a1 = asst([{ type: "text", text: "hi" }], "stop");
		await streamSimple(model, { messages: [u1], tools }, { sessionId: H, signal: liveSignal() }).result();
		await park(W, "toolu_w");
		const saved = getSharedSession(H);
		const late = [u1, a1, user("second"), toolCall("toolu_h"), toolResult("toolu_h")];

		await streamSimple(model, { messages: late, tools }, { sessionId: H, signal: cancelledSignal() }).result();

		assert.strictEqual(getSharedSession(H), saved, "cancelled delivery does not invent recorded progress");
	});

	it("rotates the session at abort, so a new query before the killed query finishes does not resume it", async () => {
		scripts.push({ label: "host turn 1", steps: [init("cc-h"), ...text("hi"), result("hi")] });
		const u1 = user("first"), a1 = asst([{ type: "text", text: "hi" }], "stop");
		await streamSimple(model, { messages: [u1], tools }, { sessionId: H, signal: liveSignal() }).result();
		setSharedSession(W, { ccSessionId: "cc-w", digests: [], uuids: [], cuttable: [], cwd: process.cwd(), model: model.id, dirtyTail: false });
		const workerMirror = { ...getSharedSession(W) };
		let releaseKill;
		const killHeld = new Promise((r) => { releaseKill = r; });
		// The killed query finishes only when the test releases it.
		scripts.push({ label: "host turn 2", steps: [init("cc-h"), ...toolUse("toolu_a"), async (killed) => { await killed; await killHeld; }] });
		const controller = new AbortController();
		const u2 = user("second");
		const parked = await streamSimple(model, { messages: [u1, a1, u2], tools }, { sessionId: H, signal: controller.signal }).result();
		assert.equal(calls[1].resume, calls[0].id, "precondition: the parked query resumed the host session");
		try {
			controller.abort();
			const history = [u1, a1, u2, parked, toolResult("toolu_a")];
			const cancelled = await streamSimple(model, { messages: history, tools }, { sessionId: H, signal: controller.signal }).result();
			assert.equal(cancelled.stopReason, "stop", "precondition: the cancelled call ended the turn");
			assert.equal([...activeQueryContexts].some((c) => c.piSessionId === H), false, "abort removes routing before exit");

			scripts.push({ label: "host turn 3", steps: [init("cc-new"), ...text("next"), result("next")] });
			const next = await streamSimple(model, { messages: [...history, user("third")], tools }, { sessionId: H, signal: liveSignal() }).result();

			assert.equal(replyText(next), "next");
			assert.equal(calls.length, 3);
			assert.ok(calls[2].resume, "the new query resumes a rebuilt session");
			assert.notEqual(calls[2].id, calls[1].id, "not the session being killed");
			assert.deepEqual(getSharedSession(W), workerMirror, "the sibling's mirror is untouched");
		} finally {
			releaseKill();
		}
		await settle();
		assert.equal(calls[1].closed, true, "precondition: the killed query finished");
		assert.equal(getSharedSession(H).ccSessionId, calls[2].id, "the old completion does not replace the new mirror");
		assert.equal(getSharedSession(H).dirtyTail, false);
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
		assert.equal(getSharedSession(W).ccSessionId, calls[0].id);
		const host = await park(H, "toolu_same");
		const late = [u1, a1, user("second"), toolCall("toolu_same"), toolResult("toolu_same", "worker file")];

		const cancelled = await streamSimple(model, { messages: late, tools }, { sessionId: W, signal: cancelledSignal() }).result();
		assert.equal(replyText(cancelled), "", "the cancelled late result ends empty");
		assert.equal(calls.length, 2, "and starts no query");

		scripts.push({ label: "worker resumed", steps: [init("cc-other"), ...text("worker resumed"), result("worker resumed")] });
		const resumed = await streamSimple(model, { messages: late, tools }, { sessionId: W, signal: liveSignal() }).result();
		assert.equal(calls.length, 3, "the uncancelled late result starts a fresh query");
		assert.notEqual(calls[2].id, calls[1].id, "never on the host conversation");
		assert.equal(getSharedSession(W).ccSessionId, calls[2].id);
		const records = readFileSync(getSessionPath(calls[2].id, process.cwd(), claudeDir), "utf8");
		assert.match(records, /first/);
		assert.match(records, /second/);
		assert.doesNotMatch(records, /task for pi-host/);
		assert.match(calls[2].prompt, /interrupted and resumed/);
		assert.equal(replyText(resumed), "worker resumed");
		assert.equal(host.c.pendingResults.size, 0, "the host query received nothing");
		assert.ok(activeQueryContexts.has(host.c), "the host query is still parked");
	});
});

describe("session lifecycle across module copies", { timeout: 30000 }, () => {
	const mirror = (_piSessionId, ccSessionId) => ({ ccSessionId, digests: [], uuids: [], cuttable: [], cwd: process.cwd(), model: model.id, dirtyTail: false });

	it("retains mirrors and clears only the named rewrite mark across two copies", async () => {
		const copy = await import("../src/index.js?worker-copy");
		const activateCopy = copy.default;
		assert.notEqual(activateCopy, mod.default, "precondition: a separate module copy");
		const workerPi = activateWithMockPi(activateCopy);
		const W2 = "pi-worker-2";
		setSharedSession(H, mirror(H, "cc-h"));
		setSharedSession(W, mirror(W, "cc-w"));
		setSharedSession(W2, mirror(W2, "cc-w2"));
		setSharedSession(null, mirror(null, "cc-none"));
		for (const id of [H, W, W2]) {
			markRebuildForSession(id, "session_compact:threshold");
			copy.__test.markRebuildForSession(id, "session_compact:threshold");
		}

		workerPi.emit("session_start", { reason: "startup" }, sessionCtx(W));
		assert.ok(getSharedSession(W), "a startup does not clear");

		workerPi.emit("session_shutdown", { reason: "quit" }, sessionCtx(W));
		assert.equal(getSharedSession(W).ccSessionId, "cc-w", "the ended session retains its durable mirror");
		assert.equal(historyRewrittenBySession.has(W), false, "and so is its rewrite mark");

		workerPi.emit("session_start", { reason: "new" }, sessionCtx(W2));
		assert.equal(getSharedSession(W2).ccSessionId, "cc-w2", "a new session retains its mirror for sync");
		assert.equal(historyRewrittenBySession.has(W2), false);

		assert.equal(getSharedSession(H)?.ccSessionId, "cc-h", "the sibling's mirror stays");
		assert.equal(getSharedSession(H).dirtyTail, true, "with its rebuild mark");
		assert.ok(historyRewrittenBySession.has(H), "and its rewrite mark");
		assert.ok(copy.__test.historyRewrittenBySession.has(H), "the second copy keeps the host mark too");
		assert.equal(copy.__test.historyRewrittenBySession.has(W), false);
		const workerMirror = getSharedSession(W2), hostMirror = getSharedSession(H);
		for (const reason of ["resume", "fork"]) {
			markRebuildForSession(W2, "session_compact:threshold");
			copy.__test.markRebuildForSession(W2, "session_compact:threshold");
			assert.ok(historyRewrittenBySession.has(W2));
			assert.ok(copy.__test.historyRewrittenBySession.has(W2));
			workerPi.emit("session_start", { reason }, sessionCtx(W2));
			assert.equal(historyRewrittenBySession.has(W2), false, `${reason} clears the serving copy mark`);
			assert.equal(copy.__test.historyRewrittenBySession.has(W2), false, `${reason} clears the worker copy mark`);
			assert.strictEqual(getSharedSession(W2), workerMirror, `${reason} retains the target mirror`);
			assert.strictEqual(getSharedSession(H), hostMirror, `${reason} retains the sibling mirror`);
			assert.ok(historyRewrittenBySession.has(H));
			assert.ok(copy.__test.historyRewrittenBySession.has(H));
		}
		assert.equal(getSharedSession(null)?.ccSessionId, "cc-none", "the (none) bucket stays");
	});

	it("closes a worker query in the serving copy without closing a sibling or warning about an abort", async () => {
		const workerPi = activateWithMockPi((await import("../src/index.js?worker-copy")).default);
		const host = await park(H, "toolu_h");
		const worker = await park(W, "toolu_w");
		const controller = new AbortController();
		await park("pi-closing", "toolu_c", controller.signal);
		controller.abort();

		const warnings = leakWarnings(() => {
			workerPi.emit("session_shutdown", {}, sessionCtx(W));
			workerPi.emit("session_shutdown", {}, sessionCtx("pi-closing"));
		});
		await settle();
		assert.equal(calls[1].closed, true, "copy B closes the worker query owned by copy A");
		assert.equal(activeQueryContexts.has(worker.c), false);
		assert.ok(activeQueryContexts.has(host.c), "the host remains parked");
		assert.equal(calls[0].closed, false);
		assert.deepEqual(warnings, [], "parked and aborting queries are not leaked contexts");
	});

	it("warns only for a queryless context of the ending session", async () => {
		const host = await park(H, "toolu_h");
		host.c.activeQuery = null;
		assert.deepEqual(leakWarnings(() => hostPi.emit("session_shutdown", {}, sessionCtx(W))), []);
		assert.equal(leakWarnings(() => hostPi.emit("session_shutdown", {}, sessionCtx(H))).length, 1);
	});

	it("keeps the UI link of a session with a UI when a session without one starts", () => {
		const hostUI = { notify() {} }, workerUI = { notify() {} };
		hostPi.emit("session_start", { reason: "startup" }, sessionCtx(H, { hasUI: true, ui: hostUI, mode: "tui" }));
		const workerPi = activateWithMockPi(mod.default);

		workerPi.emit("session_start", { reason: "startup" }, sessionCtx(W, { hasUI: false, ui: workerUI, mode: "print" }));

		assert.equal(getPiLink().ui, hostUI);
		assert.equal(getPiLink().mode, "tui");
	});

	it("leaves a marker held by another copy unchanged when a session registers at session_start", async () => {
		const hostMarker = globalThis[SERVING_MARKER];
		try {
			const holder = function otherCopyStreamSimple() {};
			globalThis[SERVING_MARKER] = holder;
			const late = activateWithMockPi((await import("../src/index.js?deferred-held-copy")).default);
			assert.equal(late.registered.length, 0, "precondition: registration is deferred");
			late.emit("session_start", { reason: "startup" }, sessionCtx("pi-late", { hasProvider: false }));
			assert.equal(late.registered.length, 1, "its registry lacked the provider, so it registers");
			assert.equal(globalThis[SERVING_MARKER], holder, "the marker stays with its holder");

			late.emit("session_shutdown", { reason: "quit" }, sessionCtx("pi-late"));
			assert.equal(globalThis[SERVING_MARKER], holder, "its end does not release the marker");
		} finally {
			globalThis[SERVING_MARKER] = hostMarker;
		}
	});

	it("gives a free marker to a session that registers at session_start, so its end releases it", async () => {
		const hostMarker = globalThis[SERVING_MARKER];
		try {
			const late = activateWithMockPi((await import("../src/index.js?deferred-copy")).default);
			assert.equal(late.registered.length, 0, "precondition: registration is deferred");
			// The holder ended before this session started.
			globalThis[SERVING_MARKER] = undefined;
			late.emit("session_start", { reason: "startup" }, sessionCtx("pi-late", { hasProvider: false }));
			assert.equal(late.registered.length, 1, "precondition: its registry lacked the provider");
			assert.equal(globalThis[SERVING_MARKER], late.registered[0].streamSimple, "the registering session owns the marker");

			late.emit("session_shutdown", { reason: "quit" }, sessionCtx("pi-late"));
			assert.equal(globalThis[SERVING_MARKER], undefined, "its end releases the marker");
			const next = activateWithMockPi((await import("../src/index.js?after-release-copy")).default);
			assert.equal(next.registered.length, 1, "the next activation registers at load");
		} finally {
			globalThis[SERVING_MARKER] = hostMarker;
		}
	});

	it("keeps lifecycle hook count constant across repeated activation and shutdown", async () => {
		const copy = await import("../src/index.js?worker-copy");
		const hooks = globalThis[Symbol.for("claude-bridge:sessionLifecycleHooks")];
		const count = hooks.size;
		for (let i = 0; i < 20; i++) {
			const workerPi = activateWithMockPi(i % 2 ? copy.default : mod.default);
			workerPi.emit("session_start", { reason: "startup" }, sessionCtx(`pi-hook-worker-${i}`));
			assert.equal(hooks.size, count, "activation adds no lifecycle closure");
			workerPi.emit("session_shutdown", { reason: "quit" }, sessionCtx(`pi-hook-worker-${i}`));
			assert.equal(hooks.size, count, "shutdown leaves only module-scoped hooks");
		}
	});

	// Last: it releases the marker.
	it("keeps the serving marker through a worker end in a shared copy, and releases it on the registering session's end", () => {
		assert.equal(globalThis[SERVING_MARKER], streamSimple, "precondition: the host activation registered");
		hostPi.emit("session_start", { reason: "startup" }, sessionCtx(H, { hasUI: true }));
		const workerPi = activateWithMockPi(mod.default);
		workerPi.emit("session_start", { reason: "startup" }, sessionCtx(W));

		workerPi.emit("session_shutdown", { reason: "quit" }, sessionCtx(W));
		assert.equal(globalThis[SERVING_MARKER], streamSimple, "a worker end keeps the host's marker");
		hostPi.emit("session_shutdown", { reason: "quit" }, sessionCtx(W));
		assert.equal(globalThis[SERVING_MARKER], streamSimple, "so does another session's end in the registering activation");

		hostPi.emit("session_shutdown", { reason: "quit" }, sessionCtx(H));
		assert.equal(globalThis[SERVING_MARKER], undefined, "the registering session's end releases it");
	});
});
