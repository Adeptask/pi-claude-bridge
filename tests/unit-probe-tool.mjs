#!/usr/bin/env node

// claude_bridge_probe is registered in every session, AskClaude or not, so other
// extensions can detect the bridge. It returns constant text and changes nothing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { globalConfigPath } from "../src/config.js";

const { default: activate } = await import("../src/index.js");

// Activates under a global config. The notice markers and plan keep activation from writing it back.
function activateWith(askClaude) {
	const path = globalConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ startupNoticeShown: "2026-01-01", askClaudeDeprecationShown: "2026-01-01", provider: { plan: "max" }, askClaude }));
	const tools = [];
	try {
		activate({ on: () => {}, registerProvider: () => {}, registerTool: (tool) => tools.push(tool) });
	} finally {
		rmSync(path, { force: true });
	}
	return tools;
}

const homeFiles = () => readdirSync(process.env.HOME, { recursive: true });

describe("claude_bridge_probe", () => {
	it("is the only tool when AskClaude is disabled", () => {
		assert.deepEqual(activateWith({ enabled: false }).map((tool) => tool.name), ["claude_bridge_probe"]);
	});

	it("is registered alongside AskClaude when AskClaude is enabled", () => {
		assert.deepEqual(activateWith({ enabled: true }).map((tool) => tool.name).sort(), ["AskClaude", "claude_bridge_probe"]);
	});

	it("returns the constant text and changes no observable state", async () => {
		const probe = activateWith({ enabled: false })[0];
		assert.deepEqual(probe.parameters.properties, {});
		assert.match(probe.description, /never need to call it/);
		const before = { files: homeFiles(), env: { ...process.env } };
		const results = [await probe.execute("call-1", {}), await probe.execute("call-2", {})];
		for (const result of results) assert.deepEqual(result, { content: [{ type: "text", text: "Claude bridge is loaded." }], details: {} });
		assert.deepEqual({ files: homeFiles(), env: { ...process.env } }, before);
	});
});

describe("pi version floor", () => {
	it("declares >=1.2.0 for every pi peer package", () => {
		const { peerDependencies } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
		for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
			assert.equal(peerDependencies[name], ">=1.2.0", name);
		}
	});

	it("states the floor in the README and the startup error", () => {
		assert.ok(readFileSync(new URL("../README.md", import.meta.url), "utf-8").includes("Requires pi 1.2.0 or newer"));
		assert.match(readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8"), /no models available[^\n]*>=1\.2\.0/);
	});
});
