import { discoverRepository, type Repository } from "./repository.js";
import { readDecision, writeDecision } from "./settings.js";

export type Choice = "enable" | "disable" | "later";

/** UI-independent coordinator; one outstanding prompt per TUI instance. */
export class OptIn {
    // Remember Later within this TUI, including across linked-worktree switches.
    private readonly attempted = new Set<string>();
    private busy = false;

    // Reuse successful discovery while polling, but keep reading saved settings.
    private readonly repositories = new Map<string, Repository>();

    async check(
        directory: string,
        current: () => boolean,
        prompt: (repository: Repository) => Promise<Choice>,
    ): Promise<void> {
        // A dialog can remain open across many timer ticks.
        if (this.busy) return;

        this.busy = true;

        try {
            const repository =
                this.repositories.get(directory) ?? (await discoverRepository(directory));
            if (repository) this.repositories.set(directory, repository);

            if (!repository || this.attempted.has(repository.commonDir)) return;

            const decision = await readDecision(repository);

            // Discovery and file reads may finish after a directory change or shutdown.
            if (!current()) return;
            if (decision !== "unknown") return;

            this.attempted.add(repository.commonDir);

            const choice = await prompt(repository);

            if (!current() || choice === "later") return;

            // Another TUI may have decided while this dialog was open.
            if ((await readDecision(repository)) !== "unknown") return;

            await writeDecision(repository, choice === "enable");
        } finally {
            this.busy = false;
        }
    }
}
