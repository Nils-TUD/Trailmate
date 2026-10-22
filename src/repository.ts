import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface Repository {
    root: string;
    // Shared metadata; all plugin state lives here, with models keyed by root.
    commonDir: string;
}

export async function discoverRepository(directory: string): Promise<Repository | undefined> {
    const git = async (...args: string[]) => {
        const { stdout } = await execute("git", ["-C", directory, "rev-parse", ...args]);

        // Remove Git's line ending without trimming whitespace from the path.
        return stdout.replace(/\r?\n$/, "");
    };

    try {
        if ((await git("--is-inside-work-tree")) !== "true") return undefined;

        // Ask Git instead of assuming .git is a directory inside the worktree.
        const [root, commonDir] = await Promise.all([
            git("--show-toplevel"),
            git("--path-format=absolute", "--git-common-dir"),
        ]);

        // Canonical paths keep symlink aliases from creating separate identities.
        return {
            root: await realpath(root),
            commonDir: await realpath(commonDir),
        };
    } catch (error) {
        // rev-parse exits 128 for non-repositories; missing Git and other failures
        // are operational errors, not a repository opting out.
        if ((error as { code?: unknown }).code === 128) return undefined;

        throw error;
    }
}
