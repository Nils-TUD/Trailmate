import type { Repository } from "./repository.js";
import {
    clearModels,
    readDecision,
    readHookStatus,
    readModels,
    readClearAfterCommit,
    toggleClearAfterCommit,
    writeDecision,
} from "./settings.js";

export const actions = [
    "status",
    "enable",
    "disable",
    "list",
    "clear",
    "toggle-auto-clear",
] as const;
export type Action = (typeof actions)[number];

export async function runAction(repository: Repository, action: Action): Promise<string> {
    if (action === "toggle-auto-clear") {
        const enabled = await toggleClearAfterCommit(repository);
        return `Clear models after commit: ${enabled ? "enabled" : "disabled"} (repository-wide).`;
    }
    if (action === "enable" || action === "disable") {
        await writeDecision(repository, action === "enable");
        return `Trailmate: ${action === "enable" ? "enabled" : "disabled"}`;
    }
    if (action === "clear") {
        await clearModels(repository);
        return "Model attribution cleared.";
    }
    const models = (await readModels(repository)).join("\n") || "(no models)";
    return action === "status"
        ? `Trailmate: ${await readDecision(repository)}\nRepository: ${repository.root}\nHook: ${await readHookStatus(repository)}\nClear models after commit: ${(await readClearAfterCommit(repository)) ? "enabled" : "disabled"} (repository-wide)\n${models}`
        : models;
}
