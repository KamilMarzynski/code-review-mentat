import { beforeEach, describe, expect, it, mock } from "bun:test";
import GitHubProvider from "../github";
import type { PullRequest } from "../types";

function mockResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	const statusTexts: Record<number, string> = {
		200: "OK",
		401: "Unauthorized",
		403: "Forbidden",
		404: "Not Found",
		429: "Too Many Requests",
		422: "Unprocessable Entity",
	};
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: statusTexts[status] ?? "Error",
		headers: new Headers(headers),
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	} as unknown as Response;
}

const originalFetch = global.fetch;

beforeEach(() => {
	global.fetch = originalFetch;
	process.env.GITHUB_TOKEN = "test-token";
});

describe("GitHubProvider.parseRemote", () => {
	it("parses a standard GitHub SSH remote", () => {
		const result = GitHubProvider.parseRemote(
			"git@github.com:acme-org/my-repo.git",
		);
		expect(result).toEqual({
			host: "github.com",
			projectKey: "acme-org",
			repoSlug: "my-repo",
		});
	});

	it("parses a remote without .git suffix", () => {
		const result = GitHubProvider.parseRemote(
			"git@github.com:acme-org/my-repo",
		);
		expect(result).toEqual({
			host: "github.com",
			projectKey: "acme-org",
			repoSlug: "my-repo",
		});
	});

	it("returns undefined for a Bitbucket SSH remote", () => {
		const result = GitHubProvider.parseRemote(
			"ssh://git@bitbucket.example.com:7999/PROJ/repo.git",
		);
		expect(result).toBeUndefined();
	});

	it("returns undefined for an HTTPS GitHub remote", () => {
		const result = GitHubProvider.parseRemote(
			"https://github.com/acme-org/my-repo.git",
		);
		expect(result).toBeUndefined();
	});

	it("returns undefined for an empty string", () => {
		expect(GitHubProvider.parseRemote("")).toBeUndefined();
	});

	it("constructor throws for a non-GitHub remote", () => {
		expect(
			() =>
				new GitHubProvider(
					"ssh://git@bitbucket.example.com:7999/PROJ/repo.git",
				),
		).toThrow("Invalid GitHub SSH remote");
	});
});

describe("GitHubProvider.fetchPullRequests", () => {
	const provider = new GitHubProvider("git@github.com:acme-org/my-repo.git");

	it("returns mapped PullRequest array on success", async () => {
		global.fetch = mock(() =>
			Promise.resolve(
				mockResponse(200, [
					{
						number: 42,
						title: "Add feature X",
						body: "This PR adds feature X",
						head: { ref: "feature/x", sha: "abc123" },
						base: { ref: "main", sha: "def456" },
					},
				]),
			),
		) as typeof fetch;

		const prs = await provider.fetchPullRequests();

		expect(prs).toHaveLength(1);
		expect(prs[0]).toEqual({
			id: 42,
			title: "Add feature X",
			description: "This PR adds feature X",
			source: { name: "feature/x", commitHash: "abc123" },
			target: { name: "main", commitHash: "def456" },
		});
	});

	it("maps null body to empty string", async () => {
		global.fetch = mock(() =>
			Promise.resolve(
				mockResponse(200, [
					{
						number: 1,
						title: "Empty body PR",
						body: null,
						head: { ref: "feature/y", sha: "aaa" },
						base: { ref: "main", sha: "bbb" },
					},
				]),
			),
		) as typeof fetch;

		const prs = await provider.fetchPullRequests();
		expect(prs[0]?.description).toBe("");
	});

	it("throws on 401 with descriptive message", async () => {
		global.fetch = mock(() =>
			Promise.resolve(mockResponse(401, { message: "Bad credentials" })),
		) as typeof fetch;

		await expect(provider.fetchPullRequests()).rejects.toThrow(
			"GitHub authentication failed: GITHUB_TOKEN may be invalid",
		);
	});

	it("throws on 403 rate limit with reset time", async () => {
		const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
		global.fetch = mock(() =>
			Promise.resolve(
				mockResponse(
					403,
					{ message: "rate limit exceeded" },
					{
						"x-ratelimit-remaining": "0",
						"x-ratelimit-reset": String(resetEpoch),
					},
				),
			),
		) as typeof fetch;

		await expect(provider.fetchPullRequests()).rejects.toThrow(
			"GitHub rate limit exceeded. Resets at",
		);
	});

	it("throws on 429 rate limit", async () => {
		global.fetch = mock(() =>
			Promise.resolve(mockResponse(429, { message: "rate limit exceeded" })),
		) as typeof fetch;

		await expect(provider.fetchPullRequests()).rejects.toThrow(
			"GitHub rate limit exceeded. Resets at",
		);
	});

	it("throws when GITHUB_TOKEN is not set", async () => {
		delete process.env.GITHUB_TOKEN;

		await expect(provider.fetchPullRequests()).rejects.toThrow(
			"GITHUB_TOKEN is not set",
		);
	});

	it("calls the correct GitHub API URL", async () => {
		let capturedUrl = "";
		global.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(mockResponse(200, []));
		}) as typeof fetch;

		await provider.fetchPullRequests();

		expect(capturedUrl).toBe(
			"https://api.github.com/repos/acme-org/my-repo/pulls?state=open&per_page=100",
		);
	});
});

describe("GitHubProvider.fetchCommits", () => {
	const provider = new GitHubProvider("git@github.com:acme-org/my-repo.git");
	const pr: PullRequest = {
		id: 42,
		title: "PR title",
		description: "",
		source: { name: "feature/x", commitHash: "abc" },
		target: { name: "main", commitHash: "def" },
	};

	it("returns commit messages on success", async () => {
		global.fetch = mock(() =>
			Promise.resolve(
				mockResponse(200, [
					{ commit: { message: "feat: add login" } },
					{ commit: { message: "fix: typo in login" } },
				]),
			),
		) as typeof fetch;

		const messages = await provider.fetchCommits(pr);

		expect(messages).toEqual(["feat: add login", "fix: typo in login"]);
	});

	it("calls the correct GitHub API URL", async () => {
		let capturedUrl = "";
		global.fetch = mock((url: string) => {
			capturedUrl = url;
			return Promise.resolve(mockResponse(200, []));
		}) as typeof fetch;

		await provider.fetchCommits(pr);

		expect(capturedUrl).toBe(
			"https://api.github.com/repos/acme-org/my-repo/pulls/42/commits?per_page=100",
		);
	});

	it("throws on 401 with descriptive message", async () => {
		global.fetch = mock(() =>
			Promise.resolve(mockResponse(401, { message: "Bad credentials" })),
		) as typeof fetch;

		await expect(provider.fetchCommits(pr)).rejects.toThrow(
			"GitHub authentication failed: GITHUB_TOKEN may be invalid",
		);
	});

	it("throws a descriptive error on non-ok response", async () => {
		global.fetch = mock(() =>
			Promise.resolve(mockResponse(404, { message: "Not Found" })),
		) as typeof fetch;

		await expect(provider.fetchCommits(pr)).rejects.toThrow(
			"Failed to fetch commits: 404 Not Found",
		);
	});

	it("throws when GITHUB_TOKEN is not set", async () => {
		delete process.env.GITHUB_TOKEN;

		await expect(provider.fetchCommits(pr)).rejects.toThrow(
			"GITHUB_TOKEN is not set",
		);
	});
});
