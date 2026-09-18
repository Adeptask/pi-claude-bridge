// Model selection + display-order policy for the model picker. The picker is
// driven by pi-ai's anthropic catalog: models appear (and disappear) with it,
// no per-model code here. Extracted from index.ts so tests can import without
// activating the extension.
// `resolveModel` returns the first partial match, so sort order decides which
// member of a family the `opus`/`sonnet`/`fable` shortcuts resolve to.

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// pi-ai ships dated snapshot ids (claude-opus-4-5-20251101, ...) alongside the
// bare ids. They are never exposed - and must not steal first-partial-match
// shortcuts like "opus-4-5" from the bare id.
function isDatedAlias(id: string): boolean {
	return /-20\d{6}$/.test(id);
}

// Newest generation first, so the shortcuts resolve to the latest member of
// each family. Family tiers are ordered so flagship families sort first.
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// newest generation first. Context-dependent display labels are applied after
// plan/long-context config is known.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	// Family tier ascending, then version descending. Unknown families get a
	// sentinel that sinks them so they cannot steal first-partial-match shortcuts.
	const rank = (id: string) => {
		const [, family, major, minor] = id.split("-");
		const fi = FAMILY_ORDER.indexOf(family);
		return [fi === -1 ? FAMILY_ORDER.length : fi, Number(major) || 0, Number(minor) || 0];
	};
	return piAiModels
		.filter((m) => !isDatedAlias(m.id))
		.sort((a, b) => {
			const ra = rank(a.id);
			const rb = rank(b.id);
			if (ra[0] !== rb[0]) return (ra[0] as number) - (rb[0] as number);
			for (let i = 1; i < 3; i++) {
				if (ra[i] !== rb[i]) return (rb[i] as number) - (ra[i] as number);
			}
			return a.id.localeCompare(b.id);
		})
		// Forward thinkingLevelMap so pi-ai's per-model overrides (e.g. opus-4-8
		// mapping xhigh→xhigh and max→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	// Model ids whose declared 1M context Claude Code turned out not to serve;
	// forces bare id at 200K without a code change.
	forceTwoHundredK?: string[];
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

// Measured Claude Agent SDK behavior - see diag/CONTEXT-SIZE.md:
// - The `[1m]` suffix is the only reliable way to request 1M context through
//   the SDK; bare ids serve 200K.
// - The registered contextWindow must match the window the bridge actually
//   requests, or pi's status bar and compaction threshold misreport.
// Default policy follows pi-ai's declared contextWindow: declared 1M → `[1m]`
// id registered at 1M. Deviations below exist only where measured behavior
// contradicts the declaration.
export function resolveClaudeCodeRuntimeModel(
	model: { id: string; contextWindow?: number | null },
	settings: LongContextSettings,
): ClaudeCodeRuntimeModel {
	const modelId = model.id;
	if (settings.forceTwoHundredK?.includes(modelId)) {
		return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
	switch (modelId) {
		// pi-ai declares 1M, but the SDK only serves it when the plan allows.
		case "claude-opus-4-6":
		case "claude-sonnet-4-6": {
			const useOneM = modelId === "claude-opus-4-6"
				? settings.plan === "max" || settings.longContextExtraUsage
				: settings.longContextExtraUsage;
			return {
				cliModelId: useOneM ? `${modelId}[1m]` : modelId,
				contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		}
		default:
			// Treat a missing declaration as 200K: bare ids are measured to serve 200K,
			// so bare id + 200K registration is self-consistent (safe side).
			if ((model.contextWindow ?? TWO_HUNDRED_K_CONTEXT) > TWO_HUNDRED_K_CONTEXT) {
				return { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT };
			}
			return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
}

export function claudeCodeModelId(model: { id: string; contextWindow?: number | null }, settings: LongContextSettings): string {
	return resolveClaudeCodeRuntimeModel(model, settings).cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport. The runtime policy is based
// on measured SDK behavior - see diag/CONTEXT-SIZE.md
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	return models.map((m) => {
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}
