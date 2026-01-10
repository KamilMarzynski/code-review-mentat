import chalk from "chalk";

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
};

// Badge generators for consistent UI elements
export const badges = {
	severity: (severity: string): string => {
		const badgeMap: Record<string, string> = {
			risk: theme.error("🔴 RISK"),
			issue: theme.warning("🟠 ISSUE"),
			suggestion: theme.accent("🔵 SUGGESTION"),
			nit: theme.muted("⚪ NIT"),
		};
		return badgeMap[severity] || theme.muted("ℹ️ INFO");
	},

	confidence: (confidence: string): string => {
		const badgeMap: Record<string, string> = {
			high: theme.success("🎯 High Confidence"),
			medium: theme.accent("○ Medium Confidence"),
			low: theme.muted("? Low Confidence"),
		};
		return badgeMap[confidence] || "";
	},

	status: (status: string): string => {
		const badgeMap: Record<string, string> = {
			pending: theme.warning("⏳ Pending"),
			resolved: theme.success("✓ Resolved"),
			ignored: theme.muted("⊘ Ignored"),
		};
		return badgeMap[status] || theme.muted(status);
	},
};

// Box drawing utilities for consistent bordered sections
export const box = {
	// Standard box width for consistency
	WIDTH: 55,

	top: (title?: string): string => {
		if (title) {
			const paddingTotal = box.WIDTH - title.length - 6; // 6 for "╔═══  ═══╗"
			const leftPad = Math.floor(paddingTotal / 2);
			const rightPad = paddingTotal - leftPad;
			return theme.primary(
				`╔═══${"═".repeat(leftPad)} ${title} ${"═".repeat(rightPad)}═══╗`,
			);
		}
		return theme.primary(`╔${"═".repeat(box.WIDTH - 2)}╗`);
	},

	bottom: (): string => {
		return theme.primary(`╚${"═".repeat(box.WIDTH - 2)}╝`);
	},

	row: (content: string): string => {
		const strippedLength = content.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes
			/\x1b\[[0-9;]*m/g,
			"",
		).length;
		const padding = box.WIDTH - strippedLength - 4; // 4 for "║  ║"
		return (
			theme.primary("║") + content + " ".repeat(padding) + theme.primary("║")
		);
	},

	divider: (): string => {
		return theme.muted("─".repeat(60));
	},
};
