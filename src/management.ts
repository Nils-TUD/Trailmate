import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { discoverRepository } from "./repository.js";
import {
    clearModels,
    readDecision,
    readHookStatus,
    readModels,
    writeDecision,
} from "./settings.js";

type Api = Parameters<TuiPlugin>[0];
const actions = ["status", "enable", "disable", "list", "clear"] as const;
type Action = (typeof actions)[number];

export function registerManagement(api: Api): void {
    const report = (result: string) => {
        api.ui.dialog.replace(() =>
            api.ui.DialogAlert({
                title: "AI attribution result",
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
                if (!repository) throw new Error("Attribution requires a Git worktree");

                // Never apply an old dialog's changes to a newly selected workspace.
                if (api.lifecycle.signal.aborted || api.state.path.directory !== directory) return;
                let result: string;
                if (action === "enable" || action === "disable") {
                    await writeDecision(repository, action === "enable");
                    result = `Attribution: ${action === "enable" ? "enabled" : "disabled"}`;
                } else if (action === "clear") {
                    await clearModels(repository);
                    result = "Model attribution cleared.";
                } else {
                    const models = (await readModels(repository)).join("\n") || "(no models)";
                    result =
                        action === "status"
                            ? `Attribution: ${await readDecision(repository)}\nRepository: ${repository.root}\nHook: ${await readHookStatus(repository)}\n${models}`
                            : models;
                }
                if (!api.lifecycle.signal.aborted && api.state.path.directory === directory) {
                    report(result);
                }
            } catch (error) {
                if (!api.lifecycle.signal.aborted) {
                    api.ui.toast({
                        variant: "error",
                        title: "AI attribution",
                        message: String(error),
                    });
                }
            }
        };

        api.ui.dialog.replace(() =>
            api.ui.DialogSelect<Action>({
                title: "Manage AI attribution",
                options: actions.map((action) => ({ title: action, value: action })),
                onSelect: ({ value }) => void run(value),
            }),
        );
    };

    // The documented v1 command API provides native slash/palette actions on
    // the supported 1.x hosts; selecting it never sends a prompt to a model.
    const unregister = api.command?.register(() => [
        {
            title: "Manage AI attribution",
            value: "opencode-auto-attr.manage",
            category: "AI attribution",
            slash: { name: "attribution" },
            onSelect: open,
        },
    ]);
    if (unregister) api.lifecycle.onDispose(unregister);
}
