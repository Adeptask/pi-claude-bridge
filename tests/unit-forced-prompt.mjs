/**
 * A prompt a before_agent_start hook returns reaches Claude Code: each test asserts the
 * append query() receives, or the turn's error. Real pi sessions run pi's ExtensionRunner.
 * The second describe drives the bridge hooks directly, for cases pi 1.2.0 cannot produce:
 * - self-check and turn_start changes: pi renders the forced value verbatim all run;
 * - two sessions on one activation: each real session here activates its own bridge;
 * - subagent and grandchild: dispatch needs pi-subagents, so the hooks get the child prompt;
 * - eviction: needs 256 other prompts;
 * - ordinary and forced collisions: need two sessions that render one text differently;
 * - render failure: pi's render does not throw;
 * - session_shutdown cleanup: the state is visible only through the hooks;
 * - AskClaude: its tool is off by default, so the test calls its skill resolver.
 * The file loads with a registry an older bridge left on globalThis, as after /reload.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// An older PromptCaptures class has no recordForced.
const stale = { record() {}, resolve() {}, resolveOrDerive() {}, size: 0 };
globalThis[Symbol.for("claude-bridge:promptCaptures")] = stale;
const { default: activate, __test } = await import("../src/index.js");
const { PI_PREAMBLE, projectPromptCapture } = await import("../src/prompt-capture.js");

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
	// Its own cwd gives each session its own pi prompt, so no test reuses another's captures.
	const cwd = mkdtempSync(join(HOME, "s-"));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, appendSystemPrompt: [APPEND], extensionFactories });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager, model: MODEL });
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
const WRAPS = { prefix: (b) => `PRE\n\n${b}`, suffix: (b) => `${b}\n\nPOST`, wrapper: (b) => `PRE\n\n${b}\n\nPOST`, unchanged: (b) => b };
const SENT = { prefix: `PRE\n\n${APPEND}`, suffix: `${APPEND}\n\nPOST`, wrapper: `PRE\n\n${APPEND}\n\nPOST`, unchanged: APPEND };

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
	it("an unforced session sends the portable parts as before, and ignores the older registry", async () => {
		assert.deepEqual(await turn(await piSession(activate)), { append: APPEND });
		assert.notEqual(__test.promptCaptures, stale);
	});
	it("the guard still checks the hook's text", async () => {
		const s = await piSession(activate, force((b) => `${b}\n\n${PI_PREAMBLE} (quoted)`));
		assert.match((await turn(s)).error, /refusing to send this prompt/);
	});
	it("refuses a run whose base a hook edited, and the refusal ends with the run (F1, F2, pause chain)", async () => {
		let late = true, suffix = "\n\nDOC", forced;
		const edit = (when) => (pi) => pi.on("before_agent_start", (e) => { if (late === when) e.systemPromptOptions.customPrompt = "Custom base."; });
		const s = await piSession(edit(false), activate, edit(true), force((b) => (forced = b + suffix)));
		assert.match((await turn(s)).error, /does not contain pi's own \d+-char system prompt for this run unchanged.*after the bridge's hook and before the forcing hook.*appendSystemPrompt/s);
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
	const shutdown = (id) => hooks.session_shutdown({}, ctxOf(id));
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
		const options = run("turns", `${B}\n\nTURNS`), changed = `${B}\n\nCHANGED`;
		options.forceSystemPrompt = changed; // pi copies the options each turn: the bridge's copy is stale
		hooks.turn_start({}, ctxOf("turns", `${B}\n\nTURNS`));
		assert.equal(__test.promptCaptures.resolve(`${B}\n\nTURNS`).source, "turn_start");
		assert.deepEqual(await query("turns", `${B}\n\nTURNS`), { append: `${APPEND}\n\nTURNS` });
		hooks.turn_start({}, ctxOf("turns", changed));
		assert.equal(__test.promptCaptures.resolve(changed), undefined, "not recorded as an ordinary prompt");
		const { error } = await query("turns", changed);
		assert.match(error, /turn_start: .*does not match/);
		assert.doesNotMatch(error, /appendSystemPrompt/, "the advice is only for a hook's prompt shape");
	});
	it("an unforced run reads only pi's prompt at turn_start", () => {
		const options = run("unforced", undefined, `${B}\n\nUNFORCED`);
		options.forceSystemPrompt = `${B}\n\nSTALE`;
		hooks.turn_start({}, ctxOf("unforced", `${B}\n\nUNFORCED TURN`));
		assert.equal(__test.promptCaptures.resolve(`${B}\n\nUNFORCED TURN`).forced, undefined);
	});
	it("an ordinary prompt never overwrites a forced one, and a forced one never takes an ordinary key", async () => {
		const forced = `${B}\n\nKIND`;
		run("kind-forced", forced);
		run("kind-ordinary", undefined, forced, forced);
		assert.deepEqual(await query("kind-forced", forced), { append: `${APPEND}\n\nKIND` });
		const ordinary = `${B}\n\nORDINARY`;
		run("kind-first", undefined, ordinary, ordinary);
		run("kind-second", ordinary);
		const { error } = await query("kind-second", ordinary);
		assert.match(error, /already recorded as an ordinary prompt/);
		assert.doesNotMatch(error, /appendSystemPrompt/);
	});
	it("a failed render restores the forced value and refuses the run", async () => {
		const options = { appendSystemPrompt: APPEND, forceSystemPrompt: `${B}\n\nRENDER` };
		const failing = { systemPromptOptions: options, get systemPrompt() { if (!options.forceSystemPrompt) throw new Error("boom"); return options.forceSystemPrompt; } };
		hooks.before_agent_start(failing, ctxOf("render", B));
		assert.equal(options.forceSystemPrompt, `${B}\n\nRENDER`);
		assert.match((await query("render", `${B}\n\nRENDER`)).error, /rendering pi's own system prompt for this run failed: boom$/);
	});
	it("session_shutdown clears the session's refusal and run", async () => {
		run("ended", `${B}\n\nENDED`, "another prompt");
		shutdown("ended");
		assert.deepEqual(await query("ended", B), { append: APPEND });
		hooks.turn_start({}, ctxOf("ended", `${B}\n\nAFTER`));
		assert.equal(__test.promptCaptures.resolve(`${B}\n\nAFTER`).source, "turn_start");
	});
	it("AskClaude fails like the turn for a refused run or an unlinked forced prompt", () => {
		run("ask", "Replaced prompt.");
		assert.throws(() => __test.resolveSkillCapture("Replaced prompt.", "ask"), /refusing this call: .*does not contain/);
		shutdown("ask");
		assert.throws(() => __test.resolveSkillCapture("Replaced prompt.", "ask"), /contains no system prompt pi rendered/);
		assert.equal(__test.resolveSkillCapture(B, "ask").assembledPrompt, B);
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
		assert.throws(() => project("Rewritten whole prompt.\n\nCHILD"), /contains no system prompt pi rendered.*appendSystemPrompt/s);
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
