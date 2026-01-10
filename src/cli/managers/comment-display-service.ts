import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import * as clack from "@clack/prompts";
import type { ReviewComment } from "../../review/types";
import type { UILogger } from "../../ui/logger";
import { theme } from "../../ui/theme";

export class CommentDisplayService {
	constructor(private ui: UILogger) {}

	public displayReviewSummary(comments: ReviewComment[]): void {
		if (comments.length === 0) {
			return;
		}

		const byFile = this.groupByFile(comments);
		const bySeverity = this.groupBySeverity(comments);
		const byConfidence = this.groupByConfidence(comments);

		console.log("");
		console.log(theme.primary("╔═══ REVIEW SUMMARY ═══╗"));
		console.log("");

		// Severity breakdown
		console.log(theme.secondary("  📊 By Severity:"));
		console.log(theme.error(`     🔴 Risks:       ${bySeverity.risk || 0}`));
		console.log(theme.warning(`     🟠 Issues:      ${bySeverity.issue || 0}`));
		console.log(
			theme.accent(`     🔵 Suggestions: ${bySeverity.suggestion || 0}`),
		);
		console.log(theme.muted(`     ⚪ Nits:        ${bySeverity.nit || 0}`));

		// Confidence breakdown (if any comments have confidence)
		if (byConfidence.high || byConfidence.medium || byConfidence.low) {
			console.log("");
			console.log(theme.secondary("  🎯 By Confidence:"));
			if (byConfidence.high) {
				console.log(
					theme.success(`     ✓ High:   ${byConfidence.high} (verified)`),
				);
			}
			if (byConfidence.medium) {
				console.log(theme.accent(`     ○ Medium: ${byConfidence.medium}`));
			}
			if (byConfidence.low) {
				console.log(theme.muted(`     ? Low:    ${byConfidence.low}`));
			}
		}

		// Hotspot files (top 5)
		const hotspots = Object.entries(byFile)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5);

		if (hotspots.length > 0) {
			console.log("");
			console.log(theme.secondary("  🔥 Hotspot Files:"));
			for (const [file, count] of hotspots) {
				const countLabel = count === 1 ? "comment" : "comments";
				console.log(
					theme.muted(
						`     ${count}× ${file} ${theme.dim(`(${count} ${countLabel})`)}`,
					),
				);
			}
		}

		console.log("");
		console.log(theme.primary("╚═════════════════════╝"));
		console.log("");
	}

	private groupByFile(comments: ReviewComment[]): Record<string, number> {
		const grouped: Record<string, number> = {};
		for (const comment of comments) {
			grouped[comment.file] = (grouped[comment.file] || 0) + 1;
		}
		return grouped;
	}

	private groupBySeverity(comments: ReviewComment[]): Record<string, number> {
		const grouped: Record<string, number> = {
			risk: 0,
			issue: 0,
			suggestion: 0,
			nit: 0,
		};
		for (const comment of comments) {
			const severity = comment.severity || "suggestion";
			grouped[severity] = (grouped[severity] || 0) + 1;
		}
		return grouped;
	}

	private groupByConfidence(comments: ReviewComment[]): Record<string, number> {
		const grouped: Record<string, number> = {
			high: 0,
			medium: 0,
			low: 0,
		};
		for (const comment of comments) {
			if (comment.confidence) {
				grouped[comment.confidence] = (grouped[comment.confidence] || 0) + 1;
			}
		}
		return grouped;
	}

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
			const fileContent = await readFile(comment.file, "utf-8");
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

		// Comment details with enhanced badges
		console.log("");
		const severityBadge = this.getSeverityBadge(
			comment.severity || "suggestion",
		);
		clack.log.info(severityBadge);

		// Confidence indicator
		if (comment.confidence) {
			const confidenceBadge = this.getConfidenceBadge(comment.confidence);
			clack.log.step(confidenceBadge);
		}

		// Verification info
		if (comment.verifiedBy) {
			clack.log.step(theme.success(`✓ Verified: ${comment.verifiedBy}`));
		}

		clack.log.step(theme.primary(comment.message));

		if (comment.rationale) {
			clack.log.step(theme.dim(`Why: ${comment.rationale}`));
		}
	}

	private getSeverityBadge(severity: string): string {
		const badges: Record<string, string> = {
			risk: theme.error("🔴 RISK"),
			issue: theme.warning("🟠 ISSUE"),
			suggestion: theme.accent("🔵 SUGGESTION"),
			nit: theme.muted("⚪ NIT"),
		};
		return badges[severity] || theme.muted("ℹ️ INFO");
	}

	private getConfidenceBadge(confidence: string): string {
		const badges: Record<string, string> = {
			high: theme.success("🎯 High Confidence"),
			medium: theme.accent("○ Medium Confidence"),
			low: theme.muted("? Low Confidence"),
		};
		return badges[confidence] || "";
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
