import type { Plugin } from "@opencode/plugin/tui";
import { actions, runAction, type Action } from "./actions.js";
import { OptIn, type Choice } from "./opt-in.js";
import { discoverRepository } from "./repository.js";

export default {
    id: "trailmate",
    setup(ctx) {
        const optIn = new OptIn();
        const failed = new Set<string>();
        let disposed = false;
        let dialogDirectory: string | undefined;
        const directory = () => (ctx.location ?? ctx.data.location.default()).directory;
        const current = (path: string) => !disposed && directory() === path;
        const error = (error: unknown) => {
            if (!disposed)
                ctx.ui.toast.show({ title: "Trailmate", variant: "error", message: String(error) });
        };
        // Track only dialogs owned by this plugin, so cleanup leaves other UI alone.
        const select = async <T>(
            path: string,
            title: string,
            options: { title: string; value: T; description?: string }[],
        ) => {
            dialogDirectory = path;
            try {
                return await ctx.ui.dialog.select<T>({ title, options });
            } finally {
                dialogDirectory = undefined;
            }
        };
        const manage = async () => {
            const path = directory();
            try {
                const action = await select<Action>(
                    path,
                    "Manage Trailmate",
                    actions.map((value) => ({ title: value, value })),
                );
                if (!action || !current(path)) return;
                const repository = await discoverRepository(path);
                if (!current(path)) return;
                if (!repository) throw new Error("Trailmate requires a Git worktree");
                const message = await runAction(repository, action);
                if (current(path)) {
                    dialogDirectory = path;
                    try {
                        await ctx.ui.dialog.alert({ title: "Trailmate result", message });
                    } finally {
                        dialogDirectory = undefined;
                    }
                }
            } catch (cause) {
                error(cause);
            }
        };
        ctx.keymap.layer(() => ({
            mode: "global",
            commands: [
                {
                    id: "trailmate.manage",
                    title: "Manage Trailmate",
                    group: "Trailmate",
                    palette: true,
                    slash: { name: "trailmate" },
                    run: manage,
                },
            ],
        }));

        const tick = async () => {
            const path = directory();
            if (dialogDirectory && dialogDirectory !== path) ctx.ui.dialog.clear();
            if (disposed || !path || dialogDirectory || failed.has(path)) return;
            try {
                await optIn.check(
                    path,
                    () => current(path) && !dialogDirectory,
                    async (repository) =>
                        (await select<Choice>(path, `Enable Trailmate? ${repository.root}`, [
                            {
                                title: "Enable",
                                value: "enable",
                                description: "Track models and install Assisted-by Git trailers.",
                            },
                            {
                                title: "Disable",
                                value: "disable",
                                description: "Disable attribution; do not ask again.",
                            },
                            {
                                title: "Later",
                                value: "later",
                                description: "Ask next time OpenCode starts.",
                            },
                        ])) ?? "later",
                );
            } catch (cause) {
                failed.add(path);
                error(cause);
            }
        };
        const timer = setInterval(() => {
            void tick();
        }, 500);
        return () => {
            disposed = true;
            clearInterval(timer);
            if (dialogDirectory) ctx.ui.dialog.clear();
        };
    },
} satisfies Plugin.Definition;
