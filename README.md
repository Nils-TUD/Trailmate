# Trailmate

Automatic AI attribution for Git commits as a standalone OpenCode extension. The intended workflow
is to record models responsible for file-changing steps and add `Assisted-by: provider/model`
trailers to prepared Git commit messages.

When a repository is opened in the TUI, a native dialog offers:

- **Enable:** install the Git-hook integration and remember decision.
- **Disable:** remove the installed prepare hook and remember decision.
- **Later:** leave the preference unknown and ask next time the TUI starts.

In addition, the plugin provides a TUI for status inspection and state management. Use `/trailmate`
or the **Manage Trailmate** command-palette entry to open a native menu with the commands `status`,
`enable`, `disable`, `list`, and `clear`.

## Requirements

- OpenCode 1.18.4 or newer in the 1.x series.
- Git with `rev-parse --path-format=absolute` support (Git 2.31+).
- Python 3 and a POSIX shell on PATH for installation and Git hooks; verified on Linux.
- Node.js 22+ and npm for **development builds and testing only**.

## Install from GitHub

1. Clone the repository into a permanent location:

    ```sh
    git clone https://github.com/Nils-TUD/Trailmate.git ~/trailmate
    ```

    OpenCode loads the TypeScript source directly; no build or dependency install
    is needed.

2. Add the server plugin to `~/.config/opencode/opencode.json`:

    ```json
    {
        "$schema": "https://opencode.ai/config.json",
        "plugin": ["file:///absolute/path/to/trailmate/src/server.ts"]
    }
    ```

3. Add the TUI plugin to `~/.config/opencode/tui.json`:

    ```json
    {
        "$schema": "https://opencode.ai/tui.json",
        "plugin": ["file:///absolute/path/to/trailmate/src/tui.ts"]
    }
    ```

Keep the checkout in place. **Quit and restart OpenCode** after installation, then choose **Enable**
when Trailmate prompts you in a repository.

## Build from source (developers)

```sh
npm ci
npm run build
```

The following checks are available:

```sh
npm run format:check
npm run check
npm test
```

## Internals

All plugin state is stored in one repository-wide JSON file outside the worktree:

```text
<git-common-dir>/trailmate/settings.json
```

Here is an example `settings.json`:

```json
{
    "version": 1,
    "enabled": true,
    "models": {
        "/home/alice/project": ["openai/gpt-5"],
        "/home/alice/project-fix": ["anthropic/claude-sonnet-4-6"]
    }
}
```

Note that the models are tracked per worktree.
