import * as clack from "@clack/prompts";
import type GitOperations from "../../git/operations";
import type { GitProvider, PullRequest } from "../../providers/types";
import type { UILogger } from "../../ui/logger";
import { theme } from "../../ui/theme";
import { promptForPR, promptForRemote } from "../cli-prompts";

export class PRWorkflowManager {
	constructor(
		private git: GitOperations,
		private createProvider: (remote: string) => GitProvider,
		private ui: UILogger,
	) {}

	public async checkWorkspaceClean(): Promise<boolean> {
		const status = await this.git.hasUncommittedChanges();

		if (!status.hasChanges) {
			return false; // Workspace is clean
		}

		// Workspace has uncommitted changes
		this.ui.space();
		clack.log.warn(
			theme.warning("⚠ Uncommitted changes detected in your workspace"),
		);
		this.ui.space();

		if (status.staged.length > 0) {
			clack.log.info(theme.secondary("Staged files:"));
			for (const file of status.staged.slice(0, 5)) {
				this.ui.log(theme.muted(`  • ${file}`));
			}
			if (status.staged.length > 5) {
				this.ui.log(theme.muted(`  • ...and ${status.staged.length - 5} more`));
			}
			this.ui.space();
		}

		if (status.unstaged.length > 0) {
			clack.log.info(theme.secondary("Modified files:"));
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
			clack.log.info(theme.secondary("Untracked files:"));
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

		clack.log.error(
			theme.error(
				"✗ Mentat requires a clean working directory to safely switch branches.",
			),
		);
		this.ui.space();
		clack.log.step(theme.muted("Please save your work first:"));
		clack.log.step(
			theme.dim("  • Commit changes: git add . && git commit -m 'WIP'"),
		);
		clack.log.step(theme.dim("  • Or stash them: git stash push -m 'WIP'"));
		this.ui.space();

		clack.outro(theme.muted("Run Mentat again once your workspace is clean."));

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
					clack.outro(theme.warning(`⚠ Process interrupted (${signal})`));
				}
			} catch (error) {
				console.error(error);
				clack.log.error(
					theme.error("⚠ Failed to restore branch state\n") +
						theme.muted(
							`   Please manually run: git checkout ${currentBranch}`,
						),
				);
			} finally {
				if (signal) {
					process.exit(130); // 130 is standard exit code for SIGINT
				}
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

	public async fetchPullRequests(
		remote: string,
	): Promise<{ provider: GitProvider; prs: PullRequest[] }> {
		const s2 = this.ui.spinner();
		s2.start(theme.muted("Querying pull requests from remote"));

		const provider = this.createProvider(remote);
		const prs = await provider.fetchPullRequests();

		s2.stop(theme.success(`✓ Retrieved ${prs.length} pull request(s)`));

		if (prs.length === 0) {
			clack.outro(theme.warning("No pull requests found. Mentat standing by."));
			process.exit(0);
		}

		return { provider, prs };
	}

	public async selectPullRequest(prs: PullRequest[]): Promise<PullRequest> {
		const selectedPr = await promptForPR(prs);

		// Display selected PR info in consistent format
		this.ui.space();
		clack.log.step(theme.primary(`Target: ${selectedPr.title}`));
		this.ui.space();
		clack.log.info(
			`${theme.secondary("Source:")} ${selectedPr.source.name} ${theme.muted(`(${selectedPr.source.commitHash.substring(0, 8)})`)}`,
		);
		clack.log.info(
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
		const s4 = this.ui.spinner();
		s4.start(theme.muted("Computing diff matrix"));

		const fullDiff = await this.git.getDiff(
			pr.target.commitHash,
			pr.source.commitHash,
		);
		const editedFiles = await this.git.getDiffSummary(
			pr.target.commitHash,
			pr.source.commitHash,
		);

		s4.stop();

		if (editedFiles.length > 0) {
			const displayCount = Math.min(3, editedFiles.length);
			const remaining = editedFiles.length - displayCount;

			this.ui.info(theme.muted("Modified files:"));
			for (let i = 0; i < displayCount; i++) {
				const file = editedFiles[i];
				// Truncate long paths from the middle
				if (file && file.length > 70) {
					const parts = file.split("/");
					const truncated = `.../${parts.slice(-2).join("/")}`;
					this.ui.log(theme.secondary(`  • ${truncated}`));
				} else {
					this.ui.log(theme.secondary(`  • ${file}`));
				}
			}
			if (remaining > 0) {
				this.ui.log(theme.muted(`  • ...and ${remaining} more file(s)`));
			}
		}

		return { fullDiff, editedFiles };
	}

	public async fetchCommitHistory(
		provider: GitProvider,
		pr: PullRequest,
	): Promise<string[]> {
		this.ui.space();
		const s5 = this.ui.spinner();
		s5.start(theme.muted("Retrieving commit chronology"));

		const commitMessages = await provider.fetchCommits(pr);
		s5.stop();

		return commitMessages;
	}
}
