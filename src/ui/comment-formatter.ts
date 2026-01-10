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
		this.ui.log(box.top("COMPUTATIONAL ASSESSMENT"));
		this.ui.space();

		// Severity breakdown
		this.ui.log(theme.secondary(`  ${emoji.chart} Severity Assessment:`));
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
			this.ui.log(theme.secondary(`  ${emoji.target} Probability Levels:`));
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
			this.ui.log(theme.secondary(`  ${emoji.pattern} Pattern Concentration:`));
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
		// File info with smart truncation
		let displayPath = comment.file;
		if (displayPath.length > 70) {
			const parts = displayPath.split("/");
			displayPath = `.../${parts.slice(-3).join("/")}`;
		}

		this.ui.log(
			theme.secondary(displayPath) +
				(comment.line ? theme.muted(`:${comment.line}`) : ""),
		);
		this.ui.space();

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

		// Consolidated severity + confidence + verification
		const severityBadge = badges.severity(comment.severity || "suggestion");
		const confidenceBadge = comment.confidence
			? ` ${emoji.target} ${comment.confidence.charAt(0).toUpperCase() + comment.confidence.slice(1)} Confidence`
			: "";
		const verifiedBadge = comment.verifiedBy
			? ` ${emoji.success} Verified`
			: "";

		this.ui.log(severityBadge + theme.muted(confidenceBadge + verifiedBadge));
		this.ui.space();

		// Message with word wrapping
		const message = comment.message || "No message provided";
		const wrappedMessage = this.wordWrap(message, 70);
		for (const line of wrappedMessage) {
			this.ui.log(theme.primary(line));
		}

		if (comment.rationale) {
			this.ui.space();
			this.ui.log(theme.secondary("Why?"));
			const wrappedRationale = this.wordWrap(comment.rationale, 68);
			for (const line of wrappedRationale) {
				this.ui.log(theme.dim(`  ${line}`));
			}
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

	private wordWrap(text: string, maxWidth: number): string[] {
		const words = text.split(" ");
		const lines: string[] = [];
		let currentLine = "";

		for (const word of words) {
			if ((currentLine + word).length > maxWidth && currentLine.length > 0) {
				lines.push(currentLine.trim());
				currentLine = word + " ";
			} else {
				currentLine += word + " ";
			}
		}

		if (currentLine.trim().length > 0) {
			lines.push(currentLine.trim());
		}

		return lines;
	}
}
