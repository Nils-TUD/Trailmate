import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { discoverRepository } from "./repository.js";
import { readDecision, type Decision } from "./settings.js";
import { createCollector } from "./collection.js";

const server: Plugin = async ({ client, directory }) => {
    const repository = await discoverRepository(directory);

    if (!repository) return {};
    const collector = createCollector(repository, client);

    let previous: Decision | undefined;

    // The TUI may change the preference while the server remains running.
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
                    message: `Repository attribution preference: ${decision}`,
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
        config: async (config) => {
            if (config.snapshot === false) {
                await client.app.log({
                    body: {
                        service: "opencode-auto-attr",
                        level: "warn",
                        message:
                            "AI attribution needs OpenCode snapshots to receive file-changing patch events; snapshot is disabled.",
                    },
                });
            }
        },
        "tool.execute.before": async () => {
            await refresh();
            await collector.flush();
        },
        event: async ({ event }) => {
            if (event.type === "session.created") await refresh();
            await collector.event(event);
        },
    };
};

export default { id: "opencode-auto-attr", server } satisfies PluginModule;
