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
