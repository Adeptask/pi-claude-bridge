#!/usr/bin/env node

/**
 * Gaps the agent_start capture does NOT close, pinned so the boundary is explicit.
 *
 * The agent_start record keys the prompt pi renders from the final before_agent_start
 * options (ctx.getSystemPrompt()), carrying the stashed portable parts. That fixes the
 * widened-dispatch case (see unit-agent-start-capture.mjs). The reported failure shapes
 * that still fall outside it:
 *
 * 1. Tail-stripped inheritance (issue #88): a child embedding its parent prompt minus
 *    pi's per-session tail (skills catalogue, cwd footer) matches no full-prompt key.
 *    (gotgenes/pi-subagents strips the tail; elidickinson/pi-subagents embeds verbatim
 *    and is covered by the agent_start record.)
 * 2. A prompt composed entirely outside pi's before_agent_start pipeline (issue #102's
 *    pi-web-ui shape) is neither a rendered-options key, a handler-returned force
 *    (which agent_start does capture — see the force test below), nor an embedding.
 * 3. A prompt that changes mid-run (issue #91's multi-turn shape): agent_start fires
 *    once per run, not per turn, so a later turn's re-rendered prompt is unrecorded.
 *    (The re-render path is pi's section-based prompt, post-0.85.1; on 0.85.1 a mid-run
 *    setActiveToolsByName change has the same effect.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi(activateFn) {
	const handlers = new Map();
	(activateFn ?? activate)({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: () => {},
		registerTool: () => {},
	});
	return handlers;
}

describe("agent_start capture — documented gaps", () => {
	it("makes isolated subagent captures resolve via the shared registry (#64)", async () => {
		const parent = activateWithMockPi();
		// An isolated agent re-evaluates the module; its records land in the same
		// process-wide registry the pinned stream resolves against.
		const { default: activateFresh, __test: freshTest } = await import("../src/index.js?isolated-child");
		const child = activateWithMockPi(activateFresh);

		const isolatedPrompt = "You are an isolated smoke-test agent. Respond with ZZ_ISO_OK.";
		child.get("before_agent_start")({ systemPrompt: isolatedPrompt, systemPromptOptions: {} });
		child.get("agent_start")({}, { getSystemPrompt: () => isolatedPrompt });

		assert.ok(freshTest.promptCaptures.resolve(isolatedPrompt), "the child instance recorded its own prompt");
		assert.ok(
			__test.promptCaptures.resolveOrDerive(isolatedPrompt),
			"the shared registry the pinned stream resolves against resolves the child's prompt",
		);
		assert.equal(freshTest.promptCaptures, __test.promptCaptures, "both instances share one capture registry");
	});

	it("does not match a child embedding a tail-stripped parent prompt (#88)", () => {
		const handlers = activateWithMockPi();
		const parentTail = "\n\nThe following skills provide specialized instructions.\n<available_skills>...</available_skills>\n\nCurrent working directory: /parent";
		const parent = "You are pi.\n# Tools\n- read: Read a file" + parentTail;
		handlers.get("before_agent_start")({ systemPrompt: parent, systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => parent });

		// gotgenes/pi-subagents inheritedIdentity embeds the parent minus the per-session tail.
		const strippedChild = `You are pi.\n# Tools\n- read: Read a file\n\n<sub_agent_context>child rules</sub_agent_context>`;
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive(strippedChild),
			/no capture/,
			"the full assembled prompt is not a substring of its tail-stripped embedding",
		);
	});

	it("does capture a handler-returned wholesale replacement: it resolves via the agent_start key", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "pi rendered prompt", systemPromptOptions: {} });
		// A before_agent_start handler that RETURNS a system prompt forces it as the request
		// head, and pi renders ctx.getSystemPrompt() as exactly that forced text
		// (buildSystemPromptState returns forceSystemPrompt verbatim).
		handlers.get("agent_start")({}, { getSystemPrompt: () => "forced replacement prompt owning the request head" });

		const capture = __test.promptCaptures.resolve("forced replacement prompt owning the request head");
		assert.ok(capture, "the forced text becomes a capture key at agent_start");
		// Caveat pinned by design: only the portable parts are projected for Claude Code;
		// the forced text's own novel prose is not forwarded (forwarding pi-harness-shaped
		// prose would trip the server's third-party gate).
	});

	it("does not rescue a prompt composed outside the before_agent_start pipeline (#102 shape)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "pi rendered prompt", systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => "pi rendered prompt" });

		// A host composing the prompt from its own template outside pi's pipeline —
		// neither a rendered-options key, a handler-returned force, nor an embedding.
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive("host-composed prompt owning the request head"),
			/no capture/,
			"out-of-pipeline composition is neither a recorded key nor an embedding of one",
		);
	});

	it("does not re-record a prompt that widens again mid-run (#91 multi-turn shape)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "turn-1 prompt", systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => "turn-1 prompt" });

		// agent_start fires once per agent run. If MCP snippets merge before a later
		// in-run turn (prepareNextTurnWithContext), the turn-2 render is a new prompt
		// nothing recorded.
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive("turn-2 prompt with an MCP tool description merged in"),
			/no capture/,
			"mid-run re-assembly is not captured by a run-scoped agent_start record",
		);
	});
});
