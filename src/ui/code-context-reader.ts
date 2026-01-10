import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Handles reading code context from files and git
 */
export class CodeContextReader {
	/**
	 * Read file content and extract specific lines with context
	 */
	async readFileLines(
		filePath: string,
		targetLine: number,
		contextBefore = 2,
		contextAfter = 2,
	): Promise<{
		lines: Array<{ lineNum: number; content: string; isTarget: boolean }>;
		success: boolean;
	}> {
		try {
			const fileContent = await readFile(filePath, "utf-8");
			const lines = fileContent.split("\n");

			const displayStart = Math.max(0, targetLine - 1 - contextBefore);
			const displayEnd = Math.min(lines.length, targetLine + contextAfter);

			const result = [];
			for (let i = displayStart; i < displayEnd; i++) {
				// Defensive: ensure we don't access undefined array elements
				const lineContent = lines[i] ?? "";
				result.push({
					lineNum: i + 1,
					content: lineContent,
					isTarget: i + 1 === targetLine,
				});
			}

			return { lines: result, success: true };
		} catch (_error) {
			return { lines: [], success: false };
		}
	}

	/**
	 * Read file content for a range of lines with context
	 */
	async readFileRange(
		filePath: string,
		startLine: number,
		endLine: number,
		contextBefore = 2,
		contextAfter = 2,
	): Promise<{
		lines: Array<{ lineNum: number; content: string; isTarget: boolean }>;
		success: boolean;
	}> {
		try {
			const fileContent = await readFile(filePath, "utf-8");
			const lines = fileContent.split("\n");

			const displayStart = Math.max(0, startLine - 1 - contextBefore);
			const displayEnd = Math.min(lines.length, endLine + contextAfter);

			const result = [];
			for (let i = displayStart; i < displayEnd; i++) {
				const lineNum = i + 1;
				// Defensive: ensure we don't access undefined array elements
				const lineContent = lines[i] ?? "";
				result.push({
					lineNum,
					content: lineContent,
					isTarget: lineNum >= startLine && lineNum <= endLine,
				});
			}

			return { lines: result, success: true };
		} catch (_error) {
			return { lines: [], success: false };
		}
	}

	/**
	 * Get full diff from git
	 */
	async getFullDiff(base = "HEAD~1"): Promise<string> {
		try {
			const execAsync = promisify(exec);
			const { stdout } = await execAsync(`git diff ${base}`);
			return stdout;
		} catch (_error) {
			return "";
		}
	}
}
