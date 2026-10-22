import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Repository } from "./repository.js";
import type { Settings } from "./settings.js";

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const helper = (repository: Repository) => path.join(repository.commonDir, "trailmate", "hook.py");

async function exists(file: string): Promise<boolean> {
    try {
        await lstat(file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function hookFile(repository: Repository): Promise<string> {
    const { stdout } = await execute("git", [
        "-C",
        repository.root,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "hooks/prepare-commit-msg",
    ]);
    return stdout.replace(/\n$/, "");
}

function launcher(repository: Repository): string {
    return `#!/bin/sh
# trailmate
exec python3 ${quote(helper(repository))} "$@"
`;
}

export async function hookStatus(repository: Repository, settings: Settings): Promise<string> {
    const file = await hookFile(repository);
    return settings.hooks?.some((hook) => hook.file === file)
        ? "installed"
        : "not installed in this worktree";
}

// The settings lock serializes installation with enablement and model updates.
export async function configureHooks(
    repository: Repository,
    settings: Settings,
    enabled: boolean,
    publish: () => Promise<void>,
): Promise<void> {
    const installed = settings.hooks ?? [];
    if (enabled) {
        await execute("python3", ["--version"]);
        const file = await hookFile(repository);
        const hook = installed.find((hook) => hook.file === file);
        if (!hook && (await exists(file))) {
            throw new Error(`prepare-commit-msg already exists: ${file}`);
        }
        if (!hook) installed.push({ file });

        const contents = await readFile(new URL("./hook.py", import.meta.url));
        settings.enabled = false;
        settings.hooks = installed;
        await publish();
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${helper(repository)}.tmp`, contents, { mode: 0o600 });
        await rename(`${helper(repository)}.tmp`, helper(repository));
        await writeFile(`${file}.tmp`, launcher(repository), { mode: 0o755 });
        await rename(`${file}.tmp`, file);
        settings.enabled = true;
    } else {
        settings.enabled = false;
        await publish();
        for (const { file } of installed) {
            await rm(file, { force: true });
        }
        await rm(helper(repository), { force: true });
        delete settings.hooks;
    }
}
