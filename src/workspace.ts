/** A Trailmate location is either a Git worktree or a directory containing worktrees. */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { contains, type DiscoveryResult } from "./discovery.js";
import { discoverRepository, type Repository } from "./repository.js";
import { readChildren } from "./settings.js";

export type Workspace = Repository | { root: string; commonDir?: undefined };

export function isRepository(workspace: Workspace): workspace is Repository {
    return workspace.commonDir !== undefined;
}

export async function discoverWorkspace(directory: string): Promise<Workspace> {
    return (await discoverRepository(directory)) ?? { root: await realpath(directory) };
}

// Revalidate each cached worktree without scanning. A stale path can resolve
// to an enclosing repo; only an exact, contained root qualifies as a child.
export async function addKnownChildren(
    workspace: Repository,
    result: DiscoveryResult,
    current: () => boolean,
): Promise<void> {
    const seen = new Set(result.candidates.map(({ repository }) => repository.root));
    for (const root of new Set(await readChildren(workspace))) {
        if (!current()) return;
        if (root === workspace.root || seen.has(root) || !contains(workspace.root, root)) continue;
        try {
            const child = await discoverRepository(root);
            if (child?.root === root) {
                result.candidates.push({ repository: child, kind: "nested repository" });
            } else {
                result.skipped.push(`${path.relative(workspace.root, root)}: unavailable`);
            }
        } catch (error) {
            result.skipped.push(`${path.relative(workspace.root, root)}: ${String(error)}`);
        }
    }
}
