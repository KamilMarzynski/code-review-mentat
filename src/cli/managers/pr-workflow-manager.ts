import type GitOperations from "../../git/operations";
import type {
	CreatePullRequestCommentRequest,
	GitProvider,
	PullRequest,
} from "../../git-providers/types";
import type { ReviewComment } from "../../review/types";
import type { UILogger } from "../../ui/logger";
import { theme } from "../../ui/theme";
import { promptForPR, promptForRemote } from "../cli-prompts";

export class PRWorkflowManager {
	private provider: GitProvider | null = null;

	constructor(
		private git: GitOperations,
		// TODO: Inject a factory or use a provider registry
		private createProvider: (remote: string) => GitProvider,
		private ui: UILogger,
	) {}

	public async setProviderForRemote(remote: string): Promise<void> {
		this.provider = this.createProvider(remote);
	}

	public async checkWorkspaceClean(): Promise<boolean> {
		const status = await this.git.hasUncommittedChanges();

		if (!status.hasChanges) {
			return false; // Workspace is clean
		}

		// Workspace has uncommitted changes
		this.ui.space();
		this.ui.warn(
			theme.warning("⚠ Uncommitted changes detected in your workspace"),
		);
		this.ui.space();

		if (status.staged.length > 0) {
			this.ui.info(theme.secondary("Staged files:"));
			for (const file of status.staged.slice(0, 5)) {
				this.ui.log(theme.muted(`  • ${file}`));
			}
			if (status.staged.length > 5) {
				this.ui.log(theme.muted(`  • ...and ${status.staged.length - 5} more`));
			}
			this.ui.space();
		}

		if (status.unstaged.length > 0) {
			this.ui.info(theme.secondary("Modified files:"));
			for (const file of status.unstaged.slice(0, 5)) {
				this.ui.log(theme.muted(`  • ${file}`));
			}
			if (status.unstaged.length > 5) {
				this.ui.log(
					theme.muted(`  • ...and ${status.unstaged.length - 5} more`),
				);
			}
			this.ui.space();
		}

		if (status.untracked.length > 0) {
			this.ui.info(theme.secondary("Untracked files:"));
			for (const file of status.untracked.slice(0, 5)) {
				this.ui.log(theme.muted(`  • ${file}`));
			}
			if (status.untracked.length > 5) {
				this.ui.log(
					theme.muted(`  • ...and ${status.untracked.length - 5} more`),
				);
			}
			this.ui.space();
		}

		this.ui.error(
			theme.error(
				"✗ Computational integrity requires a clean workspace to safely switch branches.",
			),
		);
		this.ui.space();
		this.ui.logStep(theme.muted("Please save your work first:"));
		this.ui.logStep(
			theme.dim("  • Commit changes: git add . && git commit -m 'WIP'"),
		);
		this.ui.logStep(theme.dim("  • Or stash them: git stash push -m 'WIP'"));
		this.ui.space();

		this.ui.outro(
			theme.muted("Run Mentat again once your workspace is clean."),
		);

		return true; // Workspace is dirty
	}

	public async setupCleanupHandlers(): Promise<{
		cleanup: (signal?: string) => Promise<void>;
		cleanupDone: { value: boolean };
	}> {
		const currentBranch = await this.git.getCurrentBranch();
		const cleanupDone = { value: false };

		const cleanup = async (signal?: string) => {
			if (cleanupDone.value) {
				return;
			}
			cleanupDone.value = true;

			try {
				console.log(""); // Ensure clean line
				const s = this.ui.spinner();
				s.start(theme.muted(`Restoring original state (${currentBranch})...`));
				await this.git.checkout(currentBranch);
				s.stop(theme.success("✓ Repository state restored"));

				if (signal) {
					this.ui.outro(theme.warning(`⚠ Process interrupted (${signal})`));
				}
			} catch (error) {
				console.error(error);
				this.ui.error(
					theme.error("⚠ Failed to restore branch state\n") +
						theme.muted(
							`   Please manually run: git checkout ${currentBranch}`,
						),
				);
			} finally {
				if (signal) {
					process.exit(130); // 130 is standard exit code for SIGINT
				}
				process.exit(0);
			}
		};

		const signalHandler = (signal: string) => {
			cleanup(signal).catch(() => process.exit(1));
		};

		process.on("SIGINT", () => signalHandler("SIGINT"));
		process.on("SIGTERM", () => signalHandler("SIGTERM"));

		return { cleanup, cleanupDone };
	}

	public async selectRemote(): Promise<string> {
		const s1 = this.ui.spinner();
		s1.start(theme.muted("Scanning git remotes"));

		const allRemotes = await this.git.getRemotes();
		s1.stop(theme.success(`✓ Found ${allRemotes.length} remote(s)`));

		return promptForRemote(allRemotes);
	}

	public async fetchPullRequests(): Promise<{ prs: PullRequest[] }> {
		if (!this.provider) {
			throw new Error("Git provider not set. Call setProviderForRemote first.");
		}
		const s2 = this.ui.spinner();
		s2.start(theme.muted("Querying pull requests from remote"));

		const prs = await this.provider.fetchPullRequests();

		s2.stop(theme.success(`✓ Retrieved ${prs.length} pull request(s)`));

		if (prs.length === 0) {
			this.ui.outro(
				theme.warning("No pull requests found. Mentat standing by."),
			);
			process.exit(0);
		}

		return { prs };
	}

	public async selectPullRequest(prs: PullRequest[]): Promise<PullRequest> {
		const selectedPr = await promptForPR(prs);

		// Display selected PR info in consistent format
		this.ui.space();
		this.ui.logStep(theme.primary(`Target: ${selectedPr.title}`));
		this.ui.space();
		this.ui.info(
			`${theme.secondary("Source:")} ${selectedPr.source.name} ${theme.muted(`(${selectedPr.source.commitHash.substring(0, 8)})`)}`,
		);
		this.ui.info(
			`${theme.secondary("Target:")} ${selectedPr.target.name} ${theme.muted(`(${selectedPr.target.commitHash.substring(0, 8)})`)}`,
		);

		return selectedPr;
	}

	public async prepareRepository(
		remote: string,
		pr: PullRequest,
	): Promise<void> {
		const s3 = this.ui.spinner();
		s3.start(theme.muted("Synchronizing repository state"));

		try {
			s3.message(theme.muted("Fetching PR branches"));
			await this.git.fetch(remote, pr.source.name);
			await this.git.fetch(remote, pr.target.name);

			s3.message(
				theme.muted("Entering computation state (checking out source)"),
			);
			await this.git.checkout(pr.source.name);

			s3.stop(theme.success("✓ Repository prepared"));
		} catch (error) {
			s3.stop(theme.error("✗ Repository synchronization failed"));
			this.ui.error(
				`Failed to prepare repository: ${(error as Error).message}`,
			);
			this.ui.info(`Try running: git fetch ${remote} ${pr.source.name}`);
			throw error;
		}
	}

	public async analyzeChanges(
		pr: PullRequest,
	): Promise<{ fullDiff: string; editedFiles: string[] }> {
		const fullDiff = await this.git.getDiff(
			pr.target.commitHash,
			pr.source.commitHash,
		);
		const editedFiles = await this.git.getDiffSummary(
			pr.target.commitHash,
			pr.source.commitHash,
		);

		return { fullDiff, editedFiles };
	}

	public async fetchCommitHistory(pr: PullRequest): Promise<string[]> {
		if (!this.provider) {
			throw new Error("Git provider not set. Call setProviderForRemote first.");
		}

		const commitMessages = await this.provider.fetchCommits(pr);

		return commitMessages;
	}

	public async postCommentsToRemote(
		pr: PullRequest,
		comments: ReviewComment[],
	): Promise<void> {
		if (!this.provider) {
			throw new Error("Git provider not set. Call setProviderForRemote first.");
		}
		if (comments.length === 0) {
			this.ui.info(theme.muted("No comments to post to remote."));
			return;
		}

		const prComments: CreatePullRequestCommentRequest[] = comments.map(
			(comment) => ({
				text: `${comment.severity ? `_[${comment.severity}]_ ` : ""}${comment.message}. \n **Rationale**: ${comment.rationale} \n \n _Comment created by Mentat Code Review CLI._`,
				path: comment.file,
				line: comment.line,
				severity: comment.severity,
			}),
		);

		for (const prComment of prComments) {
			try {
				await this.provider.createPullRequestComment(pr, prComment);
				this.ui.success(
					theme.success(
						`✓ Posted comment to ${prComment.path ? `${prComment.path}:${prComment.line}` : "PR discussion"}`,
					),
				);
			} catch (error) {
				console.log(JSON.stringify(error, null, 2));
				this.ui.error(
					theme.error(
						`✗ Failed to post comment to ${prComment.path ? `${prComment.path}:${prComment.line}` : "PR discussion"}: ${(error as Error).message}`,
					),
				);
			}
		}
	}
}
