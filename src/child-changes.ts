/**
 * Supplements OpenCode snapshot events when they omit edits inside submodules
 * or nested Git repositories. Both server adapters use this module around tool
 * calls, including shell calls. The child paths saved by setup are discovery
 * hints; each child's own setting determines whether attribution is enabled.
 *
 * Compares tracked and non-ignored untracked files before and after a call,
 * reusing content hashes when file metadata is unchanged. A detected change
 * records the calling model in the child's worktree settings for its commit
 * hook. This does not change the Git index or replace OpenCode's own snapshots.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AttributionMessage } from "./collection.js";
import { contains } from "./discovery.js";
import { discoverRepository, type Repository } from "./repository.js";
import { addModel, readChildren, readDecision } from "./settings.js";

const execute = promisify(execFile);

interface ToolCall {
    sessionID: string;
    id: string;
}

interface Host {
    warn(error: unknown): Promise<void>;
}

type Files = Map<string, string>;
type Cache = Map<string, { signature: string; digest: string }>;

interface Sample {
    repository: Repository;
    files: Files;
}

// Compare actual file contents, not `git status`: an already-dirty file can be
// edited again without its status changing. Never modify the user's Git index.
async function snapshot(repository: Repository, cache: Cache, roots: string[]): Promise<Files> {
    const { stdout } = await execute(
        "git",
        ["-C", repository.root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { maxBuffer: 32 * 1024 * 1024 },
    );
    const files: Files = new Map();
    const next: Cache = new Map();
    for (const name of new Set(stdout.split("\0").filter(Boolean))) {
        const file = path.resolve(repository.root, name);
        if (!contains(repository.root, file)) continue;
        if (
            roots.some((root) =>
                root !== repository.root && contains(repository.root, root) && contains(root, file)
            )
        ) continue;
        try {
            const stat = await lstat(file, { bigint: true });
            // Gitlinks and embedded repository directories belong to a separate
            // sample. Do not follow symlinks or walk ignored/cache directories.
            if (!stat.isFile() && !stat.isSymbolicLink()) continue;
            const signature = [
                stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs,
            ].join(":");
            const cached = cache.get(name);
            let digest = cached?.signature === signature ? cached.digest : undefined;
            if (!digest) {
                const hash = createHash("sha256");
                if (stat.isSymbolicLink()) hash.update(await readlink(file));
                else {
                    for await (const chunk of createReadStream(file)) hash.update(chunk);
                }
                digest = `${stat.mode}:${hash.digest("hex")}`;
            }
            files.set(name, digest);
            next.set(name, { signature, digest });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    cache.clear();
    for (const [name, value] of next) cache.set(name, value);
    return files;
}

function changed(before: Files, after: Files): boolean {
    return before.size !== after.size ||
        [...before].some(([name, digest]) => after.get(name) !== digest);
}

export function createChildChanges(repository: Repository, host: Host) {
    const caches = new Map<string, Cache>();
    const pending = new Map<string, { model: string; roots: string[]; samples: Sample[] }>();
    const key = (call: ToolCall) => `${call.sessionID}/${call.id}`;

    return {
        async before(
            call: ToolCall,
            message: () => Promise<AttributionMessage | undefined>,
        ): Promise<void> {
            try {
                const hints = [...new Set(await readChildren(repository))].filter(
                    (root) => root !== repository.root && contains(repository.root, root),
                );
                if (!hints.length) return;
                const info = await message();
                if (info?.role !== "assistant" || info.summary) return;
                const source = await discoverRepository(info.path.cwd);
                if (!source || !contains(repository.root, source.root)) return;
                const children = new Map<string, Repository>();
                for (const root of hints) {
                    try {
                        const child = await discoverRepository(root);
                        if (child?.root === root) children.set(root, child);
                    } catch (error) {
                        await host.warn(error);
                    }
                }
                const roots = [...children.keys()];
                const samples: Sample[] = [];
                for (const [root, child] of children) {
                    try {
                        if ((await readDecision(child)) !== "enabled") continue;
                        const cache = caches.get(root) ?? new Map();
                        caches.set(root, cache);
                        samples.push({ repository: child, files: await snapshot(child, cache, roots) });
                    } catch (error) {
                        await host.warn(error);
                    }
                }
                if (samples.length) {
                    pending.set(key(call), { model: `${info.providerID}/${info.modelID}`, roots, samples });
                    if (pending.size > 1024) {
                        pending.delete(pending.keys().next().value!);
                        await host.warn("Child attribution evicted an unfinished tool call");
                    }
                }
                for (const root of caches.keys()) if (!roots.includes(root)) caches.delete(root);
            } catch (error) {
                await host.warn(error);
            }
        },
        async after(call: ToolCall): Promise<void> {
            const entry = pending.get(key(call));
            pending.delete(key(call));
            if (!entry) return;
            for (const sample of entry.samples) {
                try {
                    const child = await discoverRepository(sample.repository.root);
                    if (
                        child?.commonDir !== sample.repository.commonDir ||
                        child.root !== sample.repository.root
                    ) continue;
                    if ((await readDecision(child)) !== "enabled") continue;
                    const files = await snapshot(child, caches.get(child.root) ?? new Map(), entry.roots);
                    if (changed(sample.files, files)) await addModel(child, entry.model);
                } catch (error) {
                    await host.warn(error);
                }
            }
        },
        clear(): void {
            pending.clear();
            caches.clear();
        },
    };
}
