import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { OptIn, type Choice } from "./opt-in.js";
import type { Repository } from "./repository.js";
import { registerManagement } from "./management.js";

const tui: TuiPlugin = async (api) => {
    registerManagement(api);
    const optIn = new OptIn();
    // Avoid repeating the same operational error on every polling tick.
    const failed = new Set<string>();

    let cancelPrompt: (() => void) | undefined;
    let promptDirectory: string | undefined;

    // Keep dialog rendering and settlement separate from the polling checks.
    const prompt = (directory: string, repository: Repository): Promise<Choice> => {
        return new Promise((resolve) => {
            let settled = false;

            // Clearing a dialog also invokes its onClose callback. Settle first
            // so that callback cannot replace an explicit choice with Later.
            const finish = (choice: Choice, close: boolean) => {
                if (settled) return;

                settled = true;
                cancelPrompt = undefined;
                promptDirectory = undefined;

                if (close) api.ui.dialog.clear();

                resolve(choice);
            };

            const render = () =>
                api.ui.DialogSelect<Choice>({
                    title: `Enable Trailmate? ${repository.root}`,
                    options: [
                        {
                            title: "Enable",
                            value: "enable",
                            description:
                                "Save opt-in for model tracking and Assisted-by Git trailers " +
                                "(coming in later phases).",
                        },
                        {
                            title: "Disable",
                            value: "disable",
                            description:
                                "Keep attribution disabled for this repository; do not ask again.",
                        },
                        {
                            title: "Later",
                            value: "later",
                            description: "Ask next time OpenCode starts.",
                        },
                    ],
                    onSelect: ({ value }) => finish(value, true),
                });

            promptDirectory = directory;
            cancelPrompt = () => finish("later", true);

            api.ui.dialog.replace(render, () => finish("later", false));
        });
    };

    const tick = async () => {
        const directory = api.state.path.directory;

        // An old repository's dialog must not survive a workspace switch.
        if (cancelPrompt && directory !== promptDirectory) cancelPrompt();

        if (!api.state.ready || !directory || api.ui.dialog.open || failed.has(directory)) return;

        try {
            await optIn.check(
                directory,
                () =>
                    !api.lifecycle.signal.aborted &&
                    api.state.path.directory === directory &&
                    !api.ui.dialog.open,
                (repository) => prompt(directory, repository),
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
