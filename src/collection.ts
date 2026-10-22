import type { PluginInput } from "@opencode-ai/plugin";
import type { Event, Message } from "@opencode-ai/sdk";
import { discoverRepository, type Repository } from "./repository.js";
import { addModel, readDecision } from "./settings.js";

interface Entry {
    sessionID: string;
    messageID: string;
    info?: Message;
    pending: boolean;
    seen: Set<string>;
}

export function createCollector(repository: Repository, client: PluginInput["client"]) {
    const entries = new Map<string, Entry>();
    let queue = Promise.resolve();
    const warn = async (error: unknown) => {
        await client.app.log({
            body: { service: "trailmate", level: "warn", message: String(error) },
        });
    };

    const flush = async () => {
        for (const entry of entries.values()) {
            if (!entry.pending) continue;

            try {
                if (!entry.info) {
                    const response = await client.session.message({
                        path: { id: entry.sessionID, messageID: entry.messageID },
                        query: { directory: repository.root },
                    });
                    if (!response.data) continue;
                    entry.info = response.data.info;
                }

                const info = entry.info;
                if (info.role === "assistant" && !info.summary) {
                    const source = await discoverRepository(info.path.cwd);
                    if (source?.root === repository.root) {
                        await addModel(repository, `${info.providerID}/${info.modelID}`);
                    }
                }

                entry.pending = false;
            } catch (error) {
                // Keep pending patches for the next event/tool boundary.
                await warn(error);
            }
        }
    };

    const run = (operation: () => Promise<void>) => {
        queue = queue.then(operation).catch(warn);
        return queue;
    };

    return {
        flush: () => run(flush),
        event: (event: Event) =>
            run(async () => {
                if (event.type === "session.deleted") {
                    for (const [key, entry] of entries) {
                        if (entry.sessionID === event.properties.info.id) entries.delete(key);
                    }
                }

                if (event.type !== "message.updated" && event.type !== "message.part.updated")
                    return;

                const info = event.type === "message.updated" ? event.properties.info : undefined;
                const part =
                    event.type === "message.part.updated" ? event.properties.part : undefined;
                if (part && (part.type !== "patch" || !part.files.length)) return;

                const sessionID = info?.sessionID ?? part!.sessionID;
                const messageID = info?.id ?? part!.messageID;
                const key = `${sessionID}/${messageID}`;
                let entry = entries.get(key);

                if (!entry) {
                    entry = { sessionID, messageID, pending: false, seen: new Set() };
                    entries.set(key, entry);
                }
                if (info) entry.info = info;
                if (part && !entry.seen.has(part.id)) {
                    if ((await readDecision(repository)) === "enabled") entry.pending = true;
                    entry.seen.add(part.id);
                    if (entry.seen.size > 128) entry.seen.delete(entry.seen.values().next().value!);
                }
                // Bound lifetime memory even in a long-running OpenCode instance.
                if (entries.size > 1024) {
                    const oldest = entries.keys().next().value!;
                    if (entries.get(oldest)!.pending)
                        await warn("Attribution collector evicted unresolved patches");
                    entries.delete(oldest);
                }

                await flush();
            }),
    };
}
