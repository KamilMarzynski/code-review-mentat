import { describe, expect, test } from "bun:test";
import type {
	GitProvider,
	PullRequest,
	RemoteComment,
} from "../src/git-providers/types";
import { CommentImporter } from "../src/review/comment-importer";
import type { AnyStoredComment, ImportedComment } from "../src/review/types";

// ── Test doubles ──────────────────────────────────────────────────────────────

function makeCache(existing: AnyStoredComment[] = []) {
	const store: AnyStoredComment[] = [...existing];
	let savedImportedAt: string | undefined;

	return {
		async getComments(_prKey: string): Promise<AnyStoredComment[]> {
			return store;
		},
		async saveComments(
			_prKey: string,
			comments: AnyStoredComment[],
		): Promise<void> {
			store.length = 0;
			store.push(...comments);
		},
		setImportedAt(
			_input: { sourceBranch: string; targetBranch: string },
			timestamp: string,
		): void {
			savedImportedAt = timestamp;
		},
		// Inspection helpers
		get comments() {
			return store;
		},
		get importedAt() {
			return savedImportedAt;
		},
	};
}

function makeProvider(
	comments: RemoteComment[],
): Pick<GitProvider, "name" | "fetchPullRequestComments"> {
	return {
		name: "TestProvider",
		fetchPullRequestComments: async () => comments,
	};
}

const testPR: PullRequest = {
	id: 1,
	title: "Test PR",
	description: "",
	source: { name: "feat/foo", commitHash: "abc123" },
	target: { name: "main", commitHash: "def456" },
};

const testRemoteComment: RemoteComment = {
	id: "rc-1",
	author: "reviewer",
	content: "Fix this.",
	filePath: "src/main.ts",
	line: 42,
	url: "https://github.com/org/repo/pull/1#discussion-123",
	resolved: false,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CommentImporter", () => {
	test("reports fetched/added counts on fresh import", async () => {
		const cache = makeCache();
		const provider = makeProvider([testRemoteComment]);
		const importer = new CommentImporter(cache as never);

		const result = await importer.importForPR(provider as never, testPR);

		expect(result.fetched).toBe(1);
		expect(result.added).toBe(1);
		expect(result.updated).toBe(0);
	});

	test("normalises remote comment to ImportedComment shape", async () => {
		const cache = makeCache();
		const provider = makeProvider([testRemoteComment]);
		const importer = new CommentImporter(cache as never);

		await importer.importForPR(provider as never, testPR);

		const saved = cache.comments[0] as ImportedComment;
		expect(saved.source).toBe("imported");
		expect(saved.status).toBe("imported");
		expect(saved.file).toBe("src/main.ts");
		expect(saved.line).toBe(42);
		expect(saved.message).toBe("Fix this.");
		expect(saved.importMeta.remoteId).toBe("rc-1");
		expect(saved.importMeta.remoteAuthor).toBe("reviewer");
		expect(saved.importMeta.resolvedOnRemote).toBe(false);
		expect(saved.id).toBeTruthy(); // UUID assigned
	});

	test("records importedAt timestamp on cache", async () => {
		const cache = makeCache();
		const provider = makeProvider([testRemoteComment]);
		const importer = new CommentImporter(cache as never);

		await importer.importForPR(provider as never, testPR);

		expect(cache.importedAt).toBeTruthy();
		const importedAt = cache.importedAt;
		expect(() => new Date(importedAt ?? "")).not.toThrow();
	});

	test("re-import leaves fixed imported comments untouched", async () => {
		const existing: AnyStoredComment[] = [
			{
				id: "local-1",
				file: "src/main.ts",
				line: 42,
				message: "Fix this.",
				status: "fixed",
				source: "imported",
				importMeta: {
					remoteId: "rc-1",
					remoteAuthor: "reviewer",
					remoteUrl: "https://github.com/org/repo/pull/1#discussion-123",
					importedAt: new Date().toISOString(),
					resolvedOnRemote: false,
				},
			} as ImportedComment,
		];

		const cache = makeCache(existing);
		const provider = makeProvider([testRemoteComment]);
		const importer = new CommentImporter(cache as never);

		const result = await importer.importForPR(provider as never, testPR);

		expect(result.added).toBe(0);
		expect(result.updated).toBe(0);
		expect(cache.comments[0]?.status).toBe("fixed");
		expect(cache.comments).toHaveLength(1);
	});

	test("re-import updates content of still-open imported comments", async () => {
		const existing: AnyStoredComment[] = [
			{
				id: "local-1",
				file: "src/main.ts",
				line: 42,
				message: "Old content.",
				status: "imported",
				source: "imported",
				importMeta: {
					remoteId: "rc-1",
					remoteAuthor: "reviewer",
					remoteUrl: "https://github.com/org/repo/pull/1#discussion-123",
					importedAt: new Date().toISOString(),
					resolvedOnRemote: false,
				},
			} as ImportedComment,
		];

		const cache = makeCache(existing);
		const updatedRemote: RemoteComment = {
			...testRemoteComment,
			content: "Updated content.",
			resolved: true,
		};
		const provider = makeProvider([updatedRemote]);
		const importer = new CommentImporter(cache as never);

		const result = await importer.importForPR(provider as never, testPR);

		expect(result.added).toBe(0);
		expect(result.updated).toBe(1);
		expect(cache.comments[0]?.message).toBe("Updated content.");
		expect(
			(cache.comments[0] as ImportedComment).importMeta.resolvedOnRemote,
		).toBe(true);
		// ID preserved
		expect(cache.comments[0]?.id).toBe("local-1");
	});

	test("file defaults to empty string when filePath absent", async () => {
		const generalComment: RemoteComment = {
			id: "rc-2",
			author: "reviewer",
			content: "General PR comment.",
			url: "https://github.com/org/repo/pull/1#issuecomment-456",
			resolved: false,
		};

		const cache = makeCache();
		const provider = makeProvider([generalComment]);
		const importer = new CommentImporter(cache as never);

		await importer.importForPR(provider as never, testPR);

		expect(cache.comments[0]?.file).toBe("");
	});
});
