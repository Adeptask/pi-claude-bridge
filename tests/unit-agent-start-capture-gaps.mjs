#!/usr/bin/env node

/**
 * Gaps the agent_start capture does NOT close, pinned so the boundary is explicit.
 *
 * The agent_start record keys the prompt pi renders from the final before_agent_start
 * options (ctx.getSystemPrompt()), carrying the stashed portable parts. That fixes the
 * widened-dispatch case (see unit-agent-start-capture.mjs). Three reported failure
 * shapes still fall outside it:
 *
 * 1. Isolated subagents (issue #64): a re-evaluated bridge module keeps its own capture
 *    map while the shared stream function still resolves against the first instance's
 *    map, so the child's own records land in a map nobody reads.
 * 2. Tail-stripped inheritance (issue #88): a child embedding its parent prompt minus
 *    pi's per-session tail (skills catalogue, cwd footer) matches no full-prompt key.
 * 3. A prompt replaced wholesale after before_agent_start (the forceSystemPrompt path,
 *    issue #102's shape): the forced text is neither the rendered options nor an
 *    embedding of any recorded key. Same for a prompt that widens again mid-run
 *    (issue #91's multi-turn shape): agent_start fires once per run, not per turn.
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
	it("does not help isolated subagents that record into a fresh module instance (#64)", async () => {
		const parent = activateWithMockPi();
		// An isolated agent re-evaluates the module; its records land in its own map.
		const { default: activateFresh, __test: freshTest } = await import("../src/index.js?isolated-child");
		const child = activateWithMockPi(activateFresh);

		const isolatedPrompt = "You are an isolated smoke-test agent. Respond with ZZ_ISO_OK.";
		child.get("before_agent_start")({ systemPrompt: isolatedPrompt, systemPromptOptions: {} });
		child.get("agent_start")({}, { getSystemPrompt: () => isolatedPrompt });

		assert.ok(freshTest.promptCaptures.resolve(isolatedPrompt), "the child instance recorded its own prompt");
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive(isolatedPrompt),
			/no capture/,
			"the parent-instance map the pinned stream resolves against still misses it",
		);
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

	it("does not rescue a prompt replaced wholesale after before_agent_start (#102 shape)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "pi rendered prompt", systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => "pi rendered prompt" });

		// A before_agent_start handler that RETURNS a system prompt forces it as the
		// request head; the forced text is not buildSystemPrompt(options) output.
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive("wholesale replacement prompt owning the request head"),
			/no capture/,
			"a forced replacement is neither a recorded key nor an embedding of one",
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
