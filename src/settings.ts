import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Repository } from "./repository.js";

export type Decision = "unknown" | "enabled" | "disabled";

export function settingsPath(repository: Repository): string {
    return path.join(repository.commonDir, "opencode-attribution", "settings.json");
}

export async function readDecision(repository: Repository): Promise<Decision> {
    const file = settingsPath(repository);
    let contents: string;

    try {
        contents = await readFile(file, "utf8");
    } catch (error) {
        // A missing file is the only case that means the user has not decided.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unknown";

        throw error;
    }

    try {
        const settings: unknown = JSON.parse(contents);

        // Reject incompatible or damaged files rather than prompting again and
        // potentially overwriting an existing decision.
        if (
            typeof settings !== "object" ||
            settings === null ||
            !("version" in settings) ||
            settings.version !== 1 ||
            !("enabled" in settings) ||
            typeof settings.enabled !== "boolean"
        ) {
            throw new Error("expected version 1 and a boolean enabled field");
        }

        return settings.enabled ? "enabled" : "disabled";
    } catch (error) {
        throw new Error(`Invalid attribution settings at ${file}`, { cause: error });
    }
}

export async function writeDecision(repository: Repository, enabled: boolean): Promise<void> {
    const file = settingsPath(repository);

    await mkdir(path.dirname(file), { recursive: true });

    // Write beside the destination so rename publishes a complete file on the
    // same filesystem. Readers never observe a partially written JSON document.
    const temporary = `${file}.${randomUUID()}.tmp`;

    try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
        });
        await rename(temporary, file);
    } finally {
        // Also remove the temporary file if writing or publishing failed.
        await rm(temporary, { force: true });
    }
}
