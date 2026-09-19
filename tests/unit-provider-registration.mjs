#!/usr/bin/env node

/**
 * Provider registration across module instances (issue #91's foreground failure).
 *
 * The first bridge instance registers the claude-bridge provider at activation.
 * A later instance — a subagent session that loaded this module fresh — must
 * decide at session_start based on who owns its session's model registry:
 * hosts that pass the parent's registry down already have the provider
 * (re-registering would overwrite the parent's pinned stream fn), while hosts
 * that give the child its own registry need it registered or every
 * claude-bridge/* dispatch fails with "Model not found".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const PROVIDER_ID = "claude-bridge";

const { default: activate } = await import("../src/index.js");

function activateWithMockPi(activateFn, options = {}) {
	const handlers = new Map();
	const registered = [];
	(activateFn ?? activate)({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: (name, config) => registered.push({ name, config }),
		registerTool: () => {},
	});
	return { handlers, registered };
}

function registryWith(provider) {
	return { getProvider: (id) => (id === provider ? { name: provider } : undefined) };
}

describe("provider registration across module instances", () => {
	it("first instance registers at activation", () => {
		const { registered } = activateWithMockPi();
		assert.equal(registered.length, 1, "exactly one activation-time registration");
		assert.equal(registered[0].name, PROVIDER_ID);
	});

	it("later instance registers at session_start when its registry lacks the provider (#91)", async () => {
		// A fresh module instance: the activate-time registration is skipped, and
		// the decision moves to session_start with the session's own registry.
		const { default: activateFresh } = await import("../src/index.js?own-registry-child");
		const { handlers, registered } = activateWithMockPi(activateFresh);
		assert.equal(registered.length, 0, "no activation-time registration for a later instance");

		handlers.get("session_start")({}, { modelRegistry: registryWith("other-provider") });
		assert.equal(registered.length, 1, "session_start registers into the empty registry");
		assert.equal(registered[0].name, PROVIDER_ID);
		assert.ok(registered[0].config.streamSimple, "the registration carries this instance's stream fn");
	});

	it("later instance does not re-register when the registry already has the provider", async () => {
		const { default: activateFresh } = await import("../src/index.js?shared-registry-child");
		const { handlers, registered } = activateWithMockPi(activateFresh);

		// Host passed the parent's registry down: the provider is already there.
		handlers.get("session_start")({}, { modelRegistry: registryWith(PROVIDER_ID) });
		assert.equal(registered.length, 0, "no overwrite of the parent's registration");

		// Repeated session starts stay idempotent.
		handlers.get("session_start")({}, { modelRegistry: registryWith(PROVIDER_ID) });
		assert.equal(registered.length, 0, "still no registration on a later session_start");
	});
});
