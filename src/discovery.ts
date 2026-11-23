/**
 * Finds Git worktrees for the Trailmate setup menu. Normal discovery follows
 * gitlinks in each worktree's Git index and includes only initialized submodules.
 * The optional filesystem scan looks for additional `.git` files and directories,
 * skipping Git metadata, directory symlinks, and known Cargo Git caches.
 *
 * Both searches validate candidates with Git and report progress and skipped
 * paths to setup.ts. Discovery is read-only: it never initializes submodules,
 * installs hooks, or changes Trailmate preferences.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { discoverRepository, type Repository } from "./repository.js";

export interface Candidate {
    repository: Repository;
    kind: "current" | "submodule" | "nested repository";
}

export interface DiscoveryHost {
    current(): boolean;
    progress(directory: string, found: number): void;
}

export interface DiscoveryResult {
    candidates: Candidate[];
    skipped: string[];
}

export function contains(root: string, directory: string): boolean {
    const relative = path.relative(root, directory);
    return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
}

// Developer-maintained discovery exclusions for typical Git cache locations.
const excludedLayouts = [/(^|\/)\.cargo\/git(\/|$)/];

function excluded(directory: string): boolean {
    const normalized = directory.split(path.sep).join("/");
    const cargoGit = path.resolve(
        process.env.CARGO_HOME ?? path.join(homedir(), ".cargo"),
        "git",
    );
    return contains(cargoGit, directory) || excludedLayouts.some((pattern) => pattern.test(normalized));
}

async function candidate(root: string, directory: string): Promise<Repository | undefined> {
    // An uninitialized submodule must not resolve back to its superproject.
    const marker = await lstat(path.join(directory, ".git")).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        },
    );
    if (!marker || (!marker.isDirectory() && !marker.isFile())) return;
    const canonical = await realpath(directory);
    if (!contains(root, canonical)) return;
    const repository = await discoverRepository(directory);
    return repository?.root === canonical ? repository : undefined;
}

async function readGitlinks(root: string, host: DiscoveryHost): Promise<Map<string, boolean>> {
    const git = spawn("git", ["-C", root, "ls-files", "--stage", "-z"], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    git.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });

    const links = new Map<string, boolean>();
    const read = async () => {
        // Stream the index so a large number of ordinary files cannot overflow
        // an output buffer. NUL delimiters preserve tabs and newlines in paths.
        let remainder = "";
        for await (const chunk of git.stdout.setEncoding("utf8")) {
            if (!host.current()) {
                git.kill();
                break;
            }
            const records = (remainder + chunk).split("\0");
            remainder = records.pop()!;
            for (const record of records) {
                if (!record.startsWith("160000 ")) continue;
                const tab = record.indexOf("\t");
                if (tab < 0) continue;
                const name = record.slice(tab + 1);
                // Stage zero is resolved; stages 1–3 are merge conflict entries.
                const conflicted = record[tab - 1] !== "0";
                links.set(name, conflicted || links.get(name) === true);
            }
        }
    };
    const [[code, signal]] = await Promise.all([once(git, "close"), read()]);
    if (!host.current()) return new Map();
    if (code !== 0) throw new Error(stderr.trim() || `git ls-files exited with ${signal ?? code}`);
    return links;
}

export async function discoverSubmodules(
    repository: Repository,
    host: DiscoveryHost,
): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
        candidates: [{ repository, kind: "current" }],
        skipped: [],
    };
    const seen = new Set([repository.root]);
    for (let index = 0; index < result.candidates.length && host.current(); index++) {
        const parent = result.candidates[index].repository;
        try {
            for (const [name, conflicted] of await readGitlinks(parent.root, host)) {
                if (!host.current()) break;
                const directory = path.resolve(parent.root, name);
                if (!contains(parent.root, directory) || directory === parent.root) continue;
                if (conflicted) {
                    result.skipped.push(`${directory} (conflicted gitlink)`);
                    continue;
                }
                try {
                    const child = await candidate(parent.root, directory);
                    if (child?.root !== directory) {
                        result.skipped.push(`${directory} (not initialized)`);
                        continue;
                    }
                    if (seen.has(child.root)) continue;
                    seen.add(child.root);
                    result.candidates.push({ repository: child, kind: "submodule" });
                    host.progress(directory, result.candidates.length);
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    result.skipped.push(
                        code === "ENOENT" || code === "ENOTDIR"
                            ? `${directory} (not initialized)`
                            : `${directory}: ${String(error)}`,
                    );
                }
            }
        } catch (error) {
            result.skipped.push(`${parent.root}: ${String(error)}`);
        }
    }
    return result;
}

export async function scanRepositories(
    repository: Repository,
    initial: DiscoveryResult,
    host: DiscoveryHost,
): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
        candidates: [...initial.candidates],
        skipped: [...initial.skipped],
    };
    const seen = new Set(result.candidates.map(({ repository }) => repository.root));
    const pending = [repository.root];
    // Serial traversal bounds filesystem/Git activity even in very large trees.
    while (pending.length && host.current()) {
        const directory = pending.pop()!;
        host.progress(directory, result.candidates.length);
        try {
            const entries = await readdir(directory, { withFileTypes: true });
            if (entries.some((entry) => entry.name === ".git") && !seen.has(directory)) {
                const child = await candidate(repository.root, directory);
                if (child && !seen.has(child.root)) {
                    seen.add(child.root);
                    result.candidates.push({ repository: child, kind: "nested repository" });
                }
            }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
                const child = path.join(directory, entry.name);
                if (excluded(child)) result.skipped.push(`${child} (cache exclusion)`);
                else pending.push(child);
            }
        } catch (error) {
            result.skipped.push(`${directory}: ${String(error)}`);
        }
    }
    return result;
}
