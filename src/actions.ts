import path from "node:path";
import { discoverRepository, type Repository } from "./repository.js";
import { contains } from "./discovery.js";
import { isRepository, type Workspace } from "./workspace.js";
import { discoverForManagement, type DiscoveryDialogs, type SetupOption } from "./setup.js";
import {
    readDecision,
    readHookStatus,
    readModels,
    readClearAfterCommit,
    toggleClearAfterCommit,
    readChildren,
} from "./settings.js";

export const actions = ["status", "setup", "list", "clear", "toggle-auto-clear"] as const;
export type Action = (typeof actions)[number];
type RepositoryAction = Exclude<Action, "setup" | "clear">;

export async function runWorkspaceAction(
    workspace: Workspace,
    action: RepositoryAction,
    host: DiscoveryDialogs,
): Promise<string | undefined> {
    const insideGit = isRepository(workspace);
    if (insideGit && action === "status") return runAction(workspace, action);
    const discover = (initial?: Awaited<ReturnType<typeof discoverForManagement>>) =>
        discoverForManagement(workspace, host, "Finding Git repositories.", initial);
    const result = await discover();
    if (!result || !host.current()) return;
    const targets = result.candidates.map(({ repository }) => repository);
    const label = (repository: Repository) => path.relative(workspace.root, repository.root) || ".";
    if (action === "status") {
        const lines = [`Directory: ${workspace.root} (not a Git worktree)`];
        if (!targets.length) lines.push("No child Git repositories found.");
        for (const target of targets) {
            if (!host.current()) return;
            try {
                const count = (await readModels(target)).length;
                lines.push(
                    `${label(target)}: ${await readDecision(target)}; hook: ${await readHookStatus(target)}; ${count} pending ${count === 1 ? "model" : "models"}`,
                );
            } catch (error) {
                lines.push(`${label(target)}: ${String(error)}`);
            }
        }
        return [...lines, ...result.skipped.map((item) => `Skipped: ${item}`)].join("\n");
    }
    if (!targets.length) return "No child Git repositories found.";
    let displayed = result;
    const toggle = action === "toggle-auto-clear";
    while (host.current()) {
        const rows: SetupOption[] = [];
        for (const { repository: target, kind } of displayed.candidates) {
            if (!host.current()) return;
            let description: string = kind;
            if (toggle) {
                try {
                    const enabled = await readClearAfterCommit(target);
                    description = enabled ? "enabled → disable" : "disabled → enable";
                } catch {
                    description = "state unavailable";
                }
            }
            rows.push({ title: label(target), value: target.root, description });
        }
        if (!host.current()) return;
        const selected = await host.select(toggle ? "Toggle auto-clear" : "List pending models", [
            ...rows,
            ...(insideGit
                ? [{ title: "Scan for additional child repositories…", value: "scan" }]
                : []),
            { title: "Cancel", value: "cancel" },
        ]);
        if (!host.current() || !selected || selected === "cancel") return;
        if (insideGit && selected === "scan") {
            displayed = (await discover(result)) ?? displayed;
            continue;
        }
        const target = displayed.candidates.find(
            ({ repository }) => repository.root === selected,
        )?.repository;
        if (!target) return;
        const actual = await discoverRepository(target.root);
        if (!host.current()) return;
        if (actual?.root !== target.root || actual.commonDir !== target.commonDir) {
            return `${label(target)}: repository is no longer available.`;
        }
        return runAction(actual, action);
    }
}

export async function runAction(repository: Repository, action: RepositoryAction): Promise<string> {
    if (action === "toggle-auto-clear") {
        const enabled = await toggleClearAfterCommit(repository);
        return `Clear models after commit: ${enabled ? "enabled" : "disabled"} (repository-wide).`;
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
