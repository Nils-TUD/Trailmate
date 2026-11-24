/** Shared clear submenu for both TUIs. Only pending worktree attribution is changed. */
import path from "node:path";
import { contains, discoverSubmodules, scanRepositories, type DiscoveryResult } from "./discovery.js";
import { discoverRepository, type Repository } from "./repository.js";
import { clearModels, readChildren, readModels } from "./settings.js";
import type { SetupHost, SetupOption } from "./setup.js";

type ClearHost = Pick<SetupHost, "current" | "select" | "close" | "progress"> & {
    notify(message: string, error?: boolean): void;
};

export async function clearRepositories(
    repository: Repository,
    host: ClearHost,
): Promise<"back" | "done"> {
    const discover = async (initial?: DiscoveryResult) => {
        let finished = false;
        let canceled = false;
        const dialog = host
            .select("Discovering Git repositories…", [
                {
                    title: "Cancel",
                    value: "cancel",
                    description: "No attribution will be cleared.",
                },
            ])
            .then(() => {
                if (!finished) canceled = true;
            });
        const progress = { current: () => host.current() && !canceled, progress: host.progress };
        let result;
        try {
            if (initial) {
                result = await scanRepositories(repository, initial, progress);
            } else {
                result = await discoverSubmodules(repository, progress);
                if (progress.current()) {
                    await addKnownChildren(repository, result, progress.current);
                }
            }
        } finally {
            finished = true;
            host.close();
            await dialog;
        }
        return progress.current() ? result : undefined;
    };

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
        for (const { repository: target, kind } of result.candidates) {
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
                description: `${kind}; ${detail}`,
            });
        }
        if (!host.current()) return "done";
        const action = await host.select("Clear pending attribution", [
            ...rows,
            {
                title: "Clear all listed repositories…",
                value: "all",
                description: `${rows.length} listed worktrees; does not scan for more repositories.`,
            },
            { title: "Scan for additional child repositories…", value: "scan" },
            { title: "Cancel", value: "cancel" },
        ]);
        if (!host.current()) return "done";
        if (!action || action === "cancel") return "back";
        if (action === "scan") {
            result = (await discover(initial)) ?? result;
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
                        description:
                            "Current worktree and all child worktrees shown in the clear menu.",
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

// Reuse the last applied setup's paths without doing a filesystem scan or
// changing the saved inventory. Prefer the classification from fresh discovery.
async function addKnownChildren(
    repository: Repository,
    result: DiscoveryResult,
    current: () => boolean,
): Promise<void> {
    const seen = new Set(result.candidates.map(({ repository }) => repository.root));
    for (const root of new Set(await readChildren(repository))) {
        if (!current()) return;
        if (seen.has(root) || !contains(repository.root, root)) continue;
        try {
            const child = await discoverRepository(root);
            if (child?.root === root) {
                result.candidates.push({ repository: child, kind: "nested repository" });
            }
        } catch {
            // An unavailable cached path is not a clear target.
        }
    }
}
