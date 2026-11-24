# Trailmate

Automatic AI attribution for Git commits as a standalone OpenCode extension. The intended workflow
is to record models responsible for file-changing steps and add `Assisted-by: provider/model`
trailers to prepared Git commit messages.

Trailmate assumes one writer per worktree. Attribution is based on changes between snapshots, so
overlapping tool calls or manual edits during an assistant step can credit the wrong model.

When a repository is opened in the TUI, a native dialog offers:

- **Enable all:** install the Git-hook integration in the current repository and its initialized
  submodules, recursively. Explicitly disabled children are left unchanged.
- **Enable selectively:** choose the current repository and/or initialized submodules from a toggle list.
- **Disable:** remove Trailmate's hook integration in the current repository, restore existing hooks,
  and remember the decision. Child repositories are left unchanged.
- **Scan for additional child repositories:** explicitly search the directory tree for other Git
  repositories, then open the toggle list. This may take awhile and can be canceled.
- **Later:** leave the preference unknown and ask next time the TUI starts.

In addition, the plugin provides a TUI for status inspection and state management. Use `/trailmate`
or the **Manage Trailmate** command-palette entry to open a native menu with the commands `status`,
`setup`, `list`, `clear`, and `toggle-auto-clear`. Choose `setup` to reopen the initial setup dialog.

If OpenCode opens in a directory outside Git, use `/trailmate` → `setup` to scan for Git
repositories below it and choose which ones to enable. There is no startup scan or opt-in prompt,
and no global discovery inventory. `status` and `clear` scan when opened; `list` and
`toggle-auto-clear` scan and let you pick a child.

Trailmate automatically clears the committing worktree's model list after each successful
commit by default. Choose **toggle-auto-clear** to turn this off or back on. The setting applies repository-wide,
including linked worktrees. Failed or cancelled commits retain the list; other worktrees'
lists are preserved. `status` shows the current setting. Clearing runs in a `post-commit`
hook, including for commits made outside OpenCode, and requires Trailmate to be enabled.

## Requirements

- OpenCode 2.1.3+ (2.x). OpenCode 1.18.4+ (1.x) is supported through alternative entrypoints.
- Git with `rev-parse --path-format=absolute` support (Git 2.31+).
- Python 3 and a POSIX shell on PATH for installation and Git hooks; verified on Linux.

Existing `prepare-commit-msg` and `post-commit` hooks are preserved with a `.trailmate-original` suffix
and run first, with their original interpreter and arguments. Trailmate appends attribution
only if the existing hook succeeds. Re-enabling does not duplicate the integration;
disabling restores the original hooks once no Trailmate integrations remain in that hook path.
An existing post-commit hook runs first; auto-clear also runs if that hook fails, since
the commit has already succeeded.

- Node.js 22+ and npm for **development builds and testing only**.

## Install from GitHub

Clone the repository into a permanent location:

```sh
git clone https://github.com/Nils-TUD/Trailmate.git ~/trailmate
```

OpenCode loads the TypeScript source directly; no build or dependency install
is needed.

### OpenCode 2.x (default)

Add the checkout directory as the server plugin in `~/.config/opencode/opencode.json`:

```json
{
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["file:///absolute/path/to/trailmate/src"]
}
```

### OpenCode 1.x (alternative)

Add the V1 server entrypoint to `~/.config/opencode/opencode.json`:

```json
{
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["file:///absolute/path/to/trailmate/src/server-v1.ts"]
}
```

Add the V1 TUI entrypoint to `~/.config/opencode/tui.json`:

```json
{
    "$schema": "https://opencode.ai/tui.json",
    "plugin": ["file:///absolute/path/to/trailmate/src/tui-v1.ts"]
}
```

Use the entrypoints matching your OpenCode major version. Both versions share repository
preferences, model attribution, and Git hooks. V2 tracks snapshot files from completed or failed
assistant steps; snapshots must be enabled. Server and terminal plugins need access to the same
local repository, as in V1.

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

Each Git repository's preferences and attribution are stored in a JSON file outside the worktree:

```text
<git-common-dir>/trailmate/settings.json
```

Here is an example `settings.json`:

```json
{
    "version": 1,
    "enabled": true,
    "clearAfterCommit": true,
    "models": {
        "/home/alice/project": ["openai/gpt-5"],
        "/home/alice/project-fix": ["anthropic/claude-sonnet-4-6"]
    }
}
```

Note that the models are tracked per worktree.
