/**
 * A prompt a before_agent_start hook returns reaches Claude Code: each test asserts the
 * append query() receives, or the turn's error. Real pi sessions run pi's ExtensionRunner;
 * cases pi 1.2.0 cannot produce (self-check mismatch, two sessions on one activation,
 * eviction) drive the bridge hooks directly.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import activate, { __test } from "../src/index.js";
import { PI_PREAMBLE, projectPromptCapture } from "../src/prompt-capture.js";

const HOME = process.env.HOME, agentDir = process.env.PI_CODING_AGENT_DIR, APPEND = "Appended rule.";
const MODEL = { id: "claude-sonnet-4-6", name: "Bridge", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const sent = [];
__test.setQuery(({ options }) => Object.assign((async function* () {
	sent.push(options.systemPrompt.append);
	yield { type: "system", subtype: "init", session_id: `cc-${sent.length}` };
	yield { type: "result", subtype: "success", is_error: false, result: "ok" };
})(), { interrupt: async () => {}, close: () => {} }));

const sessions = [];
afterEach(async () => {
	for (const s of sessions.splice(0)) { await s.extensionRunner.emit({ type: "session_shutdown" }); s.dispose(); }
});
async function piSession(...extensionFactories) {
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd: HOME, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, appendSystemPrompt: [APPEND], extensionFactories });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd: HOME, agentDir, resourceLoader, sessionManager: SessionManager.inMemory(HOME), settingsManager, model: MODEL });
	sessions.push(session);
	await session.bindExtensions({}); // session_start: the bridge registers its provider here
	return session;
}
async function turn(session, start = (s) => s.prompt("hi")) {
	const before = sent.length;
	await start(session);
	return sent.length > before ? { append: sent.at(-1) } : { error: session.messages.at(-1).errorMessage };
}
const force = (wrap) => (pi) => pi.on("before_agent_start", (event) => ({ systemPrompt: wrap(event.systemPrompt) }));
const WRAPS = { prefix: (b) => `PRE\n\n${b}`, suffix: (b) => `${b}\n\nPOST`, wrapper: (b) => `PRE\n\n${b}\n\nPOST` };
const SENT = { prefix: `PRE\n\n${APPEND}`, suffix: `${APPEND}\n\nPOST`, wrapper: `PRE\n\n${APPEND}\n\nPOST` };

describe("forced prompt through a real pi session", () => {
	for (const [placement, wrap] of Object.entries(WRAPS)) for (const bridgeFirst of [true, false]) it(`forwards a ${placement} forced ${bridgeFirst ? "after" : "before"} the bridge hook`, async () => {
		const s = await piSession(...(bridgeFirst ? [activate, force(wrap)] : [force(wrap), activate]));
		assert.deepEqual(await turn(s), { append: SENT[placement] });
	});
	it("forwards two forcing extensions with the bridge between them", async () => {
		assert.deepEqual(await turn(await piSession(force(WRAPS.suffix), activate, force(WRAPS.prefix))), { append: SENT.wrapper });
	});
	for (const bridgeFirst of [true, false]) it(`keeps the base when a hook calls setActiveTools (bridge ${bridgeFirst ? "first" : "last"})`, async () => {
		const narrow = (pi) => pi.on("before_agent_start", () => { pi.setActiveTools(["read"]); });
		const s = await piSession(...(bridgeFirst ? [activate, narrow, force(WRAPS.suffix)] : [narrow, force(WRAPS.suffix), activate]));
		assert.deepEqual(await turn(s), { append: SENT.suffix });
	});
	it("an idle triggered turn carries the forced text (sendCustomMessage with triggerTurn)", async () => {
		const start = (s) => s.sendCustomMessage({ customType: "failover", content: "resume", display: false }, { triggerTurn: true });
		assert.deepEqual(await turn(await piSession(activate, force(WRAPS.suffix)), start), { append: SENT.suffix });
	});
	it("an unforced session sends the portable parts as before", async () => {
		assert.deepEqual(await turn(await piSession(activate)), { append: APPEND });
	});
	it("the guard still checks the hook's text", async () => {
		const s = await piSession(activate, force((b) => `${b}\n\n${PI_PREAMBLE} (quoted)`));
		assert.match((await turn(s)).error, /refusing to send this prompt/);
	});
	it("refuses a run whose base a hook edited, and the refusal ends with the run (F1, F2, pause chain)", async () => {
		let late = true, suffix = "\n\nDOC", forced;
		const edit = (when) => (pi) => pi.on("before_agent_start", (e) => { if (late === when) e.systemPromptOptions.customPrompt = "Custom base."; });
		const s = await piSession(edit(false), activate, edit(true), force((b) => (forced = b + suffix)));
		assert.match((await turn(s)).error, /does not contain this run's \d+-char base prompt unchanged.*appendSystemPrompt/s);
		[late, suffix] = [false, "\n\nDOC\n\nPAUSED"];
		assert.deepEqual(await turn(s), { append: `Custom base.\n\n${APPEND}\n\nDOC\n\nPAUSED` }, "F2: a paused run links through the refused prompt");
		assert.equal(__test.promptCaptures.resolve(forced).inherited[0].parent.forced, true, "the paused prompt links to the earlier forced one");
		suffix = "\n\nDOC";
		assert.deepEqual(await turn(s), { append: `Custom base.\n\n${APPEND}\n\nDOC` }, "F1: the refused text works in a valid run");
	});
});

describe("forced prompt through the bridge hooks", () => {
	const hooks = {};
	let provider;
	activate({ on: (name, handler) => (hooks[name] = handler), registerProvider: (_name, config) => (provider = config), registerTool: () => {} });
	const B = "Base prompt.";
	const event = (options, base = B) => ({ systemPromptOptions: options, get systemPrompt() { return options.forceSystemPrompt ?? base; } });
	const ctxOf = (id, prompt) => ({ sessionManager: { getSessionId: () => id }, getSystemPrompt: () => prompt });
	function run(id, forced, prompt = forced, base = B) {
		const options = { appendSystemPrompt: APPEND, forceSystemPrompt: forced };
		hooks.before_agent_start(event(options, base), ctxOf(id, prompt));
		hooks.agent_start({}, ctxOf(id, prompt));
		return options;
	}
	async function query(id, systemPrompt) {
		const context = { systemPrompt, messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] };
		const result = await provider.streamSimple(provider.models[0], context, { sessionId: id }).result();
		return result.stopReason === "error" ? { error: result.errorMessage } : { append: sent.at(-1) };
	}
	const project = (prompt) => projectPromptCapture(__test.promptCaptures.resolveOrDerive(prompt), { skillReadTool: "none" });

	it("self-check: pi's prompt at agent_start must be the forced value", async () => {
		run("self-check", `${B}\n\nSELF`, "another prompt");
		assert.match((await query("self-check", `${B}\n\nSELF`)).error, /self-check at agent_start/);
	});
	it("turn_start re-records the forced prompt, and refuses a changed one rather than drop it (F3)", async () => {
		const options = run("turns", `${B}\n\nTURNS`);
		hooks.turn_start({}, ctxOf("turns", `${B}\n\nTURNS`));
		assert.equal(__test.promptCaptures.resolve(`${B}\n\nTURNS`).source, "turn_start");
		assert.deepEqual(await query("turns", `${B}\n\nTURNS`), { append: `${APPEND}\n\nTURNS` });
		options.forceSystemPrompt = `${B}\n\nCHANGED`;
		hooks.turn_start({}, ctxOf("turns", options.forceSystemPrompt));
		assert.equal(__test.promptCaptures.resolve(options.forceSystemPrompt), undefined, "not recorded as an ordinary prompt");
		assert.match((await query("turns", options.forceSystemPrompt)).error, /turn_start: .*does not match/);
	});
	it("two sessions on one activation keep their own run state (F3)", async () => {
		const one = { appendSystemPrompt: APPEND }, forced = `${B}\n\nSESSION ONE`;
		hooks.before_agent_start(event(one), ctxOf("one", B));
		one.forceSystemPrompt = forced; // a forcing hook after the bridge's
		hooks.before_agent_start(event({ appendSystemPrompt: "Other." }, "Other base."), ctxOf("two", "Other base."));
		hooks.agent_start({}, ctxOf("one", forced));
		assert.deepEqual(await query("one", forced), { append: `${APPEND}\n\nSESSION ONE` });
	});
	it("a subagent and a grandchild forward a forced parent; an unlinked forced parent fails", () => {
		const parent = `${B}\n\nPARENT`, child = `${parent}\n\nCHILD`;
		run("parent", parent);
		hooks.before_agent_start(event({ customPrompt: child }, child), ctxOf("child", child));
		assert.equal(project(child), `${APPEND}\n\nPARENT\n\nCHILD`);
		assert.equal(project(`${child}\n\nGRANDCHILD`), `${APPEND}\n\nPARENT\n\nCHILD\n\nGRANDCHILD`);
		run("orphan", "Rewritten whole prompt.");
		assert.throws(() => project("Rewritten whole prompt.\n\nCHILD"), /contains no recorded base prompt.*appendSystemPrompt/s);
	});
	it("eviction of the base does not cause a false refusal (F4)", async () => {
		const base = "Evicted base.", forced = `${base}\n\nKEPT`;
		run("evict", forced, forced, base);
		// Queries keep the forced prompt in use while 260 other prompts push the base out.
		for (let i = 0; i < 260; i++) { __test.promptCaptures.record(`filler ${i}`, { contextFiles: [], skills: [] }); __test.promptCaptures.resolve(forced); }
		assert.equal(__test.promptCaptures.resolve(base), undefined, "the base was evicted");
		run("evict", forced, forced, base);
		assert.deepEqual(await query("evict", forced), { append: `${APPEND}\n\nKEPT` });
	});
});
