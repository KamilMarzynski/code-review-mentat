import * as clack from "@clack/prompts";
import { box, theme } from "./theme";

// Reasoning step counter
let stepCounter = 0;

export class UILogger {
	/**
	 * Reset step counter (call at start of agent execution)
	 */
	resetSteps() {
		stepCounter = 0;
	}

	/**
	 * Log a reasoning step
	 */
	step(message: string) {
		stepCounter++;
		console.log("");
		console.log(`${theme.accent(`  ${message}`)}`);
	}

	/**
	 * Log a tool call
	 */
	toolCall(toolName: string, input?: string) {
		console.log(
			theme.muted(`     → ${toolName}`) +
				(input ? theme.dim(`: ${input}`) : ""),
		);
	}

	/**
	 * Log a tool result (success)
	 */
	toolResult(summary: string) {
		console.log(theme.success(`     ✓ ${summary}`));
	}

	/**
	 * Log a tool error
	 */
	toolError(error: string) {
		console.log(theme.error(`     ✗ ${error}`));
	}

	/**
	 * Log agent thinking
	 */
	thinking(text: string) {
		console.log(theme.dim(`     ${text}`));
	}

	/**
	 * Start a new section
	 */
	section(title: string) {
		console.log("");
		console.log(theme.primary(`━━━ ${title} ━━━`));
		this.resetSteps();
	}

	/**
	 * Section complete
	 */
	sectionComplete(summary: string) {
		console.log(theme.success(`✓ ${summary}`));
		console.log("");
	}

	/**
	 * Wrapper around clack.spinner with theme
	 */
	spinner() {
		return clack.spinner();
	}

	/**
	 * Log info (uses clack)
	 */
	info(message: string) {
		clack.log.info(theme.muted(message));
	}

	/**
	 * Log success (uses clack)
	 */
	success(message: string) {
		clack.log.success(theme.success(message));
	}

	/**
	 * Log warning (uses clack)
	 */
	warn(message: string) {
		clack.log.warn(theme.warning(message));
	}

	/**
	 * Log error (uses clack)
	 */
	error(message: string) {
		clack.log.error(theme.error(message));
	}

	/**
	 * Add vertical spacing
	 */
	space() {
		console.log("");
	}

	/**
	 * Display a horizontal divider
	 */
	divider() {
		console.log(box.divider());
	}

	/**
	 * Display a header box
	 */
	header(title: string, subtitle?: string) {
		console.log("");
		console.log(box.top());
		console.log(box.row(theme.accent(`              ${title}              `)));
		if (subtitle) {
			console.log(box.row(theme.muted(`  ${subtitle}  `)));
		}
		console.log(box.bottom());
		console.log("");
	}

	/**
	 * Display a titled box section
	 */
	boxSection(title: string, content?: string[]) {
		console.log("");
		console.log(box.top(title));
		if (content) {
			for (const line of content) {
				console.log(`  ${line}`);
			}
		}
		console.log(box.bottom());
		console.log("");
	}

	/**
	 * Log a simple message (for migration from console.log)
	 */
	log(message: string) {
		console.log(message);
	}
}

// Export a default instance for convenience
export const ui = new UILogger();
