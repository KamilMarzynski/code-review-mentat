import * as clack from "@clack/prompts";
import type { ReviewComment } from "../review/types";
import type { CodeContextReader } from "./code-context-reader";
import type { UILogger } from "./logger";
import { badges, box, emoji, theme } from "./theme";

/**
 * Formats and displays review comments with context
 */
export class CommentFormatter {
	constructor(
		private ui: UILogger,
		private codeReader: CodeContextReader,
	) {}

	/**
	 * Display a comprehensive review summary
	 */
	displayReviewSummary(comments: ReviewComment[]): void {
		if (comments.length === 0) {
			return;
		}

		const byFile = this.groupByFile(comments);
		const bySeverity = this.groupBySeverity(comments);
		const byConfidence = this.groupByConfidence(comments);

		this.ui.space();
		this.ui.log(box.top("REVIEW SUMMARY"));
		this.ui.space();

		// Severity breakdown
		this.ui.log(theme.secondary(`  ${emoji.chart} By Severity:`));
		this.ui.log(
			theme.error(`     ${emoji.risk} Risks:       ${bySeverity.risk || 0}`),
		);
		this.ui.log(
			theme.warning(
				`     ${emoji.issue} Issues:      ${bySeverity.issue || 0}`,
			),
		);
		this.ui.log(
			theme.accent(
				`     ${emoji.suggestion} Suggestions: ${bySeverity.suggestion || 0}`,
			),
		);
		this.ui.log(
			theme.muted(`     ${emoji.nit} Nits:        ${bySeverity.nit || 0}`),
		);

		// Confidence breakdown (if any comments have confidence)
		if (byConfidence.high || byConfidence.medium || byConfidence.low) {
			this.ui.space();
			this.ui.log(theme.secondary(`  ${emoji.target} By Confidence:`));
			if (byConfidence.high) {
				this.ui.log(
					theme.success(
						`     ${emoji.success} High:   ${byConfidence.high} (verified)`,
					),
				);
			}
			if (byConfidence.medium) {
				this.ui.log(theme.accent(`     ○ Medium: ${byConfidence.medium}`));
			}
			if (byConfidence.low) {
				this.ui.log(theme.muted(`     ? Low:    ${byConfidence.low}`));
			}
		}

		// Hotspot files (top 5)
		const hotspots = Object.entries(byFile)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5);

		if (hotspots.length > 0) {
			this.ui.space();
			this.ui.log(theme.secondary(`  ${emoji.fire} Hotspot Files:`));
			for (const [file, count] of hotspots) {
				// Defensive: ensure file and count exist
				if (!file || count === undefined) continue;
				const countLabel = count === 1 ? "comment" : "comments";
				this.ui.log(
					theme.muted(
						`     ${count}× ${file} ${theme.dim(`(${count} ${countLabel})`)}`,
					),
				);
			}
		}

		this.ui.space();
		this.ui.log(box.bottom());
		this.ui.space();
	}

	/**
	 * Display a single comment with full code context
	 */
	async displayCommentWithContext(comment: ReviewComment): Promise<void> {
		this.ui.space();

		// File info
		this.ui.info(theme.secondary(`${emoji.file} ${comment.file}`));

		// Line info
		if (comment.startLine && comment.endLine) {
			clack.log.step(
				theme.muted(`Lines ${comment.startLine}-${comment.endLine}`),
			);
		} else if (comment.line) {
			clack.log.step(theme.muted(`Line ${comment.line}`));
		}

		// Show the actual code lines
		const codeContext = comment.startLine
			? await this.codeReader.readFileRange(
					comment.file,
					comment.startLine,
					comment.endLine || comment.startLine,
				)
			: await this.codeReader.readFileLines(comment.file, comment.line || 1);

		if (codeContext.success) {
			this.ui.space();
			this.ui.info(theme.dim("Code:"));

			for (const line of codeContext.lines) {
				const prefix = line.isTarget ? theme.error(`${emoji.arrow} `) : "  ";
				const numStr = line.lineNum.toString().padStart(4, " ");
				const lineColor = line.isTarget ? theme.error : theme.dim;

				this.ui.log(
					`${prefix}${numStr} ${emoji.pipe} ${lineColor(line.content)}`,
				);
			}
		} else {
			this.ui.warn("Could not read file to display context");
		}

		// Comment details with enhanced badges
		this.ui.space();
		const severityBadge = badges.severity(comment.severity || "suggestion");
		this.ui.info(severityBadge);

		// Confidence indicator
		if (comment.confidence) {
			const confidenceBadge = badges.confidence(comment.confidence);
			clack.log.step(confidenceBadge);
		}

		// Verification info
		if (comment.verifiedBy) {
			clack.log.step(
				theme.success(`${emoji.success} Verified: ${comment.verifiedBy}`),
			);
		}

		clack.log.step(theme.primary(comment.message || "No message provided"));

		if (comment.rationale) {
			clack.log.step(theme.dim(`Why: ${comment.rationale}`));
		}
	}

	private groupByFile(comments: ReviewComment[]): Record<string, number> {
		const grouped: Record<string, number> = {};
		for (const comment of comments) {
			// Defensive: skip comments without a file path
			if (!comment.file) continue;
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
}
