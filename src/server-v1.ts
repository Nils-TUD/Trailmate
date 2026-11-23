import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { discoverRepository } from "./repository.js";
import { createCollector } from "./collection.js";
import { createChildChanges } from "./child-changes.js";

const server: Plugin = async ({ client, directory }) => {
    const repository = await discoverRepository(directory);

    if (!repository) return {};
    const warn = async (error: unknown) => {
        await client.app.log({
            body: { service: "trailmate", level: "warn", message: String(error) },
        });
    };
    const collector = createCollector(repository, {
        message: async (sessionID, messageID) => {
            const response = await client.session.message({
                path: { id: sessionID, messageID },
                query: { directory: repository.root },
            });
            return response.data?.info;
        },
        warn,
    });
    const childChanges = createChildChanges(repository, { warn });

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
        "tool.execute.before": async ({ sessionID, callID }) => {
            await collector.flush();
            await childChanges.before({ sessionID, id: callID }, async () => {
                // V1 hooks don't supply a message ID. Match the stored tool part
                // rather than guessing which recent assistant message owns it.
                const { data } = await client.session.messages({
                    path: { id: sessionID },
                    query: { directory, limit: 10 },
                    throwOnError: true,
                });
                return data.find(({ info, parts }) =>
                    info.role === "assistant" && parts.some((part) =>
                        part.type === "tool" && (part.callID === callID || part.id === callID),
                    ),
                )?.info;
            });
        },
        "tool.execute.after": ({ sessionID, callID }) =>
            childChanges.after({ sessionID, id: callID }),
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
            } else if (event.type === "message.part.updated") {
                const { part } = event.properties;
                // The V1 after hook may be skipped when the tool throws.
                if (part.type === "tool" && part.state.status === "error") {
                    await childChanges.after({ sessionID: part.sessionID, id: part.callID });
                    await childChanges.after({ sessionID: part.sessionID, id: part.id });
                }
            }
        },
    };
};

export default { id: "trailmate", server } satisfies PluginModule;
