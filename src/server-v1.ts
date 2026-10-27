import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { discoverRepository } from "./repository.js";
import { createCollector } from "./collection.js";

const server: Plugin = async ({ client, directory }) => {
    const repository = await discoverRepository(directory);

    if (!repository) return {};
    const collector = createCollector(repository, {
        message: async (sessionID, messageID) => {
            const response = await client.session.message({
                path: { id: sessionID, messageID },
                query: { directory: repository.root },
            });
            return response.data?.info;
        },
        warn: async (error) => {
            await client.app.log({
                body: { service: "trailmate", level: "warn", message: String(error) },
            });
        },
    });

    await client.app.log({
        body: {
            service: "trailmate",
            level: "info",
            message: "Trailmate plugin loaded",
        },
    });

    return {
        config: async (config) => {
            if (config.snapshot === false) {
                await client.app.log({
                    body: {
                        service: "trailmate",
                        level: "warn",
                        message:
                            "Trailmate needs OpenCode snapshots to receive file-changing patch events; snapshot is disabled.",
                    },
                });
            }
        },
        "tool.execute.before": async () => {
            await collector.flush();
        },
        event: async ({ event }) => {
            if (event.type === "message.updated" || event.type === "session.deleted") {
                await collector.event(event);
            } else if (
                event.type === "message.part.updated" &&
                event.properties.part.type === "patch"
            ) {
                await collector.event({
                    type: event.type,
                    properties: { part: event.properties.part },
                });
            }
        },
    };
};

export default { id: "trailmate", server } satisfies PluginModule;
