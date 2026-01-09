import * as clack from "@clack/prompts";
import type { ReviewComment } from "../../review/types";
import type { UILogger } from "../../ui/logger";
import { theme } from "../../ui/theme";

export class CommentDisplayService {
	constructor(private ui: UILogger) {}

	public async displayCommentWithContext(
		comment: ReviewComment,
	): Promise<void> {
		console.log("");

		// File info
		clack.log.info(theme.secondary(`📄 ${comment.file}`));

		// Line info
		if (comment.startLine && comment.endLine) {
			clack.log.step(
				theme.muted(`Lines ${comment.startLine}-${comment.endLine}`),
			);
		} else if (comment.line) {
			clack.log.step(theme.muted(`Line ${comment.line}`));
		}

		// Show the actual code lines
		try {
			const fs = await import("node:fs/promises");
			const fileContent = await fs.readFile(comment.file, "utf-8");
			const lines = fileContent.split("\n");

			const startLine = (comment.startLine || comment.line || 1) - 1;
			const endLine = comment.endLine || comment.line || startLine + 1;

			// Show a few lines of context before and after
			const contextBefore = 2;
			const contextAfter = 2;
			const displayStart = Math.max(0, startLine - contextBefore);
			const displayEnd = Math.min(lines.length, endLine + contextAfter);

			console.log("");
			clack.log.info(theme.dim("Code:"));

			for (let i = displayStart; i < displayEnd; i++) {
				const lineNum = i + 1;
				const lineContent = lines[i];

				// Highlight the problematic lines
				const isProblematic =
					(comment.line && lineNum === comment.line) ||
					(comment.startLine &&
						comment.endLine &&
						lineNum >= comment.startLine &&
						lineNum <= comment.endLine);

				const prefix = isProblematic ? theme.error("→ ") : "  ";
				const numStr = lineNum.toString().padStart(4, " ");
				const lineColor = isProblematic ? theme.error : theme.dim;

				console.log(`${prefix}${numStr} │ ${lineColor(lineContent)}`);
			}
		} catch (_error) {
			clack.log.warn(theme.warning("Could not read file to display context"));
		}

		// Comment details
		console.log("");
		clack.log.info(
			theme.secondary(`📝 ${comment.severity || "info"}`.toUpperCase()),
		);
		clack.log.step(theme.primary(comment.message));

		if (comment.rationale) {
			clack.log.step(theme.dim(`Why: ${comment.rationale}`));
		}
	}

	public async promptOptionalNotes(): Promise<string | undefined> {
		const response = await clack.text({
			message: "Any optional context/notes for Claude? (press Enter to skip)",
			placeholder: 'e.g., "Use async/await, not callbacks"',
		});

		if (clack.isCancel(response)) {
			return undefined;
		}

		const text = response as string;
		return text && text.trim().length > 0 ? text.trim() : undefined;
	}

	public async getFullDiff(): Promise<string> {
		try {
			const { exec } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execAsync = promisify(exec);

			// Get diff between target and current branch
			const { stdout } = await execAsync("git diff HEAD~1");
			return stdout;
		} catch (error) {
			this.ui.warn(`Could not get full diff: ${(error as Error).message}`);
			return "";
		}
	}
}
