import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { discoverRepository } from "./repository.js";
import { createCollector } from "./collection.js";

const server: Plugin = async ({ client, directory }) => {
    const repository = await discoverRepository(directory);

    if (!repository) return {};
    const collector = createCollector(repository, client);

    await client.app.log({
        body: {
            service: "opencode-auto-attr",
            level: "info",
            message: "AI attribution plugin loaded",
        },
    });

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
            await collector.flush();
        },
        event: async ({ event }) => {
            await collector.event(event);
        },
    };
};

export default { id: "opencode-auto-attr", server } satisfies PluginModule;
