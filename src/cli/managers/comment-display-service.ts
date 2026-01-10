import * as clack from "@clack/prompts";
import type { ReviewComment } from "../../review/types";
import { CodeContextReader } from "../../ui/code-context-reader";
import { CommentFormatter } from "../../ui/comment-formatter";
import type { UILogger } from "../../ui/logger";

/**
 * Service for coordinating comment display and user interaction
 */
export class CommentDisplayService {
	private codeReader: CodeContextReader;
	private formatter: CommentFormatter;

	constructor(private ui: UILogger) {
		this.codeReader = new CodeContextReader();
		this.formatter = new CommentFormatter(ui, this.codeReader);
	}

	/**
	 * Display review summary with statistics
	 */
	public displayReviewSummary(comments: ReviewComment[]): void {
		this.formatter.displayReviewSummary(comments);
	}

	/**
	 * Display a comment with code context
	 */
	public async displayCommentWithContext(
		comment: ReviewComment,
	): Promise<void> {
		await this.formatter.displayCommentWithContext(comment);
	}

	/**
	 * Prompt user for optional notes
	 */
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

	/**
	 * Get full diff for context
	 */
	public async getFullDiff(): Promise<string> {
		const diff = await this.codeReader.getFullDiff();
		if (!diff) {
			this.ui.warn("Could not get full diff");
		}
		return diff;
	}
}
