import type { ReviewComment } from "../../review/types";
import { CodeContextReader } from "../../ui/code-context-reader";
import { CommentFormatter } from "../../ui/comment-formatter";
import type { UILogger } from "../../ui/logger";
import { promptOptionalNotes } from "../cli-prompts";

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
		return await promptOptionalNotes();
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
