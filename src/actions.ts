import path from "node:path";
import { discoverRepository, type Repository } from "./repository.js";
import { contains } from "./discovery.js";
import {
    clearModels,
    readDecision,
    readHookStatus,
    readModels,
    readClearAfterCommit,
    toggleClearAfterCommit,
    readChildren,
} from "./settings.js";

export const actions = [
    "status",
    "setup",
    "list",
    "clear",
    "toggle-auto-clear",
] as const;
export type Action = (typeof actions)[number];

export async function runAction(
    repository: Repository,
    action: Exclude<Action, "setup">,
): Promise<string> {
    if (action === "toggle-auto-clear") {
        const enabled = await toggleClearAfterCommit(repository);
        return `Clear models after commit: ${enabled ? "enabled" : "disabled"} (repository-wide).`;
    }
    if (action === "clear") {
        await clearModels(repository);
        return "Model attribution cleared.";
    }
    const models = (await readModels(repository)).join("\n") || "(no models)";
    const children: string[] = [];
    if (action === "status") {
        for (const root of await readChildren(repository)) {
            if (!contains(repository.root, root) || root === repository.root) continue;
            const label = path.relative(repository.root, root);
            try {
                const child = await discoverRepository(root);
                children.push(
                    child?.root === root
                        ? `${label}: ${await readDecision(child)}; hook: ${await readHookStatus(child)}`
                        : `${label}: unavailable`,
                );
            } catch (error) {
                children.push(`${label}: ${String(error)}`);
            }
        }
    }
    if (action !== "status") return models;

    const autoClear = (await readClearAfterCommit(repository)) ? "enabled" : "disabled";
    const lines = [
        `Trailmate: ${await readDecision(repository)}`,
        `Repository: ${repository.root}`,
        `Hook: ${await readHookStatus(repository)}`,
        `Clear models after commit: ${autoClear} (repository-wide)`,
        models,
    ];
    if (children.length) {
        lines.push("Known child repositories (last setup):", ...children);
    }
    return lines.join("\n");
}
