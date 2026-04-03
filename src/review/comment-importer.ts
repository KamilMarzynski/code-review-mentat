import { randomUUID } from "node:crypto";
import type LocalCache from "../cache/local-cache";
import type {
	GitProvider,
	PullRequest,
	RemoteComment,
} from "../git-providers/types";
import { getPRKey } from "../git-providers/types";
import type {
	AnyStoredComment,
	ImportedComment,
	StoredReviewComment,
} from "./types";

export type ImportResult = {
	fetched: number;
	added: number;
	updated: number;
};

export class CommentImporter {
	constructor(private cache: LocalCache) {}

	async importForPR(
		provider: GitProvider,
		pr: PullRequest,
	): Promise<ImportResult> {
		const prKey = getPRKey(pr);

		const remoteComments = await provider.fetchPullRequestComments(pr);
		const incoming = remoteComments.map((c) => this.normalize(c));

		const existing = (await this.cache.getComments(
			prKey,
		)) as AnyStoredComment[];

		const { merged, added, updated } = this.merge(incoming, existing);

		await this.cache.saveComments(
			prKey,
			merged as unknown as StoredReviewComment[],
		);

		this.cache.setImportedAt(
			{ sourceBranch: pr.source.name, targetBranch: pr.target.name },
			new Date().toISOString(),
		);

		return { fetched: remoteComments.length, added, updated };
	}

	private normalize(remote: RemoteComment): ImportedComment {
		return {
			id: randomUUID(),
			file: remote.filePath ?? "",
			line: remote.line,
			startLine: remote.startLine,
			message: remote.content,
			status: "imported",
			source: "imported",
			importMeta: {
				remoteId: remote.id,
				remoteAuthor: remote.author,
				remoteUrl: remote.url,
				importedAt: new Date().toISOString(),
				resolvedOnRemote: remote.resolved,
			},
		};
	}

	private merge(
		incoming: ImportedComment[],
		existing: AnyStoredComment[],
	): { merged: AnyStoredComment[]; added: number; updated: number } {
		let added = 0;
		let updated = 0;

		const result: AnyStoredComment[] = [...existing];

		for (const comment of incoming) {
			const existingIdx = result.findIndex(
				(e) =>
					e.source === "imported" &&
					e.importMeta?.remoteId === comment.importMeta.remoteId,
			);

			if (existingIdx === -1) {
				result.push(comment);
				added++;
			} else {
				const found = result[existingIdx];
				if (found !== undefined && found.status === "imported") {
					result[existingIdx] = {
						...found,
						message: comment.message,
						importMeta: {
							...(found as ImportedComment).importMeta,
							resolvedOnRemote: comment.importMeta.resolvedOnRemote,
						},
					} as ImportedComment;
					updated++;
				}
				// status === "fixed" | "rejected" → leave untouched
			}
		}

		return { merged: result, added, updated };
	}
}
