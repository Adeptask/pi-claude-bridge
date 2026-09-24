// --import preload, after tsx: replace only the SDK query export for this test process.
import { registerHooks } from "node:module";
const fake = new URL("./fake-agent-sdk.mjs", import.meta.url).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@anthropic-ai/claude-agent-sdk") return { url: fake, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
