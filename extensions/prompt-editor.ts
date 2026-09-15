/**
 * Prompt editor and model mode manager for the Pi coding agent.
 *
 * Integrates a bordered custom prompt editor with live mode badges, thinking-level
 * border highlights, and cross-session prompt history navigation. Modes bundle
 * provider, model, thinking level, and accent colors, persisted to `modes.json`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";

type ModeName = string;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ModeSpec {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	/** Optional theme color token for the editor border. Defaults to thinking-level color. */
	color?: string;
}

interface ModesFile {
	version: 1;
	currentMode: ModeName;
	modes: Record<ModeName, ModeSpec>;
}

const DEFAULT_MODE_ORDER = ["default"] as const;
const CUSTOM_MODE_NAME = "custom" as const;

function expandUserPath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function getGlobalAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return expandUserPath(env);
	return path.join(os.homedir(), ".pi", "agent");
}

function getGlobalModesPath(): string {
	return path.join(getGlobalAgentDir(), "modes.json");
}

function getProjectModesPath(cwd: string): string {
	return path.join(cwd, ".pi", "modes.json");
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function ensureDirForFile(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function getMtimeMs(p: string): Promise<number | null> {
	try {
		const st = await fs.stat(p);
		return st.mtimeMs;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLockPathForFile(filePath: string): string {
	return `${filePath}.lock`;
}

/**
 * Executes an operation under a cross-process advisory file lock.
 *
 * Prevents concurrent Pi instances from clobbering `modes.json`. Automatically
 * reclaims stale lock files older than 30 seconds left behind by crashed processes.
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = getLockPathForFile(filePath);
	await ensureDirForFile(lockPath);

	const start = Date.now();
	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx");
			try {
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n",
					"utf8",
				);
			} catch {
				// Lock metadata write failure is non-fatal.
			}

			try {
				return await fn();
			} finally {
				await handle.close().catch(() => {});
				await fs.unlink(lockPath).catch(() => {});
			}
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;

			try {
				const st = await fs.stat(lockPath);
				if (Date.now() - st.mtimeMs > 30_000) {
					await fs.unlink(lockPath);
					continue;
				}
			} catch {
				// Stat or unlink failure handled on next retry.
			}

			if (Date.now() - start > 5_000) {
				throw new Error(`Timed out waiting for lock: ${lockPath}`);
			}
			await sleep(40 + Math.random() * 80);
		}
	}
}

/**
 * Atomically writes content to a file using a temporary sibling file and replace.
 */
async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
	await ensureDirForFile(filePath);

	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`);

	await fs.writeFile(tmpPath, content, "utf8");

	try {
		await fs.rename(tmpPath, filePath);
	} catch (err: any) {
		// Windows rename cannot overwrite an existing destination file.
		if (err?.code === "EEXIST" || err?.code === "EPERM") {
			await fs.unlink(filePath).catch(() => {});
			await fs.rename(tmpPath, filePath);
		} else {
			await fs.unlink(tmpPath).catch(() => {});
			throw err;
		}
	}
}

function cloneModesFile(file: ModesFile): ModesFile {
	return JSON.parse(JSON.stringify(file)) as ModesFile;
}

interface ModeSpecPatch {
	provider?: string | null;
	modelId?: string | null;
	thinkingLevel?: ThinkingLevel | null;
	color?: string | null;
}

interface ModesPatch {
	currentMode?: ModeName;
	modes?: Record<ModeName, ModeSpecPatch | null>;
}

function computeModesPatch(base: ModesFile, next: ModesFile, includeCurrentMode: boolean): ModesPatch | null {
	const patch: ModesPatch = {};

	if (includeCurrentMode && base.currentMode !== next.currentMode) {
		patch.currentMode = next.currentMode;
	}

	const keys = new Set([...Object.keys(base.modes), ...Object.keys(next.modes)]);
	const modesPatch: Record<ModeName, ModeSpecPatch | null> = {};

	for (const k of keys) {
		const a = base.modes[k];
		const b = next.modes[k];

		if (!b) {
			if (a) modesPatch[k] = null;
			continue;
		}
		if (!a) {
			modesPatch[k] = { ...b };
			continue;
		}

		const diff: ModeSpecPatch = {};
		const fields: (keyof ModeSpec)[] = ["provider", "modelId", "thinkingLevel", "color"];
		for (const f of fields) {
			const av = a[f];
			const bv = b[f];
			if (av !== bv) {
				(diff as any)[f] = bv === undefined ? null : bv;
			}
		}
		if (Object.keys(diff).length > 0) {
			modesPatch[k] = diff;
		}
	}

	if (Object.keys(modesPatch).length > 0) {
		patch.modes = modesPatch;
	}

	if (!patch.modes && patch.currentMode === undefined) return null;
	return patch;
}

function applyModesPatch(target: ModesFile, patch: ModesPatch): void {
	if (patch.currentMode !== undefined) {
		target.currentMode = patch.currentMode;
	}

	if (!patch.modes) return;
	for (const [mode, specPatch] of Object.entries(patch.modes)) {
		if (specPatch === null) {
			delete target.modes[mode];
			continue;
		}

		const targetSpec: Record<string, unknown> = (target.modes[mode] ??= {}) as Record<string, unknown>;
		for (const [k, v] of Object.entries(specPatch)) {
			if (v === null || v === undefined) {
				delete targetSpec[k];
			} else {
				targetSpec[k] = v;
			}
		}
	}
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	if (typeof level !== "string") return undefined;
	const v = level as ThinkingLevel;
	const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	return allowed.includes(v) ? v : undefined;
}

function sanitizeModeSpec(spec: unknown): ModeSpec {
	const obj = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
	return {
		provider: typeof obj.provider === "string" ? obj.provider : undefined,
		modelId: typeof obj.modelId === "string" ? obj.modelId : undefined,
		thinkingLevel: normalizeThinkingLevel(obj.thinkingLevel),
		color: typeof obj.color === "string" ? obj.color : undefined,
	};
}

function createDefaultModes(ctx: ExtensionContext, pi: ExtensionAPI): ModesFile {
	const currentModel = ctx.model;
	const currentThinking = pi.getThinkingLevel();

	const base: ModeSpec = {
		provider: currentModel?.provider,
		modelId: currentModel?.id,
		thinkingLevel: currentThinking,
	};

	return {
		version: 1,
		currentMode: "default",
		modes: {
			default: { ...base },
			fast: { ...base, thinkingLevel: "off" },
		},
	};
}

function ensureDefaultModeEntries(file: ModesFile, ctx: ExtensionContext, pi: ExtensionAPI): void {
	for (const name of DEFAULT_MODE_ORDER) {
		if (!file.modes[name]) {
			const defaults = createDefaultModes(ctx, pi);
			file.modes[name] = defaults.modes[name];
		}
	}

	// The "custom" overlay mode must never be persisted as the active mode.
	if (file.currentMode === CUSTOM_MODE_NAME) {
		file.currentMode = "" as any;
	}

	if (!file.currentMode || !(file.currentMode in file.modes) || file.currentMode === CUSTOM_MODE_NAME) {
		const first = Object.keys(file.modes).find((k) => k !== CUSTOM_MODE_NAME);
		file.currentMode = file.modes.default ? "default" : first || "default";
	}
}

async function loadModesFile(filePath: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<ModesFile> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const currentMode = typeof parsed.currentMode === "string" ? parsed.currentMode : "default";
		const modesRaw = parsed.modes && typeof parsed.modes === "object" ? (parsed.modes as Record<string, unknown>) : {};
		const modes: Record<string, ModeSpec> = {};
		for (const [k, v] of Object.entries(modesRaw)) {
			modes[k] = sanitizeModeSpec(v);
		}
		const file: ModesFile = {
			version: 1,
			currentMode,
			modes,
		};
		ensureDefaultModeEntries(file, ctx, pi);
		return file;
	} catch {
		return createDefaultModes(ctx, pi);
	}
}

async function saveModesFile(filePath: string, data: ModesFile): Promise<void> {
	await atomicWriteUtf8(filePath, JSON.stringify(data, null, 2) + "\n");
}

function orderedModeNames(modes: Record<string, ModeSpec>): string[] {
	return Object.keys(modes).filter((name) => name !== CUSTOM_MODE_NAME);
}

function getModeBorderColor(theme: any, pi: ExtensionAPI, mode: string): (text: string) => string {
	const spec = runtime.data.modes[mode];

	if (spec?.color) {
		try {
			theme.getFgAnsi(spec.color as any);
			return (text: string) => theme.fg(spec.color as any, text);
		} catch {
			// Fall through to thinking-level border styling if color token is invalid.
		}
	}

	try {
		return theme.getThinkingBorderColor(pi.getThinkingLevel());
	} catch {
		return theme.getThinkingBorderColor("off");
	}
}

function formatModeLabel(mode: string): string {
	return mode;
}

async function resolveModesPath(cwd: string): Promise<string> {
	const projectPath = getProjectModesPath(cwd);
	if (await fileExists(projectPath)) return projectPath;
	return getGlobalModesPath();
}

interface ModeRuntime {
	filePath: string;
	fileMtimeMs: number | null;
	baseline: ModesFile | null;
	data: ModesFile;
	lastRealMode: string;
	currentMode: string;
	applying: boolean;
}

const runtime: ModeRuntime = {
	filePath: "",
	fileMtimeMs: null,
	baseline: null,
	data: { version: 1, currentMode: "default", modes: {} },
	lastRealMode: "default",
	currentMode: "default",
	applying: false,
};

let isEditorActive = false;
let requestEditorRender: (() => void) | undefined;

async function ensureRuntime(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const filePath = await resolveModesPath(ctx.cwd);

	const mtimeMs = await getMtimeMs(filePath);
	const filePathChanged = runtime.filePath !== filePath;
	const fileChanged = filePathChanged || runtime.fileMtimeMs !== mtimeMs;

	if (fileChanged) {
		runtime.filePath = filePath;
		runtime.fileMtimeMs = mtimeMs;

		const loaded = await loadModesFile(filePath, ctx, pi);
		ensureDefaultModeEntries(loaded, ctx, pi);
		runtime.data = loaded;
		runtime.baseline = cloneModesFile(runtime.data);

		if (filePathChanged && runtime.currentMode !== CUSTOM_MODE_NAME) {
			runtime.currentMode = runtime.data.currentMode;
			runtime.lastRealMode = runtime.currentMode;
		}
	}

	if (runtime.currentMode !== CUSTOM_MODE_NAME) {
		if (!runtime.currentMode || !(runtime.currentMode in runtime.data.modes)) {
			runtime.currentMode = runtime.data.currentMode;
		}
		if (!runtime.lastRealMode || !(runtime.lastRealMode in runtime.data.modes)) {
			runtime.lastRealMode = runtime.currentMode;
		}
	}
}

async function persistRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	includeCurrentMode = false,
): Promise<void> {
	if (!runtime.filePath) return;

	runtime.baseline ??= cloneModesFile(runtime.data);
	const patch = computeModesPatch(runtime.baseline, runtime.data, includeCurrentMode);
	if (!patch) return;

	await withFileLock(runtime.filePath, async () => {
		const latest = await loadModesFile(runtime.filePath, ctx, pi);
		applyModesPatch(latest, patch);
		ensureDefaultModeEntries(latest, ctx, pi);
		await saveModesFile(runtime.filePath, latest);

		runtime.data = latest;
		runtime.baseline = cloneModesFile(latest);
		runtime.fileMtimeMs = await getMtimeMs(runtime.filePath);
	});
}

let lastObservedModel: { provider?: string; modelId?: string } = {};

function getCurrentSelectionSpec(pi: ExtensionAPI, ctx: ExtensionContext): ModeSpec {
	return {
		provider: ctx.model?.provider ?? lastObservedModel.provider,
		modelId: ctx.model?.id ?? lastObservedModel.modelId,
		thinkingLevel: pi.getThinkingLevel(),
	};
}

async function storeSelectionIntoMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mode: string,
	selection: ModeSpec,
): Promise<void> {
	if (mode === CUSTOM_MODE_NAME) return;

	await ensureRuntime(pi, ctx);

	const existingTarget = runtime.data.modes[mode] ?? {};
	const next: ModeSpec = { ...existingTarget };

	if (selection.provider && selection.modelId) {
		next.provider = selection.provider;
		next.modelId = selection.modelId;
	}
	if (selection.thinkingLevel) next.thinkingLevel = selection.thinkingLevel;

	runtime.data.modes[mode] = next;
	await persistRuntime(pi, ctx);
}

async function applyMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	await ensureRuntime(pi, ctx);

	if (mode === CUSTOM_MODE_NAME) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi, ctx);
		if (ctx.hasUI && isEditorActive) requestEditorRender?.();
		return;
	}

	const spec = runtime.data.modes[mode];
	if (!spec) {
		if (ctx.hasUI) {
			ctx.ui.notify(`Unknown mode: ${mode}`, "warning");
		}
		return;
	}

	runtime.currentMode = mode;
	runtime.lastRealMode = mode;
	customOverlay = null;

	runtime.applying = true;
	let modelAppliedOk = true;
	try {
		if (spec.provider && spec.modelId) {
			const m = ctx.modelRegistry.find(spec.provider, spec.modelId);
			if (m) {
				const ok = await pi.setModel(m);
				modelAppliedOk = ok;
				if (!ok && ctx.hasUI) {
					ctx.ui.notify(`No API key available for ${spec.provider}/${spec.modelId}`, "warning");
				}
			} else {
				modelAppliedOk = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`Mode "${mode}" references unknown model ${spec.provider}/${spec.modelId}`, "warning");
				}
			}
		}

		if (spec.thinkingLevel) {
			pi.setThinkingLevel(spec.thinkingLevel);
		}
	} finally {
		runtime.applying = false;
	}

	if (!modelAppliedOk) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi, ctx);
	} else {
		runtime.data.currentMode = mode;
		await persistRuntime(pi, ctx, true);
	}

	if (ctx.hasUI && isEditorActive) {
		requestEditorRender?.();
	}
}

const MODE_UI_CONFIGURE = "Configure modes…";
const MODE_UI_ADD = "Add mode…";
const MODE_UI_BACK = "Back";
const MODE_UI_DEACTIVATE = "Deactivate prompt editor";

const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_UNSET_LABEL = "(don't change)";

function isDefaultModeName(name: string): boolean {
	return (DEFAULT_MODE_ORDER as readonly string[]).includes(name);
}

function isReservedModeName(name: string): boolean {
	return (
		name === CUSTOM_MODE_NAME ||
		name === MODE_UI_CONFIGURE ||
		name === MODE_UI_ADD ||
		name === MODE_UI_BACK ||
		name === MODE_UI_DEACTIVATE
	);
}

function normalizeModeNameInput(name: string | undefined): string {
	return (name ?? "").trim();
}

function validateModeNameOrError(
	name: string,
	existing: Record<string, ModeSpec>,
	opts?: { allowExisting?: boolean },
): string | null {
	if (!name) return "Mode name cannot be empty";
	if (/\s/.test(name)) return "Mode name cannot contain whitespace";
	if (isReservedModeName(name)) return `Mode name "${name}" is reserved`;
	if (!opts?.allowExisting && existing[name]) return `Mode "${name}" already exists`;
	return null;
}

async function handleModeChoiceUI(pi: ExtensionAPI, ctx: ExtensionContext, choice: string): Promise<void> {
	if (runtime.currentMode === CUSTOM_MODE_NAME && choice !== CUSTOM_MODE_NAME) {
		const action = await ctx.ui.select(`Mode "${choice}"`, ["use", "store"]);
		if (!action) return;

		if (action === "use") {
			await applyMode(pi, ctx, choice);
			return;
		}

		await ensureRuntime(pi, ctx);
		const overlay = customOverlay ?? getCurrentSelectionSpec(pi, ctx);
		await storeSelectionIntoMode(pi, ctx, choice, overlay);
		await applyMode(pi, ctx, choice);
		ctx.ui.notify(`Stored ${CUSTOM_MODE_NAME} into "${choice}"`, "info");
		return;
	}

	await applyMode(pi, ctx, choice);
}

async function selectModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);
		const names = orderedModeNames(runtime.data.modes);
		const choice = await ctx.ui.select(`Mode (current: ${runtime.currentMode})`, [
			...names,
			MODE_UI_CONFIGURE,
			MODE_UI_DEACTIVATE,
		]);
		if (!choice) return;

		if (choice === MODE_UI_DEACTIVATE) {
			deactivateEditor(ctx);
			return;
		}

		if (choice === MODE_UI_CONFIGURE) {
			await configureModesUI(pi, ctx);
			continue;
		}

		await handleModeChoiceUI(pi, ctx, choice);
		return;
	}
}

async function configureModesUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);
		const names = orderedModeNames(runtime.data.modes);
		const choice = await ctx.ui.select("Configure modes", [...names, MODE_UI_ADD, MODE_UI_BACK]);
		if (!choice || choice === MODE_UI_BACK) return;

		if (choice === MODE_UI_ADD) {
			const created = await addModeUI(pi, ctx);
			if (created) {
				await editModeUI(pi, ctx, created);
			}
			continue;
		}

		await editModeUI(pi, ctx, choice);
	}
}

async function addModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input("New mode name", "e.g. docs, review, planning");
		if (raw === undefined) return undefined;

		const name = normalizeModeNameInput(raw);
		const err = validateModeNameOrError(name, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		const selection = customOverlay ?? getCurrentSelectionSpec(pi, ctx);
		runtime.data.modes[name] = {
			provider: selection.provider,
			modelId: selection.modelId,
			thinkingLevel: selection.thinkingLevel,
		};
		await persistRuntime(pi, ctx);
		ctx.ui.notify(`Added mode "${name}"`, "info");
		return name;
	}
}

async function editModeUI(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	if (!ctx.hasUI) return;

	let modeName = mode;

	while (true) {
		await ensureRuntime(pi, ctx);
		const spec = runtime.data.modes[modeName];
		if (!spec) return;

		const modelLabel = spec.provider && spec.modelId ? `${spec.provider}/${spec.modelId}` : "(no model)";
		const thinkingLabel = spec.thinkingLevel ?? THINKING_UNSET_LABEL;

		const actions = ["Change name", "Change model", "Change thinking level"];
		if (!isDefaultModeName(modeName)) actions.push("Delete mode");
		actions.push(MODE_UI_BACK);

		const action = await ctx.ui.select(
			`Edit mode "${modeName}"  model: ${modelLabel}  thinking: ${thinkingLabel}`,
			actions,
		);
		if (!action || action === MODE_UI_BACK) return;

		if (action === "Change name") {
			const renamed = await renameModeUI(pi, ctx, modeName);
			if (renamed) modeName = renamed;
			continue;
		}

		if (action === "Change model") {
			const selected = await pickModelForModeUI(ctx, spec);
			if (!selected) continue;
			spec.provider = selected.provider;
			spec.modelId = selected.modelId;
			runtime.data.modes[modeName] = spec;
			await persistRuntime(pi, ctx);
			ctx.ui.notify(`Updated model for "${modeName}"`, "info");

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			}
			continue;
		}

		if (action === "Change thinking level") {
			const level = await pickThinkingLevelForModeUI(ctx, spec.thinkingLevel);
			if (level === undefined) continue;

			if (level === null) {
				delete spec.thinkingLevel;
			} else {
				spec.thinkingLevel = level;
			}

			runtime.data.modes[modeName] = spec;
			await persistRuntime(pi, ctx);
			ctx.ui.notify(`Updated thinking level for "${modeName}"`, "info");

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			}
			continue;
		}

		if (action === "Delete mode") {
			const ok = await ctx.ui.confirm("Delete mode", `Delete mode "${modeName}"?`);
			if (!ok) continue;

			delete runtime.data.modes[modeName];
			await persistRuntime(pi, ctx);

			if (runtime.currentMode === modeName) {
				runtime.currentMode = CUSTOM_MODE_NAME;
				customOverlay = getCurrentSelectionSpec(pi, ctx);
			}
			if (runtime.lastRealMode === modeName) {
				runtime.lastRealMode = "default";
			}
			if (isEditorActive) {
				requestEditorRender?.();
			}
			ctx.ui.notify(`Deleted mode "${modeName}"`, "info");
			return;
		}
	}
}

function renameModesRecord(modes: Record<string, ModeSpec>, oldName: string, newName: string): Record<string, ModeSpec> {
	const out: Record<string, ModeSpec> = {};
	for (const [k, v] of Object.entries(modes)) {
		if (k === oldName) out[newName] = v;
		else out[k] = v;
	}
	return out;
}

async function renameModeUI(pi: ExtensionAPI, ctx: ExtensionContext, oldName: string): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;

	if (isDefaultModeName(oldName)) {
		ctx.ui.notify(`Cannot rename default mode "${oldName}"`, "warning");
		return oldName;
	}

	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input(`Rename mode "${oldName}"`, oldName);
		if (raw === undefined) return undefined;

		const newName = normalizeModeNameInput(raw);
		if (!newName || newName === oldName) return oldName;

		const err = validateModeNameOrError(newName, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		runtime.data.modes = renameModesRecord(runtime.data.modes, oldName, newName);
		const renamedPersistedMode = runtime.data.currentMode === oldName;
		if (renamedPersistedMode) runtime.data.currentMode = newName;
		await persistRuntime(pi, ctx, renamedPersistedMode);

		if (runtime.currentMode === oldName) runtime.currentMode = newName;
		if (runtime.lastRealMode === oldName) runtime.lastRealMode = newName;
		if (isEditorActive) {
			requestEditorRender?.();
		}

		ctx.ui.notify(`Renamed "${oldName}" → "${newName}"`, "info");
		return newName;
	}
}

/**
 * Interactive searchable model picker using public ExtensionContext surface.
 *
 * Avoids depending on private ModelRuntime APIs that change across Pi releases.
 */
async function pickModelForModeUI(
	ctx: ExtensionContext,
	spec: ModeSpec,
): Promise<{ provider: string; modelId: string } | undefined> {
	if (!ctx.hasUI) return undefined;

	const scoped = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((s) => s.model) : [];
	const available = scoped.length > 0 ? scoped : [...ctx.modelRegistry.getAvailable()];
	const all = available.length > 0 ? available : [...ctx.modelRegistry.getAll()];
	if (all.length === 0) {
		ctx.ui.notify("No models available", "warning");
		return undefined;
	}

	const currentId =
		spec.provider && spec.modelId
			? `${spec.provider}/${spec.modelId}`
			: ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
	const sorted = [...all].sort((a, b) => {
		if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
		return a.id.localeCompare(b.id);
	});

	interface ModelOption {
		provider: string;
		modelId: string;
		id: string;
		label: string;
		description: string;
		searchText: string;
	}
	const options: ModelOption[] = sorted.map((m) => {
		const id = `${m.provider}/${m.id}`;
		const authOk = ctx.modelRegistry.hasConfiguredAuth(m);
		const namePart = m.name && m.name !== m.id ? m.name : "";
		const flags = [authOk ? null : "no auth", id === currentId ? "current" : null].filter(Boolean).join(", ");
		const description = [namePart, flags ? `(${flags})` : null].filter(Boolean).join(" ");
		return {
			provider: m.provider,
			modelId: m.id,
			id,
			label: id,
			description,
			searchText: `${id} ${m.name ?? ""}`,
		};
	});

	const items: SelectItem[] = options.map((opt, index) => ({
		value: String(index),
		label: opt.label,
		description: opt.description,
	}));

	const result = await ctx.ui.custom<number | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Model for mode (current: ${currentId ?? "none"})`))));

		const searchInput = new Input();
		container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		let filteredItems = items;
		let selectList: SelectList | null = null;

		const updateList = () => {
			listContainer.clear();
			if (filteredItems.length === 0) {
				listContainer.addChild(new Text(theme.fg("warning", "  No matching models")));
				selectList = null;
				return;
			}

			selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => done(Number(item.value));
			selectList.onCancel = () => done(null);
			listContainer.addChild(selectList);
		};

		const applyFilter = () => {
			const query = searchInput.getValue();
			filteredItems = query
				? fuzzyFilter(items, query, (item) => {
						const opt = options[Number(item.value)];
						return opt ? `${opt.label} ${opt.searchText} ${opt.description}` : `${item.label} ${item.value}`;
					})
				: items;
			updateList();
		};

		applyFilter();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					if (selectList) {
						selectList.handleInput(data);
					} else if (keybindings.matches(data, "tui.select.cancel")) {
						done(null);
					}
					tui.requestRender();
					return;
				}

				searchInput.handleInput(data);
				applyFilter();
				tui.requestRender();
			},
		};
	});

	if (result === null || result === undefined) return undefined;
	const opt = options[result];
	if (!opt) return undefined;
	return { provider: opt.provider, modelId: opt.modelId };
}

async function pickThinkingLevelForModeUI(
	ctx: ExtensionContext,
	current: ThinkingLevel | undefined,
): Promise<ThinkingLevel | null | undefined> {
	if (!ctx.hasUI) return undefined;

	const defaultValue = current ?? "off";
	const options = [...ALL_THINKING_LEVELS, THINKING_UNSET_LABEL];
	const ordered = [defaultValue, ...options.filter((x) => x !== defaultValue)];

	const choice = await ctx.ui.select("Thinking level", ordered);
	if (!choice) return undefined;
	if (choice === THINKING_UNSET_LABEL) return null;
	if (ALL_THINKING_LEVELS.includes(choice as ThinkingLevel)) return choice as ThinkingLevel;
	return undefined;
}

async function cycleMode(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
	if (!ctx.hasUI) return;
	await ensureRuntime(pi, ctx);
	const names = orderedModeNames(runtime.data.modes);
	if (names.length === 0) return;

	const baseMode = runtime.currentMode === CUSTOM_MODE_NAME ? runtime.lastRealMode : runtime.currentMode;
	const idx = Math.max(0, names.indexOf(baseMode));
	const next = names[(idx + direction + names.length) % names.length] ?? names[0]!;
	await applyMode(pi, ctx, next);
}

const MAX_HISTORY_ENTRIES = 100;
const MAX_RECENT_PROMPTS = 30;

interface PromptEntry {
	text: string;
	timestamp: number;
}

/**
 * Custom editor component extending Pi's CustomEditor.
 *
 * Renders an embedded mode indicator badge in the top border, dynamic border
 * colors matching current thinking level or bash mode, and prompt history navigation.
 */
class PromptEditor extends CustomEditor {
	public modeLabelProvider?: () => string;
	public modeLabelColor?: (text: string) => string;
	private lockedBorder = false;
	private _borderColor?: (text: string) => string;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
	) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		delete (this as { borderColor?: (text: string) => string }).borderColor;
		Object.defineProperty(this, "borderColor", {
			get: () => this._borderColor ?? ((text: string) => text),
			set: (value: (text: string) => string) => {
				if (this.lockedBorder) return;
				this._borderColor = value;
			},
			configurable: true,
			enumerable: true,
		});
	}

	lockBorderColor() {
		this.lockedBorder = true;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const topBorder = lines[0] ?? "";
		const mode = this.modeLabelProvider?.();
		if (!mode) return lines;

		const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		const topPlain = stripAnsi(topBorder);
		const isBashMode = this.getText().trimStart().startsWith("!");

		const trailingBorderStart = topPlain.search(/─+$/);
		const semanticPrefix = trailingBorderStart > 0 ? topPlain.slice(0, trailingBorderStart) : "";
		const prefixWidth = Math.min(width, semanticPrefix ? visibleWidth(semanticPrefix) : isBashMode ? 2 : 0);
		let left = truncateToWidth(topBorder, prefixWidth, "");
		let leftWidth = prefixWidth;

		const labelColor = this.modeLabelColor ?? ((text: string) => this.borderColor(text));
		if (isBashMode) {
			const bashPrefix = semanticPrefix ? this.borderColor("── ") : this.borderColor(" ");
			const bashLabel = this.borderColor("bash ");
			left += bashPrefix + bashLabel;
			leftWidth += visibleWidth(bashPrefix) + visibleWidth(bashLabel);
		}

		const modeLeftSpace = " ";
		const modeRightSpace = " ";
		const rightBorderWidth = 2;
		const minGapWidth = 1;
		const maxModeWidth = Math.max(
			0,
			width -
				leftWidth -
				visibleWidth(modeLeftSpace) -
				visibleWidth(modeRightSpace) -
				rightBorderWidth -
				minGapWidth,
		);
		if (maxModeWidth <= 0) return lines;

		const modeLabel = truncateToWidth(formatModeLabel(mode), maxModeWidth, "");
		const modeWidth = visibleWidth(modeLabel);
		const gapWidth =
			width - leftWidth - visibleWidth(modeLeftSpace) - modeWidth - visibleWidth(modeRightSpace) - rightBorderWidth;
		if (gapWidth < minGapWidth) return lines;

		lines[0] =
			left +
			this.borderColor("─".repeat(gapWidth)) +
			labelColor(modeLeftSpace) +
			labelColor(modeLabel) +
			labelColor(modeRightSpace) +
			this.borderColor("─".repeat(rightBorderWidth));
		return lines;
	}

	public requestRenderNow(): void {
		this.tui.requestRender();
	}
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("")
		.trim();
}

function collectUserPromptsFromEntries(entries: Array<any>): PromptEntry[] {
	const prompts: PromptEntry[] = [];

	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry?.message;
		if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = extractText(message.content);
		if (!text) continue;
		const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
		prompts.push({ text, timestamp });
	}

	return prompts;
}

function getSessionDirForCwd(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getGlobalAgentDir(), "sessions", safePath);
}

/**
 * Reads the trailing portion of a file up to maxBytes without buffering the whole file.
 */
async function readTail(filePath: string, maxBytes = 256 * 1024): Promise<string> {
	let fileHandle: fs.FileHandle | undefined;
	try {
		const stats = await fs.stat(filePath);
		const size = stats.size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return "";

		const buffer = Buffer.alloc(length);
		fileHandle = await fs.open(filePath, "r");
		const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
		if (bytesRead === 0) return "";
		let chunk = buffer.subarray(0, bytesRead).toString("utf8");
		if (start > 0) {
			const firstNewline = chunk.indexOf("\n");
			if (firstNewline !== -1) {
				chunk = chunk.slice(firstNewline + 1);
			}
		}
		return chunk;
	} catch {
		return "";
	} finally {
		await fileHandle?.close();
	}
}

async function loadPromptHistoryForCwd(cwd: string, excludeSessionFile?: string): Promise<PromptEntry[]> {
	const sessionDir = getSessionDirForCwd(path.resolve(cwd));
	const resolvedExclude = excludeSessionFile ? path.resolve(excludeSessionFile) : undefined;
	const prompts: PromptEntry[] = [];

	let entries: Dirent[] = [];
	try {
		entries = await fs.readdir(sessionDir, { withFileTypes: true });
	} catch {
		return prompts;
	}

	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry) => {
				const filePath = path.join(sessionDir, entry.name);
				try {
					const stats = await fs.stat(filePath);
					return { filePath, mtimeMs: stats.mtimeMs };
				} catch {
					return undefined;
				}
			}),
	);

	const sortedFiles = files
		.filter((file): file is { filePath: string; mtimeMs: number } => Boolean(file))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	for (const file of sortedFiles) {
		if (resolvedExclude && path.resolve(file.filePath) === resolvedExclude) continue;

		const tail = await readTail(file.filePath);
		if (!tail) continue;
		const lines = tail.split("\n").filter(Boolean);
		for (const line of lines) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry?.message;
			if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
			const text = extractText(message.content);
			if (!text) continue;
			const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
			prompts.push({ text, timestamp });
			if (prompts.length >= MAX_RECENT_PROMPTS) break;
		}
		if (prompts.length >= MAX_RECENT_PROMPTS) break;
	}

	return prompts;
}

function buildHistoryList(currentSession: PromptEntry[], previousSessions: PromptEntry[]): PromptEntry[] {
	const all = [...currentSession, ...previousSessions];
	all.sort((a, b) => a.timestamp - b.timestamp);

	const seen = new Set<string>();
	const deduped: PromptEntry[] = [];
	for (const prompt of all) {
		const key = `${prompt.timestamp}:${prompt.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(prompt);
	}

	return deduped.slice(-MAX_HISTORY_ENTRIES);
}

let customOverlay: ModeSpec | null = null;
let loadCounter = 0;

function historiesMatch(a: PromptEntry[], b: PromptEntry[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i]?.text !== b[i]?.text || a[i]?.timestamp !== b[i]?.timestamp) return false;
	}
	return true;
}

function setEditor(pi: ExtensionAPI, ctx: ExtensionContext, history: PromptEntry[]) {
	const uiTheme = ctx.ui.theme;
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = new PromptEditor(tui, theme, keybindings);
		requestEditorRender = () => editor.requestRenderNow();
		editor.modeLabelProvider = () => runtime.currentMode;
		editor.modeLabelColor = (text: string) => uiTheme.fg("dim", text);
		const borderColor = (text: string) => {
			const isBashMode = editor.getText().trimStart().startsWith("!");
			if (isBashMode) {
				return uiTheme.getBashModeBorderColor()(text);
			}
			return getModeBorderColor(uiTheme, pi, runtime.currentMode)(text);
		};

		editor.borderColor = borderColor;
		editor.lockBorderColor();
		for (const prompt of history) {
			editor.addToHistory?.(prompt.text);
		}
		return editor;
	});
}

function applyEditor(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	const sessionFile = ctx.sessionManager.getSessionFile();
	const currentEntries = ctx.sessionManager.getBranch();
	const currentPrompts = collectUserPromptsFromEntries(currentEntries);
	const immediateHistory = buildHistoryList(currentPrompts, []);

	const currentLoad = ++loadCounter;
	const initialText = ctx.ui.getEditorText();
	setEditor(pi, ctx, immediateHistory);

	void (async () => {
		const previousPrompts = await loadPromptHistoryForCwd(ctx.cwd, sessionFile ?? undefined);
		if (currentLoad !== loadCounter) return;
		if (ctx.ui.getEditorText() !== initialText) return;
		const history = buildHistoryList(currentPrompts, previousPrompts);
		if (historiesMatch(history, immediateHistory)) return;
		setEditor(pi, ctx, history);
	})();
}

/**
 * Activates the custom prompt editor and synchronizes current mode state.
 */
async function activateEditor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestedMode?: string,
): Promise<void> {
	if (isEditorActive) return;
	isEditorActive = true;
	await ensureRuntime(pi, ctx);

	const savedMode = runtime.data.currentMode;
	const targetMode =
		requestedMode ??
		(savedMode && runtime.data.modes[savedMode]
			? savedMode
			: runtime.lastRealMode && runtime.data.modes[runtime.lastRealMode]
				? runtime.lastRealMode
				: runtime.data.modes["default"]
					? "default"
					: Object.keys(runtime.data.modes)[0]);

	if (targetMode) {
		await applyMode(pi, ctx, targetMode);
	} else {
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi, ctx);
	}

	applyEditor(pi, ctx);
	if (ctx.hasUI) {
		ctx.ui.notify(`Prompt editor active (mode: ${runtime.currentMode})`, "info");
	}
}

/**
 * Deactivates the custom prompt editor and restores the default editor component.
 */
function deactivateEditor(ctx: ExtensionContext): void {
	if (!isEditorActive) return;
	isEditorActive = false;
	requestEditorRender = undefined;
	if (ctx.hasUI) {
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.notify("Prompt editor deactivated", "info");
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("mode", {
		description: "Select prompt mode",
		handler: async (args, ctx) => {
			const tokens = args
				.split(/\s+/)
				.map((x) => x.trim())
				.filter(Boolean);

			if (tokens[0] === "off" || tokens[0] === "disable") {
				deactivateEditor(ctx);
				return;
			}

			if (tokens.length === 0) {
				if (!isEditorActive) {
					await activateEditor(pi, ctx);
				}
				await selectModeUI(pi, ctx);
				return;
			}

			if (tokens[0] === "store") {
				if (!isEditorActive) {
					await activateEditor(pi, ctx);
				}
				await ensureRuntime(pi, ctx);

				let target = tokens[1];
				if (!target) {
					if (!ctx.hasUI) return;
					const names = orderedModeNames(runtime.data.modes);
					target = await ctx.ui.select("Store current selection into mode", names);
					if (!target) return;
				}

				if (target === CUSTOM_MODE_NAME) {
					if (ctx.hasUI) ctx.ui.notify(`Cannot store into "${CUSTOM_MODE_NAME}"`, "warning");
					return;
				}

				const selection = customOverlay ?? getCurrentSelectionSpec(pi, ctx);
				await storeSelectionIntoMode(pi, ctx, target, selection);
				if (ctx.hasUI) ctx.ui.notify(`Stored current selection into "${target}"`, "info");
				return;
			}

			if (!isEditorActive) {
				await activateEditor(pi, ctx, tokens[0]);
				return;
			}

			await applyMode(pi, ctx, tokens[0]!);
		},
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Activate prompt editor or select mode",
		handler: async (ctx) => {
			if (!isEditorActive) {
				await activateEditor(pi, ctx);
				return;
			}
			await selectModeUI(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+space", {
		description: "Cycle prompt mode",
		handler: async (ctx) => {
			if (!isEditorActive) {
				await activateEditor(pi, ctx);
			}
			await cycleMode(pi, ctx, 1);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastObservedModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
		isEditorActive = false;
		requestEditorRender = undefined;
		await ensureRuntime(pi, ctx);
		customOverlay = null;
	});

	pi.on("model_select", async (event, ctx) => {
		lastObservedModel = { provider: event.model.provider, modelId: event.model.id };

		if (runtime.applying) return;
		if (!isEditorActive) return;

		await ensureRuntime(pi, ctx);
		if (runtime.currentMode !== CUSTOM_MODE_NAME) {
			runtime.lastRealMode = runtime.currentMode;
		}
		runtime.currentMode = CUSTOM_MODE_NAME;

		customOverlay = {
			provider: event.model.provider,
			modelId: event.model.id,
			thinkingLevel: pi.getThinkingLevel(),
		};

		if (ctx.hasUI) {
			requestEditorRender?.();
		}
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (runtime.applying) return;
		if (!isEditorActive) return;

		await ensureRuntime(pi, ctx);
		const level = event.level ?? (event as any).thinkingLevel;
		const activeSpec = runtime.data.modes[runtime.currentMode];
		const matchesActiveMode =
			activeSpec &&
			activeSpec.provider === (ctx.model?.provider ?? lastObservedModel.provider) &&
			activeSpec.modelId === (ctx.model?.id ?? lastObservedModel.modelId) &&
			(activeSpec.thinkingLevel ?? "off") === level;

		if (!matchesActiveMode && runtime.currentMode !== CUSTOM_MODE_NAME) {
			runtime.lastRealMode = runtime.currentMode;
			runtime.currentMode = CUSTOM_MODE_NAME;
		}

		customOverlay = {
			provider: ctx.model?.provider ?? lastObservedModel.provider,
			modelId: ctx.model?.id ?? lastObservedModel.modelId,
			thinkingLevel: level,
		};

		if (ctx.hasUI) {
			requestEditorRender?.();
		}
	});
}
