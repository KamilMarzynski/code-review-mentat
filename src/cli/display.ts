import type { ReviewComment } from "../review/types";
import { ui } from "../ui/logger";
import { box, emoji, theme } from "../ui/theme";

export function displayHeader(): void {
	const headerWidth = 60; // Custom width for the header
	ui.space();
	ui.log(box.top(undefined, headerWidth));
	ui.log(box.centeredRow(theme.accent("CODE REVIEW MENTAT"), headerWidth));
	ui.log(
		box.centeredRow(
			theme.muted('"It is by will alone I set my mind in motion"'),
			headerWidth,
		),
	);
	ui.log(box.bottom(headerWidth));
	ui.space();
}

export function displayContext(context: string): void {
	ui.space();
	ui.section(`${emoji.brain} Deep Context`);
	ui.space();

	if (
		context &&
		context !== "No additional context found." &&
		context !== "Context gathering skipped."
	) {
		// Split into paragraphs and format nicely
		const contextLines = context.split("\n");
		for (const line of contextLines) {
			// Defensive: skip processing if line is undefined
			if (line === undefined) continue;

			if (line.trim().startsWith("#")) {
				// Headers in gold
				ui.log(theme.primary(line));
			} else if (line.trim().startsWith("**")) {
				// Bold text in secondary color
				ui.log(theme.secondary(line));
			} else if (line.trim().length > 0) {
				// Regular text muted
				ui.log(theme.muted(line));
			} else {
				// Preserve empty lines
				ui.space();
			}
		}
	} else {
		ui.log(theme.muted("  No additional context gathered."));
	}

	ui.space();
}

export function displayComments(comments: ReviewComment[]): void {
	if (comments && comments.length > 0) {
		ui.warn(`${emoji.warning} Found ${comments.length} observation(s):`);

		comments.forEach((comment, i) => {
			const message = comment.message || "";
			ui.log(
				theme.muted(`  ${i + 1}. `) +
					theme.secondary(`${comment.file}:${comment.line || "?"}`) +
					theme.muted(` [${comment.severity?.toUpperCase() || "UNKNOWN"}]`),
			);
			ui.log(
				theme.muted(
					`     ${message.substring(0, 80)}${message.length > 80 ? "..." : ""}`,
				),
			);
		});
	} else {
		ui.success(`${emoji.success} No issues detected. Code quality acceptable.`);
	}
}
