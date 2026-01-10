import chalk from "chalk";

// Emoji configuration - centralized for consistency
export const emoji = {
	// Status indicators
	success: "✓",
	warning: "⚠",
	error: "✗",
	info: "ℹ️",

	// Severity levels
	risk: "🔴",
	issue: "🟠",
	suggestion: "🔵",
	nit: "⚪",

	// Common symbols
	brain: "🧠",
	file: "📄",
	chart: "📊",
	target: "🎯",
	fire: "🔥",
	tool: "🔧",
	refresh: "🔄",
	pending: "⏳",
	lightning: "⚡",

	// Mentat-specific (computational analysis)
	computation: "⚙️",
	synthesis: "🧩",
	pattern: "〰️",
	data: "💾",

	// Arrows
	arrow: "→",
	pipe: "│",
};

// Dune/Mentat theme
export const theme = {
	primary: chalk.hex("#D4AF37"), // Gold
	secondary: chalk.hex("#8B7355"), // Sand
	accent: chalk.hex("#4A90E2"), // Spice blue
	success: chalk.hex("#2ECC71"), // Green
	warning: chalk.hex("#F39C12"), // Orange
	error: chalk.hex("#E74C3C"), // Red
	muted: chalk.gray,
	dim: chalk.dim,
	// Mentat-specific variants
	computation: chalk.hex("#D4AF37"), // Gold for computation/analysis
	data: chalk.hex("#8B7355"), // Sand for data references
	insight: chalk.hex("#4A90E2"), // Spice blue for insights/findings
};

// Badge generators for consistent UI elements
export const badges = {
	severity: (severity: string): string => {
		const badgeMap: Record<string, string> = {
			risk: theme.error(`${emoji.risk} RISK`),
			issue: theme.warning(`${emoji.issue} ISSUE`),
			suggestion: theme.accent(`${emoji.suggestion} SUGGESTION`),
			nit: theme.muted(`${emoji.nit} NIT`),
		};
		return badgeMap[severity] || theme.muted(`${emoji.info} INFO`);
	},

	confidence: (confidence: string): string => {
		const badgeMap: Record<string, string> = {
			high: theme.success(`${emoji.target} High Confidence`),
			medium: theme.accent("○ Medium Confidence"),
			low: theme.muted("? Low Confidence"),
		};
		return badgeMap[confidence] || "";
	},

	status: (status: string): string => {
		const badgeMap: Record<string, string> = {
			pending: theme.warning(`${emoji.pending} Pending`),
			resolved: theme.success(`${emoji.success} Resolved`),
			ignored: theme.muted("⊘ Ignored"),
		};
		return badgeMap[status] || theme.muted(status);
	},
};

// Box drawing utilities for consistent bordered sections
export const box = {
	// Standard box width for consistency
	WIDTH: 55,

	top: (title?: string, width?: number): string => {
		const boxWidth = width ?? box.WIDTH;
		if (title) {
			// Total width = boxWidth
			// Format: ╔ + equals + space + title + space + equals + ╗
			// Fixed chars: ╔ (1) + space (1) + title + space (1) + ╗ (1) = 4 + title.length
			const titleLength = title.length;
			const remainingForEquals = boxWidth - 4 - titleLength;

			// Prevent negative padding if title is too long
			if (remainingForEquals < 0) {
				// Title too long, truncate it
				const maxTitleLength = boxWidth - 10;
				const truncated = `${title.substring(0, maxTitleLength)}...`;
				return theme.primary(
					`╔${"═".repeat(3)} ${truncated} ${"═".repeat(3)}╗`,
				);
			}

			const leftPad = Math.floor(remainingForEquals / 2);
			const rightPad = remainingForEquals - leftPad;
			return theme.primary(
				`╔${"═".repeat(leftPad)} ${title} ${"═".repeat(rightPad)}╗`,
			);
		}
		return theme.primary(`╔${"═".repeat(boxWidth - 2)}╗`);
	},

	bottom: (width?: number): string => {
		const boxWidth = width ?? box.WIDTH;
		return theme.primary(`╚${"═".repeat(boxWidth - 2)}╝`);
	},

	row: (content: string, width?: number): string => {
		const boxWidth = width ?? box.WIDTH;
		// Strip ANSI escape codes to get the actual visual length
		const strippedLength = content.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes
			/\x1b\[[0-9;]*m/g,
			"",
		).length;
		const padding = boxWidth - strippedLength - 4; // 4 for "║  ║"
		// Prevent negative padding if content is too long
		const actualPadding = Math.max(0, padding);
		return (
			theme.primary("║ ") +
			content +
			" ".repeat(actualPadding) +
			theme.primary(" ║")
		);
	},

	centeredRow: (content: string, width?: number): string => {
		const boxWidth = width ?? box.WIDTH;
		// Strip ANSI escape codes to get the actual visual length
		const strippedLength = content.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes
			/\x1b\[[0-9;]*m/g,
			"",
		).length;
		const totalPadding = boxWidth - strippedLength - 4; // 4 for "║  ║"
		// Prevent negative padding if content is too long
		const actualPadding = Math.max(0, totalPadding);
		const leftPad = Math.floor(actualPadding / 2);
		const rightPad = actualPadding - leftPad;
		return (
			theme.primary("║ ") +
			" ".repeat(leftPad) +
			content +
			" ".repeat(rightPad) +
			theme.primary(" ║")
		);
	},

	divider: (width?: number): string => {
		const dividerWidth = width ?? 60;
		return theme.muted("─".repeat(dividerWidth));
	},
};
