import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { OptIn, type Choice } from "./opt-in.js";
import type { Repository } from "./repository.js";
import { registerManagement } from "./management-v1.js";
import { setupRepositories, type SetupOption } from "./setup.js";
import { clearRepositories } from "./clear.js";

const tui: TuiPlugin = async (api) => {
    const optIn = new OptIn();
    // Avoid repeating the same operational error on every polling tick.
    const failed = new Set<string>();

    let cancelPrompt: (() => void) | undefined;
    let promptDirectory: string | undefined;
    let setupDirectory: string | undefined;

    // Keep dialog rendering and settlement separate from the polling checks.
    const select = (
        directory: string,
        title: string,
        options: SetupOption[],
    ): Promise<string | undefined> => {
        return new Promise((resolve) => {
            let settled = false;

            // Clearing a dialog also invokes its onClose callback. Settle first
            // so that callback cannot replace an explicit choice with Later.
            const finish = (choice: string | undefined, close: boolean) => {
                if (settled) return;

                settled = true;
                cancelPrompt = undefined;
                promptDirectory = undefined;

                if (close) api.ui.dialog.clear();

                resolve(choice);
            };

            const render = () =>
                api.ui.DialogSelect<string>({
                    title,
                    options,
                    onSelect: ({ value }) => finish(value, true),
                });

            promptDirectory = directory;
            cancelPrompt = () => finish(undefined, true);

            api.ui.dialog.replace(render, () => finish(undefined, false));
        });
    };

    const discoveryDialogs = (directory: string) => {
        let lastProgress = 0;
        const current = () =>
            !api.lifecycle.signal.aborted && api.state.path.directory === directory;
        return {
            current,
            select: (title: string, options: SetupOption[]) => select(directory, title, options),
            close: () => cancelPrompt?.(),
            progress: (path: string, found: number) => {
                if (!current() || Date.now() - lastProgress < 1000) return;
                lastProgress = Date.now();
                api.ui.toast({ title: `Trailmate: ${found} repositories found`, message: path });
            },
        };
    };

    const withDialogs = async <T>(
        directory: string,
        run: () => Promise<T>,
    ): Promise<T | undefined> => {
        if (setupDirectory) return;
        setupDirectory = directory;
        try {
            return await run();
        } finally {
            setupDirectory = undefined;
        }
    };

    const prompt = async (
        directory: string,
        repository: Repository,
        automatic = false,
    ): Promise<Choice> => {
        const dialogs = discoveryDialogs(directory);
        return (
            (await withDialogs(directory, () =>
                setupRepositories(repository, {
                    ...dialogs,
                    automatic,
                    report: async (message) => {
                        if (!dialogs.current()) return;
                        await new Promise<void>((resolve) => {
                            let settled = false;
                            const finish = (close: boolean) => {
                                if (settled) return;
                                settled = true;
                                cancelPrompt = undefined;
                                promptDirectory = undefined;
                                if (close) api.ui.dialog.clear();
                                resolve();
                            };
                            promptDirectory = directory;
                            cancelPrompt = () => finish(true);
                            api.ui.dialog.replace(
                                () =>
                                    api.ui.DialogAlert({
                                        title: "Trailmate setup",
                                        message,
                                        onConfirm: () => finish(true),
                                    }),
                                () => finish(false),
                            );
                        });
                    },
                }),
            )) ?? "later"
        );
    };

    registerManagement(
        api,
        (repository) => prompt(api.state.path.directory, repository),
        (repository) => {
            const directory = api.state.path.directory;
            return withDialogs(directory, () =>
                clearRepositories(repository, {
                    ...discoveryDialogs(directory),
                    notify: (message, failed) =>
                        api.ui.toast({
                            title: "Trailmate",
                            message,
                            variant: failed ? "error" : "success",
                        }),
                }),
            );
        },
        () => setupDirectory !== undefined,
    );

    const tick = async () => {
        const directory = api.state.path.directory;

        // An old repository's dialog must not survive a workspace switch.
        if (cancelPrompt && directory !== promptDirectory) cancelPrompt();

        if (setupDirectory) return;

        if (!api.state.ready || !directory || api.ui.dialog.open || failed.has(directory)) return;

        try {
            await optIn.check(
                directory,
                () =>
                    !api.lifecycle.signal.aborted &&
                    api.state.path.directory === directory &&
                    !api.ui.dialog.open,
                (repository) => prompt(directory, repository, true),
            );
        } catch (error) {
            failed.add(directory);

            if (!api.lifecycle.signal.aborted) {
                api.ui.toast({ variant: "error", title: "Trailmate", message: String(error) });
            }
        }
    };

    // The host state is live; polling handles initial sync and workspace changes
    // without relying on private Solid internals or undocumented bus events.
    const timer = setInterval(() => {
        void tick();
    }, 500);

    // Resolve any outstanding prompt so its async check can finish on shutdown.
    api.lifecycle.onDispose(() => {
        clearInterval(timer);
        cancelPrompt?.();
    });
};

export default { id: "trailmate", tui } satisfies TuiPluginModule;
