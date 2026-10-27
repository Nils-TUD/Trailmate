import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { discoverRepository } from "./repository.js";
import { actions, runAction, type Action } from "./actions.js";

type Api = Parameters<TuiPlugin>[0];

export function registerManagement(api: Api): void {
    const report = (result: string) => {
        api.ui.dialog.replace(() =>
            api.ui.DialogAlert({
                title: "Trailmate result",
                message: result,
                onConfirm: () => api.ui.dialog.clear(),
            }),
        );
    };

    const open = () => {
        const directory = api.state.path.directory;
        const run = async (action: Action) => {
            try {
                const repository = await discoverRepository(directory);
                if (!repository) throw new Error("Trailmate requires a Git worktree");

                // Never apply an old dialog's changes to a newly selected workspace.
                if (api.lifecycle.signal.aborted || api.state.path.directory !== directory) return;
                const result = await runAction(repository, action);
                if (!api.lifecycle.signal.aborted && api.state.path.directory === directory) {
                    report(result);
                }
            } catch (error) {
                if (!api.lifecycle.signal.aborted) {
                    api.ui.toast({
                        variant: "error",
                        title: "Trailmate",
                        message: String(error),
                    });
                }
            }
        };

        api.ui.dialog.replace(() =>
            api.ui.DialogSelect<Action>({
                title: "Manage Trailmate",
                options: actions.map((action) => ({ title: action, value: action })),
                onSelect: ({ value }) => void run(value),
            }),
        );
    };

    // The documented v1 command API provides native slash/palette actions on
    // the supported 1.x hosts; selecting it never sends a prompt to a model.
    const unregister = api.command?.register(() => [
        {
            title: "Manage Trailmate",
            value: "trailmate.manage",
            category: "Trailmate",
            slash: { name: "trailmate" },
            onSelect: open,
        },
    ]);
    if (unregister) api.lifecycle.onDispose(unregister);
}
