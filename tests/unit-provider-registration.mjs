import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { __fakeSdkState } from "./lib/fake-agent-sdk.mjs";

const OWNER_KEY = Symbol.for("claude-bridge:activeStreamSimple");
const root = fileURLToPath(new URL("..", import.meta.url));
const generatedA = join(root, "src", `.provider-registration-test-a-${process.pid}.ts`);
const generatedB = join(root, "src", `.provider-registration-test-b-${process.pid}.ts`);
let activate;
let activateSecond;
let bridgeTest;

function runtime(sessionId) {
	const handlers = new Map();
	const providers = [];
	const tools = [];
	const sessionManager = { getSessionId: () => sessionId };
	const pi = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider(name, config) { providers.push({ name, config }); },
		registerTool(tool) { tools.push(tool); },
	};
	activate(pi);
	for (const handler of handlers.get("before_agent_start") ?? []) {
		handler({ systemPrompt: `system:${sessionId}`, systemPromptOptions: {} });
	}
	return { handlers, providers, tools, sessionManager };
}

async function events(stream) {
	const found = [];
	for await (const event of stream) found.push(event);
	return found;
}

function fakeModel() {
	return {
		api: "claude-bridge", provider: "claude-bridge", id: "claude-sonnet-5", baseUrl: "claude-bridge",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function user(text) { return { role: "user", content: text, timestamp: 1 }; }
function assistant(text) { return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 }; }
function toolCall(marker) {
	return { role: "assistant", content: [{ type: "toolCall", id: `tool-${marker}`, name: "read", arguments: { path: marker } }], timestamp: 2 };
}
function toolResult(marker) {
	return { role: "toolResult", toolCallId: `tool-${marker}`, toolName: "read", content: [{ type: "text", text: `result:${marker}` }], isError: false, timestamp: 3 };
}
const readTool = { name: "read", description: "read", parameters: { type: "object", properties: {} } };

function sdkCall(marker) {
	return __fakeSdkState().calls.find((call) => call.marker === marker);
}

async function invokeMcp(call, marker) {
	const server = Object.values(call.options.mcpServers)[0].instance.server;
	const handler = server._requestHandlers.get("tools/call");
	return handler({ method: "tools/call", params: { name: "read", arguments: {}, _meta: { "claudecode/toolUseId": `tool-${marker}` } } }, {});
}

before(async () => {
	const source = readFileSync(join(root, "src", "index.ts"), "utf8");
	const transformed = source.replace('from "@anthropic-ai/claude-agent-sdk";', 'from "../tests/lib/fake-agent-sdk.mjs";');
	assert.notEqual(transformed, source, "the SDK boundary replacement must apply");
	writeFileSync(generatedA, transformed);
	writeFileSync(generatedB, transformed);
	const moduleA = await import(`${pathToFileURL(generatedA).href}?test=${Date.now()}-a`);
	const moduleB = await import(`${pathToFileURL(generatedB).href}?test=${Date.now()}-b`);
	activate = moduleA.default;
	activateSecond = moduleB.default;
	bridgeTest = moduleA.__test;
});

after(() => {
	rmSync(generatedA, { force: true });
	rmSync(generatedB, { force: true });
});

afterEach(() => {
	delete globalThis[OWNER_KEY];
	bridgeTest.resetSharedSession();
	__fakeSdkState().calls.length = 0;
	__fakeSdkState().releases.clear();
});

test("disabled AskClaude still exposes the bridge discovery probe", async () => {
	const runtimeState = runtime("pi-probe");
	assert.deepEqual(runtimeState.tools.map((tool) => tool.name), ["claude_bridge_probe"]);
	const probe = runtimeState.tools.find((tool) => tool.name === "claude_bridge_probe");
	assert.ok(probe);
	assert.equal(probe.label, "Claude bridge probe");
	assert.equal(probe.description, "Check that the Claude bridge extension is loaded.");
	assert.equal(probe.parameters.type, "object");
	assert.deepEqual(probe.parameters.properties, {});
	assert.deepEqual(await probe.execute({}, {}), {
		content: [{ type: "text", text: "Claude bridge extension is loaded." }],
		details: {},
	});
	assert.equal(runtimeState.providers[0].name, "claude-bridge");
	for (const handler of runtimeState.handlers.get("session_shutdown") ?? []) handler({}, { sessionManager: runtimeState.sessionManager });
});

test("separate module evaluations share session cleanup with the callback owner", async () => {
	const first = runtime("pi-A");
	const secondHandlers = new Map();
	const secondProviders = [];
	const secondSessionManager = { getSessionId: () => "pi-B" };
	const secondPi = {
		on(event, handler) {
			const list = secondHandlers.get(event) ?? [];
			list.push(handler);
			secondHandlers.set(event, list);
		},
		registerProvider(name, config) { secondProviders.push({ name, config }); },
		registerTool() {},
	};
	activateSecond(secondPi);
	for (const handler of first.handlers.get("before_agent_start") ?? []) {
		handler({ systemPrompt: "system:pi-B", systemPromptOptions: {} });
	}
	for (const handler of secondHandlers.get("before_agent_start") ?? []) {
		handler({ systemPrompt: "system:pi-A", systemPromptOptions: {} });
		handler({ systemPrompt: "system:pi-B", systemPromptOptions: {} });
	}
	const callback = first.providers[0].config.streamSimple;
	assert.equal(secondProviders[0].config.streamSimple, callback);
	const model = fakeModel();

	const aTurn = events(callback(model, { messages: [user("A-live")], systemPrompt: "system:pi-A" }, { sessionId: "pi-A" }));
	const bTurn = events(callback(model, { messages: [user("B-live")], systemPrompt: "system:pi-B" }, { sessionId: "pi-B" }));
	await new Promise((resolve) => setImmediate(resolve));
	__fakeSdkState().releases.get("A-live")();
	__fakeSdkState().releases.get("B-live")();
	await Promise.all([aTurn, bTurn]);

	for (const handler of secondHandlers.get("session_shutdown") ?? []) handler({}, { sessionManager: secondSessionManager });
	assert.equal(bridgeTest.getSharedSession("pi-B"), null);
	assert.equal(bridgeTest.getSharedSession("pi-A")?.sessionId, "sdk-A-live");
	const aResume = events(callback(model, {
		messages: [user("A-live"), assistant("answer:A-live"), user("A-after-B-shutdown")],
		systemPrompt: "system:pi-A",
	}, { sessionId: "pi-A" }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sdkCall("A-after-B-shutdown").options.resume, "sdk-A-live");
	__fakeSdkState().releases.get("A-after-B-shutdown")();
	await aResume;

	const bFresh = events(callback(model, { messages: [user("B-after-shutdown")], systemPrompt: "system:pi-B" }, { sessionId: "pi-B" }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sdkCall("B-after-shutdown").options.resume, undefined);
	__fakeSdkState().releases.get("B-after-shutdown")();
	await bFresh;
	assert.equal(bridgeTest.getSharedSession("pi-B")?.sessionId, "sdk-B-after-shutdown");
	for (const handler of secondHandlers.get("session_shutdown") ?? []) handler({}, { sessionManager: secondSessionManager });
	assert.equal(bridgeTest.getSharedSession("pi-B"), null);
	for (const handler of first.handlers.get("session_shutdown") ?? []) handler({}, { sessionManager: first.sessionManager });
	assert.equal(bridgeTest.getSharedSession("pi-A"), null);
});

test("aborting one runtime does not invalidate another runtime continuation", async () => {
	const first = runtime("pi-A");
	const second = runtime("pi-B");
	const callback = first.providers[0].config.streamSimple;
	const model = fakeModel();

	const settledB = events(callback(model, { messages: [user("B-base")], systemPrompt: "system:pi-B" }, { sessionId: "pi-B" }));
	await new Promise((resolve) => setImmediate(resolve));
	__fakeSdkState().releases.get("B-base")();
	await settledB;

	const controller = new AbortController();
	const abortedA = events(callback(model, { messages: [user("A-abort")], systemPrompt: "system:pi-A" }, { sessionId: "pi-A", signal: controller.signal }));
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	assert.equal((await abortedA).at(-1)?.reason, "aborted");

	const continuedB = events(callback(model, {
		messages: [user("B-base"), assistant("answer:B-base"), user("B-after-abort")],
		systemPrompt: "system:pi-B",
	}, { sessionId: "pi-B" }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sdkCall("B-after-abort").options.resume, "sdk-B-base");
	__fakeSdkState().releases.get("B-after-abort")();
	assert.equal((await continuedB).at(-1)?.message.content[0].text, "answer:B-after-abort");

	for (const handler of second.handlers.get("session_shutdown") ?? []) handler({}, { sessionManager: second.sessionManager });
	for (const handler of first.handlers.get("session_shutdown") ?? []) handler({}, { sessionManager: first.sessionManager });
});

test("two runtimes keep registration, tools, and two-turn sessions isolated in either completion order", async () => {
	for (const order of [["B-tool", "A-tool"], ["A-tool", "B-tool"]]) {
		const first = runtime("pi-A");
		const second = runtime("pi-B");
		assert.equal(first.providers.length, 1);
		assert.equal(second.providers.length, 1);
		assert.equal(first.providers[0].name, "claude-bridge");
		assert.equal(second.providers[0].name, "claude-bridge");
		assert.equal(first.providers[0].config.streamSimple, second.providers[0].config.streamSimple);

		const model = fakeModel();
		const callback = first.providers[0].config.streamSimple;
		const firstTurns = await Promise.all([
			events(callback(model, { messages: [user("A-tool")], systemPrompt: "system:pi-A", tools: [readTool] }, { sessionId: "pi-A" })),
			events(callback(model, { messages: [user("B-tool")], systemPrompt: "system:pi-B", tools: [readTool] }, { sessionId: "pi-B" })),
		]);
		assert.deepEqual(firstTurns.map((turn) => turn.at(-1)?.message.content[0].id), ["tool-A-tool", "tool-B-tool"]);

		const continuations = new Map();
		for (const marker of ["A-tool", "B-tool"]) {
			const sessionId = marker.startsWith("A") ? "pi-A" : "pi-B";
			continuations.set(marker, events(callback(model, {
				messages: [user(marker), toolCall(marker), toolResult(marker)],
				systemPrompt: `system:${sessionId}`, tools: [readTool],
			}, { sessionId })));
			const result = await invokeMcp(sdkCall(marker), marker);
			assert.equal(result.content[0].text, `result:${marker}`);
		}
		for (const marker of order) __fakeSdkState().releases.get(marker)();
		await Promise.all(continuations.values());

		const histories = {
			"A-next": [user("A-tool"), toolCall("A-tool"), toolResult("A-tool"), assistant("answer:A-tool"), user("A-next")],
			"B-next": [user("B-tool"), toolCall("B-tool"), toolResult("B-tool"), assistant("answer:B-tool"), user("B-next")],
		};
		const nextStreams = {
			"A-next": events(callback(model, { messages: histories["A-next"], systemPrompt: "system:pi-A", tools: [readTool] }, { sessionId: "pi-A" })),
			"B-next": events(callback(model, { messages: histories["B-next"], systemPrompt: "system:pi-B", tools: [readTool] }, { sessionId: "pi-B" })),
		};
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sdkCall("A-next").options.resume, "sdk-A-tool");
		assert.equal(sdkCall("B-next").options.resume, "sdk-B-tool");
		__fakeSdkState().releases.get("A-next")();
		__fakeSdkState().releases.get("B-next")();
		const nextTurns = await Promise.all([nextStreams["A-next"], nextStreams["B-next"]]);
		assert.deepEqual(nextTurns.map((turn) => turn.at(-1)?.message.content[0].text), ["answer:A-next", "answer:B-next"]);

		for (const handler of second.handlers.get("session_shutdown") ?? []) handler({}, { sessionManager: second.sessionManager });
		assert.equal(globalThis[OWNER_KEY], callback);
		for (const handler of first.handlers.get("session_shutdown") ?? []) handler({}, { sessionManager: first.sessionManager });
		assert.equal(globalThis[OWNER_KEY], undefined);
		bridgeTest.resetSharedSession();
		__fakeSdkState().calls.length = 0;
		__fakeSdkState().releases.clear();
	}
});
