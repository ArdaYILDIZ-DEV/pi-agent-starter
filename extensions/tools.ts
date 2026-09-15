/**
 * Tools Extension for Pi coding agent.
 *
 * Provides an interactive /tools TUI command to dynamically enable or disable tools.
 * Persists tool selection across sessions via disk configuration (`tools.json`)
 * and session branches.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";

// State persisted to disk and session
interface ToolsState {
	enabledTools: string[];
}

function getGlobalToolsFilePath(): string {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "tools.json");
}

function getToolsFilePath(): string {
	const projectPath = join(process.cwd(), ".pi", "tools.json");
	if (existsSync(projectPath)) {
		return projectPath;
	}
	return getGlobalToolsFilePath();
}

function loadToolsFromFile(): string[] | undefined {
	const filePath = getToolsFilePath();
	if (!existsSync(filePath)) {
		return undefined;
	}
	try {
		const raw = readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw);
		if (Array.isArray(data)) {
			return data.filter((item): item is string => typeof item === "string");
		}
		if (data && Array.isArray(data.enabledTools)) {
			return data.enabledTools.filter(
				(item: unknown): item is string => typeof item === "string",
			);
		}
	} catch {
		// Ignore corrupted JSON or read error
	}
	return undefined;
}

function saveToolsToFile(tools: string[]): void {
	const filePath = getToolsFilePath();
	try {
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const content = JSON.stringify({ enabledTools: tools }, null, 2) + "\n";
		writeFileSync(filePath, content, "utf-8");
	} catch {
		// Best-effort write
	}
}

export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// Persist current state
	function persistState() {
		const toolsArray = Array.from(enabledTools);
		saveToolsToFile(toolsArray);
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: toolsArray,
		});
	}

	// Apply current tool selection
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	// Restore tool selection: file configuration first, branch fallback
	function restoreState(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
		const allToolNames = allTools.map((t) => t.name);

		// 1. Try file first
		let savedTools = loadToolsFromFile();

		// 2. Fallback to branch entries if file does not exist yet
		if (!savedTools) {
			const branchEntries = ctx.sessionManager.getBranch();
			for (const entry of branchEntries) {
				if (entry.type === "custom" && entry.customType === "tools-config") {
					const data = entry.data as ToolsState | undefined;
					if (data?.enabledTools) {
						savedTools = data.enabledTools;
					}
				}
			}
			// If found in branch, save to file so future sessions have it
			if (savedTools) {
				saveToolsToFile(savedTools);
			}
		}

		if (savedTools) {
			// Restore saved tool selection (filter to only tools that still exist)
			enabledTools = new Set(
				savedTools.filter((t: string) => allToolNames.includes(t)),
			);
			applyTools();
		} else {
			// No saved state - sync with currently active tools
			enabledTools = new Set(pi.getActiveTools());
		}
	}

	// Register /tools command
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tools requires an interactive UI", "error");
				return;
			}

			// Refresh tool list
			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				// Build settings items for each tool
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Update enabled state and apply immediately
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// Close dialog
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	// Restore state when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});
}
