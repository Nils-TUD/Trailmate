import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Repository } from "./repository.js";
import type { Settings } from "./settings.js";

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const helper = (repository: Repository) => path.join(repository.commonDir, "trailmate", "hook.py");
const header = "#!/bin/sh\n# trailmate hook chain\n";
const original = (file: string) => `${file}.trailmate-original`;
const isPostCommit = (file: string) => path.basename(file) === "post-commit";
const previousHook = (file: string) =>
    isPostCommit(file)
        ? `trailmate_status=0\ntrap 'exit "$trailmate_status"' 0\n[ ! -x ${quote(original(file))} ] || ${quote(original(file))} "$@" || trailmate_status=$?\n`
        : `[ ! -x ${quote(original(file))} ] || ${quote(original(file))} "$@" || exit $?\n`;
const contribution = (repository: Repository, file: string) =>
    `python3 ${quote(helper(repository))}${isPostCommit(file) ? " --post-commit" : ""} "$@" || exit $?\n`;

async function exists(file: string): Promise<boolean> {
    try {
        await lstat(file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function hookFile(repository: Repository, name = "prepare-commit-msg"): Promise<string> {
    const { stdout } = await execute("git", [
        "-C",
        repository.root,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        `hooks/${name}`,
    ]);
    return stdout.replace(/\n$/, "");
}

async function currentHook(file: string): Promise<string> {
    return (await exists(file)) ? readFile(file, "utf8") : "";
}

async function writeHook(file: string, contents: string): Promise<void> {
    await writeFile(`${file}.tmp`, contents, { mode: 0o755 });
    await rename(`${file}.tmp`, file);
}

export async function hookStatus(repository: Repository, settings: Settings): Promise<string> {
    const files = await Promise.all(
        ["prepare-commit-msg", "post-commit"].map((name) => hookFile(repository, name)),
    );
    return files.every((file) => settings.hooks?.some((hook) => hook.file === file))
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
        const files = new Set(
            await Promise.all(
                ["prepare-commit-msg", "post-commit"].map((name) => hookFile(repository, name)),
            ),
        );
        // Upgrade already-enabled worktrees as well when the repository-wide
        // option is toggled from a different worktree. Skip removed worktrees.
        for (const { file } of installed) {
            if (path.basename(file) === "prepare-commit-msg" && (await exists(file))) {
                files.add(path.join(path.dirname(file), "post-commit"));
            }
        }
        const contents = await readFile(new URL("./hook.py", import.meta.url));
        settings.enabled = false;
        settings.hooks = installed;
        await publish();
        await writeFile(`${helper(repository)}.tmp`, contents, { mode: 0o600 });
        await rename(`${helper(repository)}.tmp`, helper(repository));
        for (const file of files) {
            const hook = installed.find((hook) => hook.file === file);
            let launcher = await currentHook(file);
            // Upgrade the original standalone launcher without treating it as a user hook.
            if (launcher.startsWith("#!/bin/sh\n# trailmate\nexec python3 ")) {
                launcher =
                    header +
                    launcher.slice("#!/bin/sh\n# trailmate\nexec ".length).trimEnd() +
                    " || exit $?\n";
            }
            const managed = launcher.startsWith(header);
            if (!managed && launcher && (await exists(original(file)))) {
                throw new Error(
                    `Cannot preserve existing hook: backup already exists: ${original(file)}`,
                );
            }
            if (!managed) launcher = header;
            if (!launcher.includes(contribution(repository, file)))
                launcher += contribution(repository, file);
            if (!hook) installed.push({ file });

            await publish();
            await mkdir(path.dirname(file), { recursive: true });
            if (!managed && (await exists(file))) {
                // Keep the original interpreter, permissions and contents intact, including
                // hooks which use exec or exit. Never overwrite an existing backup.
                if (!(await exists(original(file)))) await rename(file, original(file));
            }
            if ((await exists(original(file))) && !launcher.includes(previousHook(file))) {
                launcher = header + previousHook(file) + launcher.slice(header.length);
            }
            await writeHook(file, launcher);
        }
        settings.enabled = true;
    } else {
        settings.enabled = false;
        await publish();
        for (const { file } of installed) {
            const launcher = await currentHook(file);
            if (launcher.startsWith(header)) {
                const remaining = launcher.replace(contribution(repository, file), "");
                const base = header + ((await exists(original(file))) ? previousHook(file) : "");
                if (remaining !== base) {
                    await writeHook(file, remaining);
                    continue;
                }
                if (await exists(original(file))) {
                    await rename(original(file), file);
                    continue;
                }
                await rm(file, { force: true });
            } else if (
                launcher ===
                `#!/bin/sh\n# trailmate\nexec python3 ${quote(helper(repository))} "$@"\n`
            ) {
                await rm(file, { force: true });
            } else if (!launcher && (await exists(original(file)))) {
                await rename(original(file), file);
            }
        }
        await rm(helper(repository), { force: true });
        delete settings.hooks;
    }
}
