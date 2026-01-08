import * as clack from "@clack/prompts";
import type { ReviewComment } from "../review/types";
import { theme } from "../ui/theme";

export function displayHeader(): void {
	console.log("");
	console.log(
		theme.primary("╔═════════════════════════════════════════════════════╗"),
	);
	console.log(
		theme.primary("║") +
			theme.accent("                CODE REVIEW MENTAT                   ") +
			theme.primary("║"),
	);
	console.log(
		theme.primary("║") +
			theme.muted('    "It is by will alone I set my mind in motion"    ') +
			theme.primary("║"),
	);
	console.log(
		theme.primary("╚═════════════════════════════════════════════════════╝"),
	);
	console.log("");
}

export function displayContext(context: string): void {
	console.log("");
	console.log(theme.primary("━━━ 🧠 Deep Context ━━━"));
	console.log("");

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
				console.log(theme.primary(line));
			} else if (line.trim().startsWith("**")) {
				// Bold text in secondary color
				console.log(theme.secondary(line));
			} else if (line.trim().length > 0) {
				// Regular text muted
				console.log(theme.muted(line));
			} else {
				// Preserve empty lines
				console.log("");
			}
		}
	} else {
		console.log(theme.muted("  No additional context gathered."));
	}

	console.log("");
}

export function displayComments(comments: ReviewComment[]): void {
	if (comments && comments.length > 0) {
		clack.log.warn(theme.warning(`⚠ Found ${comments.length} observation(s):`));

		comments.forEach((comment, i) => {
			console.log(
				theme.muted(`  ${i + 1}. `) +
					theme.secondary(`${comment.file}:${comment.line || "?"}`) +
					theme.muted(` [${comment.severity?.toUpperCase()}]`),
			);
			console.log(
				theme.muted(
					`     ${comment.message.substring(0, 80)}${comment.message.length > 80 ? "..." : ""}`,
				),
			);
		});
	} else {
		clack.log.success(
			theme.success("✓ No issues detected. Code quality acceptable."),
		);
	}
}
