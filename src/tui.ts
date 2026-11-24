import type { Plugin } from "@opencode/plugin/tui";
import { actions, runWorkspaceAction, type Action } from "./actions.js";
import { clearRepositories } from "./clear.js";
import { OptIn, type Choice } from "./opt-in.js";
import { discoverWorkspace, type Workspace } from "./workspace.js";
import { setupRepositories, type SetupOption } from "./setup.js";

export default {
    id: "trailmate",
    setup(ctx) {
        const optIn = new OptIn();
        const failed = new Set<string>();
        let disposed = false;
        let dialogDirectory: string | undefined;
        let setupRunning = false;
        let managing = false;
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
        const discoveryDialogs = (path: string) => {
            let lastProgress = 0;
            return {
                current: () => current(path),
                select: (title: string, options: SetupOption[]) => select(path, title, options),
                close: () => {
                    if (dialogDirectory === path) ctx.ui.dialog.clear();
                },
                progress: (directory: string, found: number) => {
                    if (!current(path) || Date.now() - lastProgress < 1000) return;
                    lastProgress = Date.now();
                    ctx.ui.toast.show({
                        title: `Trailmate: ${found} repositories found`,
                        message: directory,
                    });
                },
            };
        };
        const setup = async (
            path: string,
            repository: Workspace,
            automatic = false,
        ): Promise<Choice> => {
            if (setupRunning) return "later";
            setupRunning = true;
            try {
                return await setupRepositories(repository, {
                    ...discoveryDialogs(path),
                    automatic,
                    report: async (message) => {
                        if (!current(path)) return;
                        dialogDirectory = path;
                        try {
                            await ctx.ui.dialog.alert({ title: "Trailmate setup", message });
                        } finally {
                            dialogDirectory = undefined;
                        }
                    },
                });
            } finally {
                setupRunning = false;
            }
        };
        const manage = async () => {
            if (setupRunning || managing) return;
            managing = true;
            const path = directory();
            try {
                while (current(path)) {
                    if (!(await manageOnce(path))) return;
                }
            } catch (cause) {
                error(cause);
            } finally {
                managing = false;
            }
        };
        const manageOnce = async (path: string) => {
            const action = await select<Action>(
                path,
                "Manage Trailmate",
                actions.map((value) => ({ title: value, value })),
            );
            if (!action || !current(path)) return;
            const repository = await discoverWorkspace(path);
            if (!current(path)) return;
            if (action === "setup") {
                await setup(path, repository);
                return;
            }
            if (action === "clear") {
                const result = await clearRepositories(repository, {
                    ...discoveryDialogs(path),
                    notify: (message, failed) =>
                        ctx.ui.toast.show({
                            title: "Trailmate",
                            message,
                            variant: failed ? "error" : "success",
                        }),
                });
                return result === "back";
            }
            const message = await runWorkspaceAction(repository, action, discoveryDialogs(path));
            if (message !== undefined && current(path)) {
                dialogDirectory = path;
                try {
                    await ctx.ui.dialog.alert({ title: "Trailmate result", message });
                } finally {
                    dialogDirectory = undefined;
                }
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
            if (
                disposed ||
                !path ||
                dialogDirectory ||
                setupRunning ||
                managing ||
                failed.has(path)
            )
                return;
            try {
                await optIn.check(
                    path,
                    () => current(path) && !dialogDirectory && !managing,
                    (repository) => setup(path, repository, true),
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
