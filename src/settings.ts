import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Repository } from "./repository.js";
import { configureHooks, hookStatus } from "./hooks.js";

export type Decision = "unknown" | "enabled" | "disabled";
export type Settings = Record<string, unknown> & {
    version: 1;
    enabled: boolean | null;
    models: Record<string, string[]>;
    hooks?: { file: string }[];
};

export function settingsPath(repository: Repository): string {
    return path.join(repository.commonDir, "opencode-attribution", "settings.json");
}

async function readSettings(repository: Repository): Promise<Settings> {
    try {
        return JSON.parse(await readFile(settingsPath(repository), "utf8")) as Settings;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { version: 1, enabled: null, models: {} };
        }
        throw error;
    }
}

async function updateSettings(
    repository: Repository,
    change: (settings: Settings, publish: () => Promise<void>) => void | Promise<void>,
): Promise<void> {
    const file = settingsPath(repository);
    await mkdir(path.dirname(file), { recursive: true });

    // The server and TUI can be separate processes. Serialize the whole
    // read/modify/write so changing one worktree cannot undo another's update.
    const lockFile = `${file}.lock`;
    const deadline = Date.now() + 2000;
    let lock;
    while (!lock) {
        try {
            lock = await open(lockFile, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (Date.now() >= deadline)
                throw new Error(`Timed out waiting for attribution lock: ${lockFile}`);
            await delay(25);
        }
    }

    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        const settings = await readSettings(repository);
        const publish = async () => {
            await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
                flag: "wx",
                mode: 0o600,
            });
            await rename(temporary, file);
        };
        await change(settings, publish);
        await publish();
    } finally {
        try {
            await rm(temporary, { force: true });
        } finally {
            await lock.close();
            await rm(lockFile);
        }
    }
}

export async function readDecision(repository: Repository): Promise<Decision> {
    const { enabled } = await readSettings(repository);
    return enabled === null ? "unknown" : enabled ? "enabled" : "disabled";
}

export async function writeDecision(repository: Repository, enabled: boolean): Promise<void> {
    await updateSettings(repository, async (settings, publish) => {
        await configureHooks(repository, settings, enabled, publish);
    });
}

export async function readHookStatus(repository: Repository): Promise<string> {
    return hookStatus(repository, await readSettings(repository));
}

export async function addModel(repository: Repository, model: string): Promise<void> {
    await updateSettings(repository, (settings) => {
        if (settings.enabled !== true) return;
        settings.models[repository.root] = [
            ...new Set([...(settings.models[repository.root] ?? []), model]),
        ].sort();
    });
}

export async function readModels(repository: Repository): Promise<string[]> {
    const settings = await readSettings(repository);
    return [...new Set(settings.models[repository.root] ?? [])].sort();
}

export async function clearModels(repository: Repository): Promise<void> {
    await updateSettings(repository, (settings) => {
        delete settings.models[repository.root];
    });
}
