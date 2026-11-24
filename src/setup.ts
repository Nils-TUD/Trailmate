/**
 * Shared Trailmate setup flow for the OpenCode V1 and V2 TUIs. Both the initial
 * opt-in prompt and `/trailmate` → `setup` use this flow; the host adapter
 * supplies the native dialogs, while this module handles choices and navigation.
 *
 * Uses discovery.ts to find repository candidates and settings.ts to apply
 * enablement and install or remove Git hooks. After applying enablement, it
 * remembers setup and saves discovered child paths for status and change
 * detection. Canceling discovery or selection returns to setup without writes.
 */
import path from "node:path";
import {
    discoverSubmodules,
    scanRepositories,
    type DiscoveryHost,
    type DiscoveryResult,
} from "./discovery.js";
import type { Choice } from "./opt-in.js";
import { discoverRepository, type Repository } from "./repository.js";
import { markSetupComplete, readDecision, readSetupComplete, writeDecision } from "./settings.js";
import { addKnownChildren, isRepository, type Workspace } from "./workspace.js";

export interface SetupOption {
    title: string;
    value: string;
    description?: string;
}

export interface SetupHost extends DiscoveryHost {
    automatic?: boolean;
    select(title: string, options: SetupOption[]): Promise<string | undefined>;
    close(): void;
    report(message: string): Promise<void>;
}

export type DiscoveryDialogs = Pick<SetupHost, "current" | "select" | "close" | "progress">;

async function revalidateRepository(expected: Repository): Promise<Repository> {
    const actual = await discoverRepository(expected.root);
    if (actual?.root !== expected.root || actual.commonDir !== expected.commonDir) {
        throw new Error("Repository is no longer available or its Git directory has changed.");
    }
    return actual;
}

/** Initial management list, or a full scan when given a list to expand. */
export function discoverForManagement(
    workspace: Workspace,
    host: DiscoveryDialogs,
    description: string,
    initial?: DiscoveryResult,
): Promise<DiscoveryResult | undefined> {
    return withDiscoveryDialog(host, description, async (progress) => {
        if (initial || !isRepository(workspace)) {
            return scanRepositories(
                workspace,
                initial ?? { candidates: [], skipped: [] },
                progress,
            );
        }
        const result = await discoverSubmodules(workspace, progress);
        if (progress.current()) await addKnownChildren(workspace, result, progress.current);
        return result;
    });
}

export async function withDiscoveryDialog<T>(
    host: DiscoveryDialogs,
    description: string,
    run: (progress: DiscoveryHost) => Promise<T>,
): Promise<T | undefined> {
    let finished = false;
    let canceled = false;
    const dialog = host
        .select("Discovering Git repositories…", [
            { title: "Cancel", value: "cancel", description },
        ])
        .then(() => {
            if (!finished) canceled = true;
        });
    const progress = { current: () => host.current() && !canceled, progress: host.progress };
    try {
        const result = await run(progress);
        return progress.current() ? result : undefined;
    } finally {
        finished = true;
        host.close();
        await dialog;
    }
}

// Both OpenCode adapters supply only native single-choice dialogs. No custom UI runtime is needed:
// selecting a row toggles it and opens the list again to simulate a multiple-choice dialog.
export async function setupRepositories(repository: Workspace, host: SetupHost): Promise<Choice> {
    while (host.current()) {
        const result = await setupAttempt(repository, host);
        if (result !== "back") return result;
    }
    return "later";
}

async function setupAttempt(repository: Workspace, host: SetupHost): Promise<Choice | "back"> {
    const worktree = isRepository(repository) ? repository : undefined;
    const choice = await host.select(`Enable Trailmate? ${repository.root}`, [
        ...(worktree
            ? [
                  {
                      title: "Enable all",
                      value: "enable",
                      description:
                          "Current repository and initialized submodules; preserve child opt-outs.",
                  },
                  {
                      title: "Enable selectively…",
                      value: "select",
                      description: "Choose from the current repository and initialized submodules.",
                  },
                  {
                      title: "Disable",
                      value: "disable",
                      description: "Disable this repository; leave child preferences unchanged.",
                  },
              ]
            : []),
        {
            title: "Scan for additional child repositories…",
            value: "scan",
            description: "Search the directory tree, then choose repositories. May take a while.",
        },
        { title: "Later", value: "later", description: "Ask next time OpenCode starts." },
    ]);
    if (!host.current() || !choice || choice === "later") return "later";
    const canApply = async () => {
        if (
            host.automatic &&
            worktree &&
            ((await readDecision(worktree)) !== "unknown" || (await readSetupComplete(worktree)))
        )
            return false;
        return host.current();
    };
    if (!(await canApply())) return "configured";
    if (choice === "disable" && worktree) {
        const actual = await revalidateRepository(worktree);
        if (host.current()) await writeDecision(actual, false);
        return "configured";
    }

    const controller = new AbortController();
    let scanning = true;
    // A pending native dialog provides cancellation while async traversal runs.
    // It also lets the host close the scan on a location switch or disposal.
    const cancel = host
        .select("Discovering Git repositories…", [
            {
                title: "Cancel",
                value: "cancel",
                description:
                    choice === "scan"
                        ? "Recursive scan; no settings have been changed."
                        : "Discovering initialized submodules; no settings have been changed.",
            },
        ])
        .then(() => {
            if (scanning) controller.abort();
        });
    const discoveryHost: DiscoveryHost = {
        current: () => host.current() && !controller.signal.aborted,
        progress: host.progress,
    };
    let discovery;
    try {
        discovery = worktree
            ? await discoverSubmodules(worktree, discoveryHost)
            : { candidates: [], skipped: [] };
        if (choice === "scan" && discoveryHost.current()) {
            discovery = await scanRepositories(repository, discovery, discoveryHost);
        }
    } finally {
        scanning = false;
        host.close();
        await cancel;
    }
    if (!host.current()) return "later";
    if (controller.signal.aborted) return "back";
    const candidates = discovery.candidates;
    if (!worktree && !candidates.length) {
        await host.report(["No child Git repositories found.", ...discovery.skipped].join("\n"));
        return "back";
    }
    const selected = new Set<string>();
    const decisions = new Map<string, Awaited<ReturnType<typeof readDecision>>>();
    for (const { repository: child, kind } of candidates) {
        const decision = await readDecision(child);
        decisions.set(child.root, decision);
        if (
            decision === "enabled" ||
            kind === "current" ||
            (kind === "submodule" && decision !== "disabled")
        ) {
            selected.add(child.root);
        }
    }
    if (!host.current()) return "later";

    if (choice !== "enable") {
        while (host.current()) {
            const options: SetupOption[] = candidates.map(({ repository: child, kind }) => ({
                title: `[${selected.has(child.root) ? "✓" : " "}] ${path.relative(repository.root, child.root) || "."}`,
                value: child.root,
                description: `${kind}; ${decisions.get(child.root)}${decisions.get(child.root) === "enabled" ? "; unchecking leaves enabled" : ""}`,
            }));
            options.push(
                { title: "Select all", value: "all" },
                { title: "Select none", value: "none" },
                {
                    title: "Apply",
                    value: "apply",
                    description:
                        "Enable selected repositories; leave unchecked repositories unchanged.",
                },
                { title: "Cancel", value: "cancel" },
            );
            const action = await host.select(
                `Select repositories — ${selected.size} selected`,
                options,
            );
            if (!host.current()) return "later";
            if (!action || action === "cancel") return "back";
            if (action === "apply") break;
            if (action === "all") {
                for (const child of candidates) selected.add(child.repository.root);
            } else if (action === "none") selected.clear();
            else if (selected.has(action)) selected.delete(action);
            else selected.add(action);
        }
    }

    // Another TUI may have completed setup while this selection was open.
    if (!(await canApply())) return "configured";
    const results: string[] = [];
    for (const { repository: child } of candidates) {
        if (!host.current()) return "configured";
        const label = path.relative(repository.root, child.root) || ".";
        if (!selected.has(child.root)) {
            results.push(`Unchanged: ${label} (${decisions.get(child.root)})`);
            continue;
        }
        try {
            const actual = await revalidateRepository(child);
            // A child opt-out made during discovery must also be respected by Enable all.
            if (
                choice === "enable" &&
                child.root !== repository.root &&
                (await readDecision(actual)) === "disabled"
            ) {
                results.push(`Unchanged: ${label} (explicitly disabled)`);
                continue;
            }
            if (!host.current()) return "configured";
            await writeDecision(actual, true);
            results.push(`Enabled: ${label}`);
        } catch (error) {
            results.push(`Failed: ${label}: ${String(error)}`);
        }
    }
    // Remember setup even if the user chose children without enabling the parent.
    // This is not a parent opt-out and does not change its attribution preference.
    if (host.current() && worktree) {
        try {
            const actual = await revalidateRepository(worktree);
            if (host.current()) {
                await markSetupComplete(
                    actual,
                    candidates.map((child) => child.repository.root),
                );
            }
        } catch (error) {
            results.push(`Failed to save setup for the current worktree: ${String(error)}`);
        }
    }
    if (host.current()) {
        await host.report(
            [...results, ...discovery.skipped.map((item) => `Skipped: ${item}`)].join("\n") ||
                "No repositories selected.",
        );
    }
    return "configured";
}
