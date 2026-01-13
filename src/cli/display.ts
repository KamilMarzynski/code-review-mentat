import packageJson from "../../package.json" with { type: "json" };
import type { ReviewComment } from "../review/types";
import { ui } from "../ui/logger";
import { box, emoji, theme } from "../ui/theme";

export function displayHeader(): void {
	const headerWidth = 60; // Custom width for the header
	const version = packageJson.version;
	const versionLabel = `version: ${version}`;

	ui.space();
	ui.log(box.top(versionLabel, headerWidth));
	ui.log(box.centeredRow(theme.accent("CODE REVIEW MENTAT"), headerWidth));
	ui.log(
		box.centeredRow(
			theme.muted('"It is by caffeine alone I set my mind in motion"'),
			headerWidth,
		),
	);
	ui.log(box.bottom(headerWidth));
	ui.space();
}

export function displayContext(context: string): void {
	ui.space();
	ui.section(`${emoji.computation} Deep Context`);
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

export function displayEditedFiles(editedFiles: string[]): void {
	const MAX_DISPLAYED_FILES = 4;

	if (editedFiles.length > 0) {
		const displayCount = Math.min(MAX_DISPLAYED_FILES, editedFiles.length);
		const remaining = editedFiles.length - displayCount;

		ui.info(theme.muted("Modified files:"));
		for (let i = 0; i < displayCount; i++) {
			const file = editedFiles[i];
			// Truncate long paths from the middle
			if (file && file.length > 70) {
				const parts = file.split("/");
				const truncated = `.../${parts.slice(-2).join("/")}`;
				ui.log(theme.secondary(`  • ${truncated}`));
			} else {
				ui.log(theme.secondary(`  • ${file}`));
			}
		}
		if (remaining > 0) {
			ui.log(theme.muted(`  • ...and ${remaining} more file(s)`));
		}
	}
}

export function displayCommitHistory(commitMessages: string[]): void {
	const MAX_DISPLAYED_COMMITS = 4;

	if (commitMessages.length > 0) {
		const displayCount = Math.min(MAX_DISPLAYED_COMMITS, commitMessages.length);
		const remaining = commitMessages.length - displayCount;

		ui.info(theme.muted("Commit history:"));
		for (let i = 0; i < displayCount; i++) {
			const commit = commitMessages[i];
			// Truncate long commit messages
			if (commit && commit.length > 70) {
				const truncated = `${commit.substring(0, 67)}...`;
				ui.log(theme.secondary(`  • ${truncated}`));
			} else {
				ui.log(theme.secondary(`  • ${commit}`));
			}
		}
		if (remaining > 0) {
			ui.log(theme.muted(`  • ...and ${remaining} more commit(s)`));
		}
	}
}
