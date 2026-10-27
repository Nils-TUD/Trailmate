import type { Plugin } from "@opencode/plugin";
import { createCollector } from "./collection.js";
import { discoverRepository } from "./repository.js";

export default {
    id: "trailmate",
    async setup(ctx) {
        const repository = await discoverRepository(ctx.location.directory);
        if (!repository) return;

        const collector = createCollector(repository, {
            message: async (sessionID, messageID) => {
                const messages = await ctx.session.context({ sessionID });
                const message = messages.find((message) => message.id === messageID);
                if (message?.type !== "assistant") return;
                const session = await ctx.session.get({ sessionID });
                return {
                    id: messageID,
                    sessionID,
                    role: "assistant",
                    path: { cwd: session.location.directory },
                    providerID: message.model.providerID,
                    modelID: message.model.id,
                };
            },
            warn: async (error) => {
                console.warn("Trailmate:", error);
            },
        });

        await ctx.tool.hook("execute.before", () => collector.flush());
        const controller = new AbortController();
        const listen = async () => {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                if (event.type === "session.deleted") {
                    await collector.event({
                        type: "session.deleted",
                        properties: { info: { id: event.data.sessionID } },
                    });
                } else if (event.type === "session.step.started" && event.location) {
                    await collector.event({
                        type: "message.updated",
                        properties: {
                            info: {
                                id: event.data.assistantMessageID,
                                sessionID: event.data.sessionID,
                                role: "assistant",
                                path: { cwd: event.location.directory },
                                providerID: event.data.model.providerID,
                                modelID: event.data.model.id,
                            },
                        },
                    });
                } else if (
                    event.type === "session.step.ended" ||
                    event.type === "session.step.failed"
                ) {
                    if (!event.data.files?.length) continue;
                    // A V2 step's snapshot files are the equivalent of a V1 patch part.
                    await collector.event({
                        type: "message.part.updated",
                        properties: {
                            part: {
                                type: "patch",
                                id: event.id,
                                sessionID: event.data.sessionID,
                                messageID: event.data.assistantMessageID,
                                files: [...event.data.files],
                            },
                        },
                    });
                }
            }
        };
        const task = listen().catch((error) => {
            if (!controller.signal.aborted) console.warn("Trailmate event stream:", error);
        });
        return async () => {
            controller.abort();
            await task;
            await collector.flush();
        };
    },
} satisfies Plugin.Plugin;
