import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";

/**
 * Minimal theme styling interface used for terminal text rendering.
 */
export interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * Custom interactive component interface mounted by `ctx.ui.custom`.
 */
export interface CustomComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate?: () => void;
	dispose?: () => void;
}

/**
 * Extension execution context interface providing access to the terminal UI.
 */
export interface AskUiContext {
	hasUI: boolean;
	ui: {
		editor(title: string): Promise<string | undefined>;
		custom<T>(
			factory: (
				tui: any,
				theme: Theme,
				kb: unknown,
				done: (result: T) => void,
			) => CustomComponent,
		): Promise<T>;
	};
}

export interface AskOption {
	readonly label: string;
	readonly value: string;
	readonly description?: string;
}

export interface DisplayOption extends AskOption {
	readonly id: string;
	readonly index?: number;
	readonly isOther?: boolean;
	readonly isSubmit?: boolean;
}

export interface TextAnswer {
	readonly type: "text";
	readonly label: string;
	readonly value: string;
}

export interface OptionAnswer {
	readonly type: "option";
	readonly label: string;
	readonly value: string;
	readonly index: number;
}

export interface OtherAnswer {
	readonly type: "other";
	readonly label: string;
	readonly value: string;
}

export type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
export type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
export type AskUserQuestionMode = "text" | "single-select" | "multi-select";

export interface AskUserQuestionResultDetails {
	readonly status: AskUserQuestionStatus;
	readonly question: string;
	readonly context?: string;
	readonly mode: AskUserQuestionMode;
	readonly answers: readonly AskAnswer[];
	readonly message?: string;
}

export interface AskUserQuestionResult {
	content: Array<{ type: "text"; text: string }>;
	details: AskUserQuestionResultDetails;
}

export const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

export type RawOption = Static<typeof OptionSchema>;

export const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({
			description: "Optional extra context or instructions shown under the question.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow multiple answers to be selected for a question.",
		}),
	),
});

export type AskUserQuestionParamsType = Static<typeof AskUserQuestionParams>;

/**
 * Maximum number of selectable options to prevent terminal overflow.
 * Keeps the TUI navigable and avoids excessive vertical scrolling.
 * Time: O(n), Space: O(n) where n = input options.
 */
export const MAX_OPTIONS = 20;

/**
 * Normalizes raw option input into a sanitized `AskOption` array.
 * - Trims labels/values/descriptions and discards empty labels.
 * - Defaults `value` to the trimmed label when omitted.
 * - Defensively handles null/undefined/non-array and malformed entries.
 * - Caps the result to `MAX_OPTIONS` to keep TUI rendering bounded.
 * - Does not mutate the input array or its item objects.
 */
export function normalizeOptions(
	options:
		| ReadonlyArray<{ readonly label: string; readonly value?: string; readonly description?: string }>
		| undefined
		| null
		| unknown,
): AskOption[] {
	if (!Array.isArray(options)) return [];
	const normalized: AskOption[] = [];
	for (const raw of options) {
		if (!raw || typeof raw !== "object") continue;
		const rawObj = raw as Record<string, unknown>;
		const label = typeof rawObj.label === "string" ? rawObj.label.trim() : "";
		if (!label) continue;
		const value =
			typeof rawObj.value === "string" && rawObj.value.trim() ? rawObj.value.trim() : label;
		const description =
			typeof rawObj.description === "string" && rawObj.description.trim()
				? rawObj.description.trim()
				: undefined;
		normalized.push({ label, value, description });
		if (normalized.length >= MAX_OPTIONS) break;
	}
	return normalized;
}

/**
 * Computes a distinct label for the "Other" option.
 * If the provided options already contain an entry named "other" (case-insensitive),
 * returns "Other (custom)" to prevent visual ambiguity; otherwise returns "Other".
 */
export function getOtherLabel(options: readonly AskOption[] | unknown): string {
	if (!Array.isArray(options)) return "Other";
	return options.some(
		(option) => option && typeof option.label === "string" && option.label.toLowerCase() === "other",
	)
		? "Other (custom)"
		: "Other";
}

/**
 * Creates an editor theme configuration mapped to the agent's TUI color palette.
 */
function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

/**
 * Normalizes terminal width to a safe positive integer.
 * Guards against 0, negative, NaN, or Infinity from terminal resize events.
 */
function normalizeWidth(width: number): number {
	if (!Number.isFinite(width) || width <= 0) return 80;
	return Math.floor(width);
}

/**
 * Wraps and truncates text to fit within the given width, preserving ANSI sequences.
 * Falls back to width 80 for invalid values to avoid render crashes.
 *
 * Performance Characteristics:
 * - Time Complexity: O(m) where m is text character length.
 * - Space Complexity: O(m) for the wrapped string chunks.
 * - Allocations are minimized by skipping template string creation when indent is empty.
 */
function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const safeWidth = normalizeWidth(width);
	const safeIndent = indent.length >= safeWidth ? "" : indent;
	const contentWidth = Math.max(1, safeWidth - safeIndent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(safeIndent ? `${safeIndent}${line}` : line, safeWidth));
	}
}

/**
 * Formats an individual answer entry into a string suitable for LLM consumption.
 */
function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Other: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

/**
 * Assigns an ordinal ranking to answers so options maintain original prompt order,
 * followed by custom 'other' answers, and finally text inputs.
 */
function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 1;
		case "text":
			return Number.MAX_SAFE_INTEGER;
	}
}

/**
 * Sorts an array of answers according to their predefined rank order.
 */
function sortAnswers(answers: readonly AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

/**
 * Constructs a structured details object representing the outcome of a question tool call.
 */
export function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: readonly AskAnswer[],
	context?: string,
	message?: string,
): AskUserQuestionResultDetails {
	return {
		status,
		question,
		context,
		mode,
		answers,
		message,
	};
}

/**
 * Constructs a standardized cancelled result response object.
 */
export function cancelledResult(
	question: string,
	mode: AskUserQuestionMode,
	context?: string,
): AskUserQuestionResult {
	const message = "User cancelled the question";
	return {
		content: [{ type: "text", text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], context, message),
	};
}

/**
 * Constructs a standardized unavailable result response object when interactive UI is unavailable.
 */
export function unavailableResult(
	question: string,
	mode: AskUserQuestionMode,
	message: string,
	context?: string,
): AskUserQuestionResult {
	return {
		content: [{ type: "text", text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

/**
 * Formats tool execution result for the language model and UI presentation.
 * - Text mode: formats as "User answered: <text>" or "User submitted an empty response" when empty/whitespace.
 * - Single-select mode: formats as "User selected: <index>. <label>" or "User selected: Other: <custom>".
 * - Multi-select mode: formats as bulleted list sorted by original option order, then Other.
 */
export function buildResult(
	question: string,
	context: string | undefined,
	mode: AskUserQuestionMode,
	answers: readonly AskAnswer[],
): AskUserQuestionResult {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		const answerLabel = answer && typeof answer.label === "string" ? answer.label.trim() : "";
		text = answerLabel.length > 0 ? `User answered: ${answer.label}` : "User submitted an empty response";
	} else if (mode === "single-select") {
		text = `User selected: ${answers[0] ? formatAnswerForModel(answers[0]) : "none"}`;
	} else {
		text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}

	return {
		content: [{ type: "text", text }],
		details: buildStructuredResult("answered", question, mode, answers, context),
	};
}

/**
 * Prompts the user with an interactive text editor and awaits their input.
 * Supports cancellation via AbortSignal.
 */
export async function askTextEditor(
	ctx: AskUiContext,
	title: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) {
		return undefined;
	}

	let abortListener: (() => void) | undefined;
	const abortPromise = new Promise<undefined>((resolve) => {
		if (signal) {
			if (signal.aborted) {
				resolve(undefined);
				return;
			}
			abortListener = () => resolve(undefined);
			signal.addEventListener("abort", abortListener, { once: true });
		}
	});

	try {
		const editorPromise = ctx.ui.editor(title);
		return await Promise.race([editorPromise, abortPromise]);
	} finally {
		if (signal && abortListener) {
			signal.removeEventListener("abort", abortListener);
		}
	}
}

interface FrameContext {
	readonly safeWidth: number;
	readonly lines: string[];
	readonly add: (text: string) => void;
	readonly finish: () => string[];
}

interface RenderCache {
	invalidate: () => void;
	startFrame: (
		width: number,
	) => { cached: true; lines: string[] } | { cached: false; ctx: FrameContext };
}

/**
 * Creates a width-keyed render cache and frame builder for choice prompts.
 * Deduplicates width normalization, caching, top border, question/context wrapping,
 * and bottom border rendering across single-choice and multi-choice TUIs.
 *
 * Complexity & Scale Justification:
 * - Time Complexity: O(1) on cache hit; O(n + d + c) on cache miss, where n is options count
 *   (strictly bounded by MAX_OPTIONS = 20), d is total description length, and c is context length.
 * - Space Complexity: O(1) on cache hit (returns identical array reference without allocation);
 *   O(lines) on cache miss for the new string array.
 * - Since options are capped at MAX_OPTIONS = 20, render frame allocation is negligible (< 100 strings, ~0.05ms)
 *   and cached per-width, so O(n) per keypress without virtual scrolling is optimal and avoids unnecessary complexity.
 */
function createRenderCache(theme: Theme, question: string, context?: string): RenderCache {
	let cachedLines: string[] | undefined;
	let cachedWidth = -1;

	return {
		invalidate() {
			cachedLines = undefined;
			cachedWidth = -1;
		},
		startFrame(width: number) {
			const safeWidth = normalizeWidth(width);
			if (cachedLines && cachedWidth === safeWidth) {
				return { cached: true, lines: cachedLines };
			}

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, safeWidth));
			const border = theme.fg("accent", "─".repeat(safeWidth));

			// Top border
			add(border);

			// Question heading
			addWrapped(lines, theme.fg("text", ` ${question}`), safeWidth);

			// Optional details context
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), safeWidth);
			}
			lines.push("");

			const finish = () => {
				// Bottom border
				add(border);
				cachedLines = lines;
				cachedWidth = safeWidth;
				return lines;
			};

			return {
				cached: false,
				ctx: { safeWidth, lines, add, finish },
			};
		},
	};
}

/**
 * Prompts the user with an interactive single-choice selector in the terminal UI.
 */
export async function askSingleChoice(
	ctx: AskUiContext,
	question: string,
	context: string | undefined,
	options: readonly AskOption[],
	signal?: AbortSignal,
): Promise<AskAnswer | null> {
	if (signal?.aborted) {
		return null;
	}

	const otherLabel = getOtherLabel(options);
	const allOptions: DisplayOption[] = [
		...options.map((option, index) => ({ ...option, id: `option:${index}`, index: index + 1 })),
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
	];

	return ctx.ui.custom<AskAnswer | null>(
		(
			tui: any,
			theme: Theme,
			_kb: unknown,
			done: (result: AskAnswer | null) => void,
		): CustomComponent => {
			let isSettled = false;
			let optionIndex = 0;
			let editMode = false;
			const editor = new Editor(tui, createEditorTheme(theme));
			const cache = createRenderCache(theme, question, context);

			// Static themed strings pre-formatted to avoid duplicate theme.fg calls on every render frame
			const editPromptHeader = theme.fg("muted", " Write your custom answer:");
			const editFooterHint = theme.fg("dim", " Enter to submit • Esc to go back");
			const navFooterHint = theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel");
			const cursorPrefix = theme.fg("accent", "> ");
			const spacePrefix = "  ";

			const finish = (result: AskAnswer | null) => {
				if (isSettled) return;
				isSettled = true;
				if (signal && onAbort) {
					signal.removeEventListener("abort", onAbort);
				}
				done(result);
			};

			const onAbort = () => {
				finish(null);
			};

			if (signal) {
				if (signal.aborted) {
					finish(null);
					return {
						render: () => [],
						invalidate: () => {},
						handleInput: () => {},
						dispose: () => {},
					};
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// Edge: whitespace-only submissions are ignored to prevent empty "Other" answers.
			// The editor stays in editMode so the user can correct the input without losing focus.
			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (!trimmed) return; // Keep editMode active; user must provide non-empty input or press Esc.
				finish({ type: "other", label: trimmed, value: trimmed });
			};

			function refresh() {
				cache.invalidate();
				tui.requestRender();
			}

			/**
			 * Single-select input state machine:
			 *
			 * State 1: Navigation Mode (editMode = false)
			 * - Key.up: Decrements optionIndex, clamped to 0.
			 * - Key.down: Increments optionIndex, clamped to allOptions.length - 1.
			 * - Key.enter on standard option: Settle immediately with selected option.
			 * - Key.enter on 'Other': Transition to Edit Mode (editMode = true), clear editor text.
			 * - Key.escape: Cancel prompt, finish with null.
			 *
			 * State 2: Edit Mode (editMode = true)
			 * - Key.escape: Exit Edit Mode (editMode = false), clear editor text, return to Navigation Mode.
			 * - Key.enter: Handled by editor.onSubmit; submits trimmed answer if non-empty, stays in editMode if empty.
			 * - All other keys: Forwarded to Editor for text manipulation.
			 */
			function handleInput(data: string) {
				if (isSettled) return;

				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						editMode = false;
						editor.setText("");
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const selected = allOptions[optionIndex];
					if (selected.isOther) {
						editMode = true;
						editor.setText("");
						refresh();
					} else {
						finish({
							type: "option",
							label: selected.label,
							value: selected.value,
							index: selected.index!,
						});
					}
					return;
				}
				if (matchesKey(data, Key.escape)) {
					finish(null);
				}
			}

			function render(width: number): string[] {
				const frame = cache.startFrame(width);
				if (frame.cached) return frame.lines;

				const { safeWidth, lines, add, finish } = frame.ctx;

				for (let i = 0; i < allOptions.length; i++) {
					const option = allOptions[i];
					const selected = i === optionIndex;
					const prefix = selected ? cursorPrefix : spacePrefix;
					const label = option.isOther ? option.label : `${option.index}. ${option.label}`;
					const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
					add(`${prefix}${styled}`);
					if (option.description) {
						addWrapped(lines, theme.fg("muted", option.description), safeWidth, "     ");
					}
				}

				if (editMode) {
					lines.push("");
					add(editPromptHeader);
					for (const line of editor.render(Math.max(1, safeWidth - 2))) {
						add(` ${line}`);
					}
					lines.push("");
					add(editFooterHint);
				} else {
					lines.push("");
					add(navFooterHint);
				}

				return finish();
			}

			return {
				render,
				invalidate: () => {
					cache.invalidate();
				},
				handleInput,
				dispose: () => {
					if (signal && onAbort) {
						signal.removeEventListener("abort", onAbort);
					}
				},
			};
		},
	);
}

/**
 * Prompts the user with an interactive multi-choice selector with toggle support in the terminal UI.
 */
export async function askMultiChoice(
	ctx: AskUiContext,
	question: string,
	context: string | undefined,
	options: readonly AskOption[],
	signal?: AbortSignal,
): Promise<AskAnswer[] | null> {
	if (signal?.aborted) {
		return null;
	}

	const otherLabel = getOtherLabel(options);
	const choiceItems: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const submitItem: DisplayOption = { id: "submit", label: "Submit", value: "__submit__", isSubmit: true };
	const allItems: DisplayOption[] = [
		...choiceItems,
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
		submitItem,
	];

	return ctx.ui.custom<AskAnswer[] | null>(
		(
			tui: any,
			theme: Theme,
			_kb: unknown,
			done: (result: AskAnswer[] | null) => void,
		): CustomComponent => {
			let isSettled = false;
			let optionIndex = 0;
			let editMode = false;
			const selected = new Map<string, AskAnswer>();
			const editor = new Editor(tui, createEditorTheme(theme));
			const cache = createRenderCache(theme, question, context);

			// Static themed strings pre-formatted to avoid duplicate theme.fg calls on every render frame
			const editPromptHeader = theme.fg("muted", " Write your custom answer:");
			const editFooterHint = theme.fg("dim", " Enter to save • Esc to go back");
			const emptySelectionWarning = theme.fg("warning", " Select at least one answer before submitting.");
			const navFooterHint = theme.fg("dim", " ↑↓ navigate • Space toggle • Enter edit/submit • Esc cancel");
			const cursorPrefix = theme.fg("accent", "> ");
			const spacePrefix = "  ";

			const finish = (result: AskAnswer[] | null) => {
				if (isSettled) return;
				isSettled = true;
				if (signal && onAbort) {
					signal.removeEventListener("abort", onAbort);
				}
				done(result);
			};

			const onAbort = () => {
				finish(null);
			};

			if (signal) {
				if (signal.aborted) {
					finish(null);
					return {
						render: () => [],
						invalidate: () => {},
						handleInput: () => {},
						dispose: () => {},
					};
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// Edge: whitespace-only "Other" input is ignored; stays in editMode for correction.
			// Preserves existing "other" selection if present, avoids creating empty answers.
			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (!trimmed) return; // Keep editMode active.
				selected.set("other", { type: "other", label: trimmed, value: trimmed });
				editMode = false;
				refresh();
			};

			function refresh() {
				cache.invalidate();
				tui.requestRender();
			}

			/**
			 * Multi-select input state machine:
			 *
			 * State 1: Navigation Mode (editMode = false)
			 * - Key.up: Decrements optionIndex, clamped to 0.
			 * - Key.down: Increments optionIndex, clamped to allItems.length - 1.
			 * - Key.space:
			 *   - On standard option: Toggles selection state in `selected` Map.
			 *   - On 'Other': If selected, unselects 'other'; if unselected, enters Edit Mode.
			 *   - On 'Submit': Ignored (submission requires Enter).
			 * - Key.enter:
			 *   - On 'Submit': If >= 1 item selected, settles and finishes with sorted answers; otherwise ignored.
			 *   - On 'Other': Enters Edit Mode, pre-filling editor with existing 'other' text if any.
			 *   - On standard option: Toggles selection state in `selected` Map.
			 * - Key.escape: Cancel prompt, finish with null.
			 *
			 * State 2: Edit Mode (editMode = true)
			 * - Key.escape: Exit Edit Mode (editMode = false), restore editor to previous Other value, return to Navigation.
			 * - Key.enter: Handled by editor.onSubmit; saves non-empty answer to `selected` and returns to Navigation.
			 * - All other keys: Forwarded to Editor for text manipulation.
			 */
			function toggleOption(item: DisplayOption) {
				if (selected.has(item.id)) {
					selected.delete(item.id);
				} else {
					selected.set(item.id, {
						type: "option",
						label: item.label,
						value: item.value,
						index: item.index!,
					});
				}
				refresh();
			}

			function handleInput(data: string) {
				if (isSettled) return;

				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						editMode = false;
						editor.setText(selected.get("other")?.label || "");
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
					refresh();
					return;
				}

				const current = allItems[optionIndex];
				if (matchesKey(data, Key.space)) {
					if (current.isSubmit) return;
					if (current.isOther) {
						if (selected.has("other")) {
							selected.delete("other");
							refresh();
						} else {
							editMode = true;
							editor.setText("");
							refresh();
						}
						return;
					}
					toggleOption(current);
					return;
				}

				if (matchesKey(data, Key.enter)) {
					if (current.isSubmit) {
						if (selected.size > 0) {
							finish(sortAnswers(Array.from(selected.values())));
						}
						return;
					}
					if (current.isOther) {
						editMode = true;
						editor.setText(selected.get("other")?.label || "");
						refresh();
						return;
					}
					toggleOption(current);
					return;
				}

				if (matchesKey(data, Key.escape)) {
					finish(null);
				}
			}

			function render(width: number): string[] {
				const frame = cache.startFrame(width);
				if (frame.cached) return frame.lines;

				const { safeWidth, lines, add, finish } = frame.ctx;

				for (let i = 0; i < allItems.length; i++) {
					const item = allItems[i];
					const isFocused = i === optionIndex;
					const prefix = isFocused ? cursorPrefix : spacePrefix;

					if (item.isSubmit) {
						const label =
							selected.size > 0 ? `✓ ${item.label} (${selected.size} selected)` : `○ ${item.label}`;
						const styled = isFocused
							? theme.fg("accent", label)
							: theme.fg(selected.size > 0 ? "success" : "dim", label);
						add(`${prefix}${styled}`);
						continue;
					}

					if (item.isOther) {
						const other = selected.get("other");
						const marker = other ? "[x]" : "[ ]";
						const suffix = other ? ` — ${other.label}` : "";
						const styled = isFocused
							? theme.fg("accent", `${marker} ${item.label}${suffix}`)
							: theme.fg(other ? "success" : "text", `${marker} ${item.label}${suffix}`);
						add(`${prefix}${styled}`);
						continue;
					}

					const checked = selected.has(item.id);
					const marker = checked ? "[x]" : "[ ]";
					const label = `${marker} ${item.index}. ${item.label}`;
					const styled = isFocused
						? theme.fg("accent", label)
						: theme.fg(checked ? "success" : "text", label);
					add(`${prefix}${styled}`);
					if (item.description) {
						addWrapped(lines, theme.fg("muted", item.description), safeWidth, "     ");
					}
				}

				if (editMode) {
					lines.push("");
					add(editPromptHeader);
					for (const line of editor.render(Math.max(1, safeWidth - 2))) {
						add(` ${line}`);
					}
					lines.push("");
					add(editFooterHint);
				} else {
					lines.push("");
					if (selected.size === 0) {
						add(emptySelectionWarning);
					}
					add(navFooterHint);
				}

				return finish();
			}

			return {
				render,
				invalidate: () => {
					cache.invalidate();
				},
				handleInput,
				dispose: () => {
					if (signal && onAbort) {
						signal.removeEventListener("abort", onAbort);
					}
				},
			};
		},
	);
}

/**
 * Internal global symbol key used on `globalThis` to synchronize TUI operations
 * across independent extension instances and prevent concurrent UI collisions.
 */
export const SHARED_UI_LOCK_KEY = "__piSharedUiLock";

/**
 * Mutex providing FIFO serialization for TUI prompts to prevent interleaved rendering
 * and conflicting keyboard input handlers across asynchronous operations.
 */
export class SharedUiMutex {
	private chain: Promise<void> = Promise.resolve();

	async withLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) {
			const error = new Error("Operation aborted");
			error.name = "AbortError";
			throw error;
		}

		let release: () => void;
		const lockAcquiredPromise = new Promise<void>((resolve) => {
			release = resolve;
		});

		const prev = this.chain;
		this.chain = prev.then(
			() => lockAcquiredPromise,
			() => lockAcquiredPromise,
		);

		let abortListener: (() => void) | undefined;

		try {
			if (signal) {
				await new Promise<void>((resolve, reject) => {
					if (signal.aborted) {
						const error = new Error("Operation aborted");
						error.name = "AbortError";
						reject(error);
						return;
					}

					abortListener = () => {
						const error = new Error("Operation aborted");
						error.name = "AbortError";
						reject(error);
					};
					signal.addEventListener("abort", abortListener, { once: true });

					prev.then(
						() => resolve(),
						() => resolve(),
					);
				});
			} else {
				await prev;
			}
		} catch (err) {
			// Aborted while waiting in the mutex queue.
			// Release lock slot once the predecessor finishes so subsequent waiters can proceed.
			prev.finally(() => {
				release();
			});
			throw err;
		} finally {
			if (signal && abortListener) {
				signal.removeEventListener("abort", abortListener);
			}
		}

		// Post-lock abort check in case cancellation occurred at the lock boundary.
		if (signal?.aborted) {
			release!();
			const error = new Error("Operation aborted");
			error.name = "AbortError";
			throw error;
		}

		try {
			return await fn();
		} finally {
			release!();
		}
	}
}

/**
 * Retrieves or initializes the shared UI mutex singleton stored on globalThis.
 */
export function getSharedUiLock(): SharedUiMutex {
	const g = globalThis as unknown as Record<string, unknown>;
	if (!g[SHARED_UI_LOCK_KEY] || !(g[SHARED_UI_LOCK_KEY] instanceof SharedUiMutex)) {
		g[SHARED_UI_LOCK_KEY] = new SharedUiMutex();
	}
	return g[SHARED_UI_LOCK_KEY] as SharedUiMutex;
}

/**
 * Executes an asynchronous function within the shared UI lock.
 */
export function withUILock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	return getSharedUiLock().withLock(fn, signal);
}

/**
 * Registers the `ask_user_question` tool with the Pi Extension API.
 */
export default function askUserQuestion(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
			'Users will always be able to select "Other" to provide custom text input when options are provided.',
			"Use multiSelect: true only when you need multiple answers to the same question.",
			'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
			"Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = normalizeOptions(params?.options);
			const context =
				typeof params?.details === "string" && params.details.trim()
					? params.details.trim()
					: undefined;
			const question = typeof params?.question === "string" ? params.question : "";
			const mode: AskUserQuestionMode =
				options.length === 0 ? "text" : params?.multiSelect ? "multi-select" : "single-select";

			// Pre-lock check
			if (signal?.aborted) {
				return cancelledResult(question, mode, context);
			}

			if (!ctx?.hasUI) {
				return unavailableResult(
					question,
					mode,
					"ask_user_question requires interactive mode UI",
					context,
				);
			}

			const uiCtx = ctx as unknown as AskUiContext;

			try {
				return await withUILock(async () => {
					// Post-lock check
					if (signal?.aborted) {
						return cancelledResult(question, mode, context);
					}

					if (mode === "text") {
						const editorTitle = context ? `${question}\n\n${context}` : question;
						const answer = await askTextEditor(uiCtx, editorTitle, signal);
						if (answer === undefined) {
							return cancelledResult(question, mode, context);
						}
						return buildResult(question, context, mode, [
							{ type: "text", label: answer.trim(), value: answer.trim() },
						]);
					}

					if (mode === "single-select") {
						const answer = await askSingleChoice(uiCtx, question, context, options, signal);
						if (!answer) {
							return cancelledResult(question, mode, context);
						}
						return buildResult(question, context, mode, [answer]);
					}

					const answers = await askMultiChoice(uiCtx, question, context, options, signal);
					if (!answers) {
						return cancelledResult(question, mode, context);
					}
					return buildResult(question, context, mode, answers);
				}, signal);
			} catch (err: unknown) {
				const errorObj = err as { name?: string } | undefined;
				if (signal?.aborted || errorObj?.name === "AbortError") {
					return cancelledResult(question, mode, context);
				}
				throw err;
			}
		},

		renderCall(args, theme) {
			const rawOptions = args?.options as
				| ReadonlyArray<{ readonly label: string; readonly value?: string; readonly description?: string }>
				| undefined;
			const options = normalizeOptions(rawOptions);
			const question = typeof args?.question === "string" ? args.question : "";
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", question);
			if (args?.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result?.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result?.content?.[0];
				return new Text(first?.type === "text" && typeof first.text === "string" ? first.text : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			}

			if (details.status === "unavailable") {
				return new Text(
					theme.fg("warning", details.message || "ask_user_question unavailable"),
					0,
					0,
				);
			}

			const lines = (Array.isArray(details.answers) ? details.answers : []).map((answer) => {
				switch (answer.type) {
					case "text":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`;
					case "other":
						return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
					case "option":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
					default:
						return "";
				}
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
