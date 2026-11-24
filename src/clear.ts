/** Shared clear submenu for both TUIs. Only pending worktree attribution is changed. */
import path from "node:path";
import type { DiscoveryResult } from "./discovery.js";
import { discoverRepository, type Repository } from "./repository.js";
import { clearModels, readModels } from "./settings.js";
import { discoverForManagement, type DiscoveryDialogs, type SetupOption } from "./setup.js";
import { isRepository, type Workspace } from "./workspace.js";

type ClearHost = DiscoveryDialogs & {
    notify(message: string, error?: boolean): void;
};

export async function clearRepositories(
    repository: Workspace,
    host: ClearHost,
): Promise<"back" | "done"> {
    const discover = (initial?: DiscoveryResult) =>
        discoverForManagement(repository, host, "No attribution will be cleared.", initial);

    const label = (target: Repository) => path.relative(repository.root, target.root) || ".";
    const clear = async (target: Repository) => {
        const actual = await discoverRepository(target.root);
        if (actual?.root !== target.root || actual.commonDir !== target.commonDir) {
            throw new Error(`${label(target)}: repository is no longer available`);
        }
        if (host.current()) await clearModels(actual);
    };

    const initial = await discover();
    if (!initial) return host.current() ? "back" : "done";
    let result = initial;
    while (host.current()) {
        const rows: SetupOption[] = [];
        for (const { repository: target } of result.candidates) {
            if (!host.current()) return "done";
            let detail: string;
            try {
                const count = (await readModels(target)).length;
                detail = `${count} pending ${count === 1 ? "model" : "models"}`;
            } catch {
                detail = "pending models unavailable";
            }
            rows.push({
                title: label(target),
                value: target.root,
                description: detail,
            });
        }
        if (!host.current()) return "done";
        const action = await host.select(
            rows.length ? "Clear pending attribution" : "No known repositories to clear",
            [
                ...rows,
                ...(rows.length
                    ? [
                          {
                              title: "Clear all listed repositories…",
                              value: "all",
                              description: `${rows.length} listed worktrees; does not scan for more repositories.`,
                          },
                      ]
                    : []),
                { title: "Scan for additional child repositories…", value: "scan" },
                { title: "Cancel", value: "cancel" },
            ],
        );
        if (!host.current()) return "done";
        if (!action || action === "cancel") return "back";
        if (action === "scan") {
            result = (await discover(isRepository(repository) ? initial : undefined)) ?? result;
            continue;
        }
        if (action === "all") {
            const choice = await host.select(
                `Clear attribution in all ${rows.length} listed worktrees?`,
                [
                    { title: "Cancel", value: "cancel" },
                    {
                        title: "Clear all",
                        value: "confirm",
                        description: "Only worktrees shown in the clear menu.",
                    },
                ],
            );
            if (!host.current()) return "done";
            if (choice !== "confirm") continue;
            const failures: string[] = [];
            for (const { repository: target } of result.candidates) {
                if (!host.current()) return "done";
                try {
                    await clear(target);
                } catch (error) {
                    failures.push(`${label(target)}: ${String(error)}`);
                }
            }
            if (host.current()) {
                const cleared = rows.length - failures.length;
                host.notify(
                    `Cleared attribution in ${cleared} of ${rows.length} listed worktrees.` +
                        (failures.length ? `\nFailed: ${failures.join("\n")}` : ""),
                    failures.length > 0,
                );
            }
            return "done";
        }

        const target = result.candidates.find(({ repository }) => repository.root === action);
        if (!target) continue;
        try {
            await clear(target.repository);
            if (host.current()) host.notify(`Cleared attribution in ${label(target.repository)}.`);
        } catch (error) {
            if (host.current()) host.notify(String(error), true);
        }
    }
    return "done";
}
