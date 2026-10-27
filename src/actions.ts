import type { Repository } from "./repository.js";
import {
    clearModels,
    readDecision,
    readHookStatus,
    readModels,
    writeDecision,
} from "./settings.js";

export const actions = ["status", "enable", "disable", "list", "clear"] as const;
export type Action = (typeof actions)[number];

export async function runAction(repository: Repository, action: Action): Promise<string> {
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
        ? `Trailmate: ${await readDecision(repository)}\nRepository: ${repository.root}\nHook: ${await readHookStatus(repository)}\n${models}`
        : models;
}
