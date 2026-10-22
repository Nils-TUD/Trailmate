import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Repository } from "./repository.js";

export type Decision = "unknown" | "enabled" | "disabled";
type Settings = Record<string, unknown> & {
    version: 1;
    enabled: boolean | null;
    models: Record<string, string[]>;
};

export function settingsPath(repository: Repository): string {
    return path.join(repository.commonDir, "opencode-attribution", "settings.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettings(repository: Repository): Promise<Settings> {
    const file = settingsPath(repository);
    let contents: Buffer;
    try {
        contents = await readFile(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { version: 1, enabled: null, models: {} };
        }
        throw error;
    }

    try {
        const settings: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(contents),
        );
        if (
            !isObject(settings) ||
            settings.version !== 1 ||
            (settings.enabled !== null && typeof settings.enabled !== "boolean")
        ) {
            throw new Error("expected version 1 and a boolean or null enabled field");
        }

        // Accept the preference-only files written by phase 1.
        const models = settings.models === undefined ? {} : settings.models;
        if (
            !isObject(models) ||
            Object.values(models).some(
                (values) =>
                    !Array.isArray(values) || values.some((value) => typeof value !== "string"),
            )
        ) {
            throw new Error("expected a worktree-to-models map containing arrays of strings");
        }
        return { ...settings, models } as Settings;
    } catch (error) {
        throw new Error(`Invalid attribution settings at ${file}`, { cause: error });
    }
}

async function updateSettings(
    repository: Repository,
    change: (settings: Settings) => void,
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
        change(settings);
        await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
        });
        await rename(temporary, file);
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
    await updateSettings(repository, (settings) => {
        settings.enabled = enabled;
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
