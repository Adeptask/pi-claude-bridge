import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { openSession } from "cc-session-io";
import "./lib/fake-agent-sdk-loader.mjs";
import { nextCall } from "./lib/fake-agent-sdk.mjs";

// This file must run with --import ./tests/lib/fake-agent-sdk-loader.mjs.
const { default: activate, __test } = await import("../src/index.js");
const model = { id: "claude-sonnet-4-5", api: "claude-bridge", provider: "claude-bridge", contextWindow: 200000 };
const tool = { name: "read", description: "Read a file", parameters: Type.Object({}) };
const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2 });
const result = (text) => ({ role: "toolResult", toolCallId: "same-id", content: [{ type: "text", text }], timestamp: 3 });
const context = (...messages) => ({ systemPrompt: "test prompt", tools: [tool], messages });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function pi(moduleActivate) {
	const handlers = new Map();
	let callback;
	moduleActivate({
		on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
		registerProvider(_name, config) { callback = config.streamSimple; },
		registerTool() {},
	});
	const emit = (event, ...args) => { for (const fn of handlers.get(event) ?? []) fn(...args); };
	if (!callback) emit("session_start", { reason: "resume" }, {
		modelRegistry: { getProvider: () => undefined }, sessionManager: { getSessionId: () => randomUUID() },
	});
	assert.ok(callback, "provider callback was registered");
	return { callback, emit };
}
function request(callback, id, messages, signal) {
	return callback(model, context(...messages), { sessionId: id, ...(signal ? { signal } : {}) });
}
async function toolCall(call) {
	// Use the actual MCP server request handler registered by the bridge.
	const handler = call.input.options.mcpServers["custom-tools"].instance.server._requestHandlers.get("tools/call");
	assert.ok(handler, "real MCP tools/call handler exists");
	return handler({ method: "tools/call", params: { name: "read", arguments: {}, _meta: { "claudecode/toolUseId": "same-id" } } });
}
async function started(call) {
	call.emit({ type: "assistant", message: { id: randomUUID(), content: [{ type: "tool_use", id: "same-id", name: "mcp__custom-tools__read", input: {} }] } });
	await tick();
}
async function finish(call, text) {
	call.emit({ type: "result", subtype: "success", result: text });
	call.finish();
	await tick();
}

describe("registered provider callback with overlapping conversations", () => {
	for (const first of ["A", "B"]) it(`same tool ID delivers only to its owner when ${first} finishes first`, async () => {
		__test.resetSharedSession();
		const host = pi(activate);
		host.emit("before_agent_start", { systemPrompt: "test prompt", systemPromptOptions: {} });
		const id = { A: randomUUID(), B: randomUUID() };
		const streams = { A: request(host.callback, id.A, [user("A private")]), B: request(host.callback, id.B, [user("B private")]) };
		const calls = { A: await nextCall(), B: await nextCall() };
		await Promise.all([started(calls.A), started(calls.B)]);
		const pending = { A: toolCall(calls.A), B: toolCall(calls.B) };
		await tick();
		for (const label of [first, first === "A" ? "B" : "A"]) {
			const other = label === "A" ? "B" : "A";
			const continued = request(host.callback, id[label], [user(`${label} private`), { role: "assistant", content: [{ type: "toolCall", id: "same-id", name: "read", arguments: {} }] }, result(`${label} secret`)]);
			assert.equal((await pending[label]).content[0].text, `${label} secret`);
			if (label === first) {
				let otherResolved = false;
				void pending[other].then(() => { otherResolved = true; });
				await tick();
				assert.equal(otherResolved, false, `${other} must remain parked`);
			}
			await finish(calls[label], `${label} done`);
			const output = await continued.result();
			assert.equal(output.stopReason, "stop");
			assert.equal(output.content.find((block) => block.type === "text")?.text, `${label} done`,
				"the resumed stream contains only its own completion");
		}
		await Promise.all(Object.values(streams).map((s) => s.result()));
		assert.equal((await pending.A).content[0].text, "A secret");
		assert.equal((await pending.B).content[0].text, "B secret");
	});

	it("cancellation rejects late results, a separate module shuts down its owner, and B keeps running", async () => {
		__test.resetSharedSession();
		const host = pi(activate);
		host.emit("before_agent_start", { systemPrompt: "test prompt", systemPromptOptions: {} });
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		const controller = new AbortController();
		request(host.callback, ids[0], [user("A")], controller.signal);
		request(host.callback, ids[1], [user("B")]);
		const a = await nextCall(), b = await nextCall();
		await Promise.all([started(a), started(b)]);
		const pendingA = toolCall(a), pendingB = toolCall(b);
		await tick();
		controller.abort();
		assert.equal((await pendingA).content[0].text, "Operation aborted");
		assert.equal((await request(host.callback, ids[0], [user("A"), result("late secret")]).result()).stopReason, "stop");
		request(host.callback, ids[2], [user("C")]);
		const c = await nextCall();
		await started(c);
		const pendingC = toolCall(c);
		await tick();
		const worker = pi((await import("../src/index.js?separate-shutdown-owner")).default);
		worker.emit("session_shutdown", {}, { sessionManager: { getSessionId: () => ids[2] } });
		assert.equal((await pendingC).content[0].text, "Session ended", "another module drained only C");
		assert.ok(c.closes > 0, "shutdown closed C's SDK query");
		const lateC = request(host.callback, ids[2], [user("C"), result("C late")]);
		assert.equal((await lateC.result()).stopReason, "stop");
		const continued = request(host.callback, ids[1], [user("B"), { role: "assistant", content: [{ type: "toolCall", id: "same-id", name: "read", arguments: {} }] }, result("B intact")]);
		assert.equal((await pendingB).content[0].text, "B intact");
		await finish(b, "B done");
		assert.equal((await continued.result()).stopReason, "stop");
		a.finish();
		c.finish();
		await tick();
	});

	it("late tool results after full abort cleanup do not start another SDK query", async () => {
		__test.resetSharedSession();
		const host = pi(activate);
		host.emit("before_agent_start", { systemPrompt: "test prompt", systemPromptOptions: {} });
		const directory = mkdtempSync(join(tmpdir(), "bridge-late-result-"));
		const previousCwd = process.cwd();
		const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
		process.chdir(directory);
		try {
			const id = randomUUID(), controller = new AbortController();
			const first = request(host.callback, id, [user("first")], controller.signal);
			const call = await nextCall();
			await started(call);
			const pending = toolCall(call);
			await tick();
			controller.abort();
			assert.equal((await pending).content[0].text, "Operation aborted");
			call.finish();
			await first.result();
			await tick(); // Wait for consumeQuery.finally to remove the last active context.
			const late = request(host.callback, id, [user("first"),
				{ role: "assistant", content: [{ type: "toolCall", id: "same-id", name: "read", arguments: {} }] }, result("late secret")]);
			let timer;
			let output;
			try {
				output = await Promise.race([
					late.result(),
					new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("late result started a new SDK query")), 1000); }),
				]);
			} finally {
				clearTimeout(timer);
			}
			assert.equal(output.stopReason, "stop");
			assert.equal(output.content.length, 0, "the cancelled result produces no new answer");
			const next = request(host.callback, id, [user("first"), assistant(""), user("next")]);
			const fresh = await nextCall();
			assert.ok(fresh, "a later real user message can still start a query");
			await finish(fresh, "next done");
			await next.result();
		} finally {
			process.chdir(previousCwd);
			if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("immediate continuation resumes the first query's emitted session", async () => {
		__test.resetSharedSession();
		const host = pi(activate);
		host.emit("before_agent_start", { systemPrompt: "test prompt", systemPromptOptions: {} });
		const id = randomUUID(), emitted = randomUUID();
		const first = request(host.callback, id, [user("first")]);
		const c1 = await nextCall();
		c1.emit({ type: "system", subtype: "init", session_id: emitted });
		c1.emit({ type: "result", subtype: "success", result: "one" });
		c1.finish();
		await first.result();
		const second = request(host.callback, id, [user("first"), assistant("one"), user("next")]);
		const c2 = await nextCall();
		assert.equal(c2.input.options.resume, emitted);
		await finish(c2, "two");
		await second.result();
	});

	it("different histories with the same identity and tool ID never cross-deliver", async () => {
		__test.resetSharedSession();
		const host = pi(activate);
		host.emit("before_agent_start", { systemPrompt: "test prompt", systemPromptOptions: {} });
		const id = randomUUID();
		request(host.callback, id, [user("parent")]);
		const p = await nextCall();
		request(host.callback, id, [user("child")]);
		const c = await nextCall();
		await Promise.all([started(p), started(c)]);
		const pendingParent = toolCall(p), pendingChild = toolCall(c);
		let childResolved = false;
		void pendingChild.then(() => { childResolved = true; });
		await tick();
		const parentContinuation = request(host.callback, id, [user("parent"), { role: "assistant", content: [{ type: "toolCall", id: "same-id", name: "read", arguments: {} }] }, result("parent secret")]);
		assert.equal((await pendingParent).content[0].text, "parent secret");
		await tick();
		assert.equal(childResolved, false);
		const wrong = request(host.callback, id, [user("rewritten"), { role: "assistant", content: [{ type: "toolCall", id: "same-id", name: "read", arguments: {} }] }, result("wrong branch")]);
		assert.equal((await wrong.result()).stopReason, "stop");
		await tick();
		assert.equal(childResolved, false);
		const childContinuation = request(host.callback, id, [user("child"), { role: "assistant", content: [{ type: "toolCall", id: "same-id", name: "read", arguments: {} }] }, result("child secret")]);
		assert.equal((await pendingChild).content[0].text, "child secret");
		await Promise.all([finish(p, "parent done"), finish(c, "child done")]);
		await Promise.all([parentContinuation.result(), childContinuation.result()]);
	});

	it("aborting a parent settles its parked child and rejects late child results", async () => {
		__test.resetSharedSession();
		const host = pi(activate);
		host.emit("before_agent_start", { systemPrompt: "test prompt", systemPromptOptions: {} });
		const id = randomUUID(), controller = new AbortController();
		const parent = request(host.callback, id, [user("parent")], controller.signal);
		const p = await nextCall();
		const child = request(host.callback, id, [user("child")]);
		const c = await nextCall();
		await started(c);
		const pending = toolCall(c);
		await tick();
		controller.abort();
		assert.equal((await pending).content[0].text, "Operation aborted");
		assert.ok(c.interrupts > 0 && c.closes > 0);
		assert.equal((await child.result()).stopReason, "toolUse", "the tool-use turn already ended before abort");
		assert.equal((await request(host.callback, id, [user("child"), result("late")]).result()).stopReason, "stop");
		p.finish(); c.finish();
		await parent.result();
	});

	it("a replacement module keeps the callback for another live conversation", async () => {
		__test.resetSharedSession();
		const host = pi(activate);
		host.emit("before_agent_start", { systemPrompt: "test prompt", systemPromptOptions: {} });
		const idA = randomUUID(), idB = randomUUID();
		request(host.callback, idA, [user("A")]);
		const a = await nextCall();
		request(host.callback, idB, [user("B")]);
		const b = await nextCall();
		await started(b);
		const pending = toolCall(b);
		await tick();
		host.emit("session_shutdown", {}, { sessionManager: { getSessionId: () => idA } });
		const replacement = pi((await import("../src/index.js?replacement-with-survivor")).default);
		const continued = request(replacement.callback, idB, [user("B"), { role: "assistant", content: [{ type: "toolCall", id: "same-id", name: "read", arguments: {} }] }, result("B intact")]);
		assert.equal((await pending).content[0].text, "B intact");
		await finish(b, "B done");
		assert.equal((await continued.result()).stopReason, "stop");
		a.finish();
	});

	it("history-matched continuation reuses its own session and a same-length rewrite never resumes stale history", async () => {
		__test.resetSharedSession();
		const host = pi(activate);
		host.emit("before_agent_start", { systemPrompt: "test prompt", systemPromptOptions: {} });
		const id = randomUUID();
		const directory = mkdtempSync(join(tmpdir(), "bridge-overlap-"));
		const previousCwd = process.cwd();
		const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
		process.chdir(directory);
		try {
			const first = request(host.callback, id, [user("first")]);
			const c1 = await nextCall();
			const emitted = randomUUID();
			c1.emit({ type: "system", subtype: "init", session_id: emitted });
			await finish(c1, "one");
			await first.result();
			const second = request(host.callback, id, [user("first"), assistant("one"), user("next")]);
			const c2 = await nextCall();
			assert.equal(c2.input.options.resume, emitted);
			await finish(c2, "two");
			await second.result();
			const rewritten = request(host.callback, id, [user("other"), assistant("one"), user("next")]);
			const c3 = await nextCall();
			assert.equal(c3.input.options.resume, c2.input.options.resume, "rebuild keeps the owned UUID");
			assert.equal(openSession({ sessionId: c3.input.options.resume, projectPath: directory, claudeDir: process.env.CLAUDE_CONFIG_DIR }).messages[0].message.content,
				"other", "same-length rewrite replaces the stored history before resume");
			await finish(c3, "three");
			await rewritten.result();
		} finally {
			process.chdir(previousCwd);
			if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
