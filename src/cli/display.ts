import * as clack from "@clack/prompts";
import type { ReviewComment } from "../review/types";
import { box, theme } from "../ui/theme";
import { ui } from "../ui/logger";

export function displayHeader(): void {
	ui.space();
	ui.log(box.top());
	ui.log(
		box.row(theme.accent("              CODE REVIEW MENTAT              ")),
	);
	ui.log(
		box.row(theme.muted('  "It is by will alone I set my mind in motion"  ')),
	);
	ui.log(box.bottom());
	ui.space();
}

export function displayContext(context: string): void {
	ui.space();
	ui.section("🧠 Deep Context");
	ui.space();

	if (
		context &&
		context !== "No additional context found." &&
		context !== "Context gathering skipped."
	) {
		// Split into paragraphs and format nicely
		const contextLines = context.split("\n");
		for (const line of contextLines) {
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
		ui.warn(`⚠ Found ${comments.length} observation(s):`);

		comments.forEach((comment, i) => {
			ui.log(
				theme.muted(`  ${i + 1}. `) +
					theme.secondary(`${comment.file}:${comment.line || "?"}`) +
					theme.muted(` [${comment.severity?.toUpperCase()}]`),
			);
			ui.log(
				theme.muted(
					`     ${comment.message.substring(0, 80)}${comment.message.length > 80 ? "..." : ""}`,
				),
			);
		});
	} else {
		ui.success("✓ No issues detected. Code quality acceptable.");
	}
}
