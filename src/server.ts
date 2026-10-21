import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { discoverRepository } from "./repository.js";
import { readDecision, type Decision } from "./settings.js";

const server: Plugin = async ({ client, directory }) => {
    const repository = await discoverRepository(directory);

    if (!repository) return {};

    let previous: Decision | undefined;

    // The TUI or CLI may change the preference while the server remains running.
    const refresh = async () => {
        try {
            const decision = await readDecision(repository);

            // Log transitions only, rather than logging before every tool call.
            if (decision === previous) return;

            previous = decision;

            await client.app.log({
                body: {
                    service: "opencode-auto-attr",
                    level: "info",
                    message:
                        `Repository attribution preference: ${decision} ` +
                        "(phase 1; collection pending)",
                },
            });
        } catch (error) {
            // Report invalid settings without interrupting the user's coding tools.
            await client.app.log({
                body: {
                    service: "opencode-auto-attr",
                    level: "warn",
                    message: String(error),
                },
            });
        }
    };

    await refresh();

    return {
        "tool.execute.before": refresh,
        event: async ({ event }) => {
            if (event.type === "session.created") await refresh();
        },
    };
};

export default { id: "opencode-auto-attr", server } satisfies PluginModule;
