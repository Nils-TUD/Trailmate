import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { discoverWorkspace, type Workspace } from "./workspace.js";
import { actions, runWorkspaceAction, type Action } from "./actions.js";
import type { DiscoveryDialogs } from "./setup.js";

type Api = Parameters<TuiPlugin>[0];

export function registerManagement(
    api: Api,
    setup: (repository: Workspace) => Promise<unknown>,
    clear: (repository: Workspace) => Promise<"back" | "done" | undefined>,
    busy: () => boolean,
    dialogs: (directory: string) => DiscoveryDialogs,
): void {
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
        if (busy()) return;
        const directory = api.state.path.directory;
        const run = async (action: Action) => {
            try {
                const repository = await discoverWorkspace(directory);

                // Never apply an old dialog's changes to a newly selected workspace.
                if (api.lifecycle.signal.aborted || api.state.path.directory !== directory) return;
                if (action === "setup") {
                    api.ui.dialog.clear();
                    await setup(repository);
                    return;
                }
                if (action === "clear") {
                    api.ui.dialog.clear();
                    if (
                        (await clear(repository)) === "back" &&
                        api.state.path.directory === directory &&
                        !api.lifecycle.signal.aborted
                    )
                        open();
                    return;
                }
                const current = () =>
                    !api.lifecycle.signal.aborted && api.state.path.directory === directory;
                if (!repository.commonDir || action !== "status") api.ui.dialog.clear();
                const result = await runWorkspaceAction(repository, action, dialogs(directory));
                if (result !== undefined && current()) {
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
