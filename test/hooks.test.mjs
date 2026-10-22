import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { discoverRepository } from "../dist/repository.js";
import {
    addModel,
    readDecision,
    readHookStatus,
    readModels,
    settingsPath,
    writeDecision,
} from "../dist/settings.js";

const execute = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd, ...args) => execute("git", ["-C", cwd, ...args], { env });
const commit = (root, ...args) => git(root, "commit", "--allow-empty", ...args);
const message = async (root) => (await git(root, "log", "-1", "--format=%B")).stdout.trim();
const hookFile = async (root) =>
    (
        await git(
            root,
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks/prepare-commit-msg",
        )
    ).stdout.replace(/\n$/, "");

async function fixture(t, separate = false) {
    const directory = await mkdtemp("/tmp/opencode/trailmate-hooks-");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, "repository's files with spaces");
    await mkdir(root);
    await git(
        root,
        "init",
        "-q",
        ...(separate ? [`--separate-git-dir=${directory}/metadata`] : []),
    );
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "commit.gpgsign", "false");
    const repository = await discoverRepository(root);
    return { root, directory, repository };
}

async function script(file, contents) {
    await writeFile(file, `#!/bin/sh\n${contents}\n`);
    await chmod(file, 0o755);
}

test("enable installs only prepare-commit-msg, repair and disable leave Git config alone", async (t) => {
    const { root, repository } = await fixture(t);
    await git(root, "config", "core.hooksPath", ".user-hooks");
    await writeDecision(repository, true);
    assert.equal(await readHookStatus(repository), "installed");
    assert.deepEqual(await readdir(path.join(repository.commonDir, "trailmate")), [
        "hook.py",
        "settings.json",
    ]);
    await writeDecision(repository, true);
    await addModel(repository, "provider/model");
    const file = await hookFile(root);
    assert.deepEqual(await readdir(path.dirname(file)), ["prepare-commit-msg"]);
    await rm(file);
    await writeDecision(repository, true);
    await commit(root, "-qm", "first");
    assert.equal(await message(root), "first\n\nAssisted-by: provider/model");
    await writeDecision(repository, false);
    await writeDecision(repository, false);
    assert.equal(await readHookStatus(repository), "not installed in this worktree");
    assert.equal(
        (await git(root, "config", "--get", "core.hooksPath")).stdout.trim(),
        ".user-hooks",
    );
    assert.deepEqual(await readModels(repository), ["provider/model"]);
    assert.deepEqual(await readdir(path.dirname(settingsPath(repository))), ["settings.json"]);
    await commit(root, "-qm", "disabled");
    assert.equal(await message(root), "disabled");
});

test("existing prepare hooks fail enable without modifying files or settings", async (t) => {
    for (const kind of ["default", "relative", "absolute"]) {
        await t.test(kind, async (t) => {
            const { root, repository } = await fixture(t);
            const hooks =
                kind === "default"
                    ? path.join(repository.commonDir, "hooks")
                    : path.join(root, "user hooks");
            await mkdir(hooks, { recursive: true });
            if (kind !== "default")
                await git(
                    root,
                    "config",
                    "core.hooksPath",
                    kind === "relative" ? "user hooks" : hooks,
                );
            const file = await hookFile(root);
            await script(file, "exit 37");
            const contents = await readFile(file);
            await assert.rejects(
                writeDecision(repository, true),
                /prepare-commit-msg already exists/,
            );
            assert.equal(await readDecision(repository), "unknown");
            assert.deepEqual(await readFile(file), contents);
            assert.deepEqual(
                await readdir(hooks).then((files) =>
                    files.filter((file) => !file.endsWith(".sample")),
                ),
                ["prepare-commit-msg"],
            );
            await writeDecision(repository, false);
            assert.deepEqual(await readFile(file), contents);
            await assert.rejects(commit(root, "-qm", "still blocked by existing hook"));
        });
    }
});

test("-F, amend, sorted models and duplicate trailers", async (t) => {
    const { root, directory, repository } = await fixture(t);
    await writeDecision(repository, true);
    await addModel(repository, "z/model");
    await addModel(repository, "a/model");
    await git(root, "config", "trailer.Assisted-by.cmd", "false");
    await git(root, "config", "trailer.Surprise.cmd", "false");
    const file = path.join(directory, "message");
    await writeFile(
        file,
        "subject\n\nBody\n\nSigned-off-by: Test <test@example.com>\nAssisted-by: a/model\n",
    );
    await commit(root, "-qF", file);
    const first = await message(root);
    assert.equal(first.match(/Assisted-by: a\/model/g).length, 1);
    assert.ok(first.includes("Signed-off-by: Test <test@example.com>"));
    assert.ok(first.endsWith("Assisted-by: z/model"));
    await commit(root, "--amend", "--no-edit", "-q");
    assert.equal(await message(root), first);
});

test("unrelated hooks remain untouched and keep their normal behavior", async (t) => {
    const { root, repository } = await fixture(t);
    const directory = path.dirname(await hookFile(root));
    await script(path.join(directory, "pre-commit"), "touch pre-commit-ran");
    await script(path.join(directory, "commit-msg"), 'grep -q "Assisted-by: p/m" "$1"');
    const before = await Promise.all(
        ["pre-commit", "commit-msg"].map((file) => readFile(path.join(directory, file))),
    );
    await writeDecision(repository, true);
    await addModel(repository, "p/m");
    await commit(root, "-qm", "with existing hooks");
    await readFile(path.join(root, "pre-commit-ran"));
    await writeDecision(repository, false);
    const after = await Promise.all(
        ["pre-commit", "commit-msg"].map((file) => readFile(path.join(directory, file))),
    );
    assert.deepEqual(after, before);
});

test("editor sees initial trailers and may remove or replace them", async (t) => {
    const { root, directory, repository } = await fixture(t);
    await writeDecision(repository, true);
    await addModel(repository, "p/m");
    const editor = path.join(directory, "editor");
    await script(
        editor,
        'grep -q "Assisted-by: p/m" "$1" || exit 42\nprintf "User edited message\\n" > "$1"',
    );
    await execute("git", ["-C", root, "commit", "--allow-empty", "-q"], {
        env: { ...env, GIT_EDITOR: editor },
    });
    assert.equal(await message(root), "User edited message");
    await git(root, "config", "core.commentChar", ";");
    await execute("git", ["-C", root, "commit", "--allow-empty", "-q"], {
        env: { ...env, GIT_EDITOR: editor },
    });
    assert.equal(await message(root), "User edited message");
    await script(editor, 'printf "" > "$1"');
    await assert.rejects(
        execute("git", ["-C", root, "commit", "--allow-empty", "-q"], {
            env: { ...env, GIT_EDITOR: editor },
        }),
        /empty commit message/,
    );
});

test("merge, squash and rebase-generated messages are not annotated", async (t) => {
    const { root, repository } = await fixture(t);
    await commit(root, "-qm", "base");
    await git(root, "branch", "topic");
    await git(root, "checkout", "-q", "topic");
    await writeFile(path.join(root, "topic"), "topic");
    await git(root, "add", "topic");
    await git(root, "commit", "-qm", "topic");
    await git(root, "checkout", "-q", "-");
    await writeDecision(repository, true);
    await addModel(repository, "p/m");
    await git(root, "merge", "--no-ff", "topic", "-m", "merge");
    assert.equal(await message(root), "merge");
    await git(root, "reset", "--hard", "HEAD~1");
    await git(root, "merge", "--squash", "topic");
    await commit(root, "-qm", "squash");
    assert.equal(await message(root), "squash");
    await git(root, "checkout", "-q", "topic");
    await execute("git", ["-C", root, "rebase", "--force-rebase", "HEAD~1"], {
        env: { ...env, GIT_EDITOR: ":" },
    });
    assert.equal(await message(root), "topic");
});

test("linked worktrees and separate git directories use the right model set", async (t) => {
    const { root, directory, repository } = await fixture(t, true);
    await writeDecision(repository, true);
    await addModel(repository, "main/model");
    await commit(root, "-qm", "base");
    const linked = path.join(directory, "linked worktree");
    await git(root, "worktree", "add", "-qb", "linked", linked);
    const other = await discoverRepository(linked);
    await addModel(other, "linked/model");
    await commit(linked, "-qm", "linked");
    assert.equal(await message(linked), "linked\n\nAssisted-by: linked/model");
    await writeDecision(other, false);
    await assert.rejects(git(root, "config", "--local", "--get", "core.hooksPath"));
    assert.equal(await readDecision(repository), "disabled");
});

test("changed hook paths and multiple config values are preserved on disable", async (t) => {
    const { root, repository } = await fixture(t);
    await git(root, "config", "--add", "core.hooksPath", "first");
    await git(root, "config", "--add", "core.hooksPath", "second");
    await writeDecision(repository, true);
    await writeDecision(repository, false);
    assert.equal(
        (await git(root, "config", "--get-all", "core.hooksPath")).stdout,
        "first\nsecond\n",
    );
    await writeDecision(repository, true);
    await git(root, "config", "--replace-all", "core.hooksPath", "user-change");
    await writeDecision(repository, true);
    await writeDecision(repository, false);
    assert.equal(
        (await git(root, "config", "--get", "core.hooksPath")).stdout.trim(),
        "user-change",
    );
});

test("worktree-specific hook paths are used directly", async (t) => {
    const { root, repository } = await fixture(t);
    await git(root, "config", "extensions.worktreeConfig", "true");
    await git(root, "config", "--worktree", "core.hooksPath", ".custom");
    await writeDecision(repository, true);
    assert.equal(await readHookStatus(repository), "installed");
    assert.equal(await hookFile(root), path.join(root, ".custom", "prepare-commit-msg"));
    await writeDecision(repository, false);
    assert.equal(
        (await git(root, "config", "--worktree", "--get", "core.hooksPath")).stdout.trim(),
        ".custom",
    );
});

test("an interrupted installation can be retried or disabled", async (t) => {
    const { root, repository } = await fixture(t);
    const file = await hookFile(root);
    await mkdir(`${file}.tmp`);
    await assert.rejects(writeDecision(repository, true));
    assert.equal(await readDecision(repository), "disabled");
    await rm(`${file}.tmp`, { recursive: true });
    await writeDecision(repository, true);
    assert.equal(await readHookStatus(repository), "installed");
    await writeDecision(repository, false);
    await assert.rejects(git(root, "config", "--local", "--get", "core.hooksPath"));
});

test("hook paths in repository includes work without configuration changes", async (t) => {
    const { root, directory, repository } = await fixture(t);
    const inherited = path.join(directory, "inherited config");
    const hooks = path.join(root, "inherited hooks");
    await mkdir(hooks);
    await script(path.join(hooks, "post-commit"), "touch inherited-ran");
    await writeFile(inherited, '[core]\n\thooksPath = "inherited hooks"\n');
    await git(root, "config", "include.path", inherited);
    await writeDecision(repository, true);
    assert.equal(await readDecision(repository), "enabled");
    assert.equal(await readHookStatus(repository), "installed");
    await commit(root, "-qm", "inherited");
    await readFile(path.join(root, "inherited-ran"));
    await writeDecision(repository, false);
    assert.equal(
        (await git(root, "config", "--get", "core.hooksPath")).stdout.trim(),
        "inherited hooks",
    );
    await assert.rejects(git(root, "config", "--local", "--get", "core.hooksPath"));
});

test("tracked prepare hooks are left untouched", async (t) => {
    const { root, repository } = await fixture(t);
    await git(root, "config", "core.hooksPath", ".hooks");
    await mkdir(path.join(root, ".hooks"));
    const file = await hookFile(root);
    await script(file, "exit 0");
    const original = await readFile(file);
    await git(root, "add", ".hooks/prepare-commit-msg");
    await assert.rejects(writeDecision(repository, true), /prepare-commit-msg already exists/);
    assert.deepEqual(await readFile(file), original);
    assert.equal(await readDecision(repository), "unknown");
});

test("relative hooks in linked worktrees can each be enabled and are all removed on disable", async (t) => {
    const { root, directory, repository } = await fixture(t);
    await commit(root, "-qm", "base");
    await git(root, "config", "core.hooksPath", ".hooks");
    await writeDecision(repository, true);
    const linked = path.join(directory, "linked");
    await git(root, "worktree", "add", "-qb", "linked", linked);
    const other = await discoverRepository(linked);
    assert.equal(await readHookStatus(other), "not installed in this worktree");
    await writeDecision(other, true);
    await addModel(other, "linked/model");
    await commit(linked, "-qm", "linked");
    assert.equal(await message(linked), "linked\n\nAssisted-by: linked/model");
    await writeDecision(repository, false);
    await assert.rejects(readFile(await hookFile(root)));
    await assert.rejects(readFile(await hookFile(linked)));
});

test("a shared hooks directory does not annotate unrelated repositories", async (t) => {
    const first = await fixture(t);
    const second = await fixture(t);
    const shared = path.join(first.directory, "shared hooks");
    await mkdir(shared);
    await git(first.root, "config", "core.hooksPath", shared);
    await writeDecision(first.repository, true);
    await addModel(first.repository, "first/model");
    await writeDecision(second.repository, true);
    await addModel(second.repository, "second/model");
    await git(second.root, "config", "core.hooksPath", shared);
    await commit(second.root, "-qm", "other repository");
    assert.equal(await message(second.root), "other repository");
    await assert.rejects(
        writeDecision(second.repository, true),
        /prepare-commit-msg already exists/,
    );
    await writeDecision(first.repository, false);
    await commit(second.root, "-qm", "restored");
    assert.equal(await message(second.root), "restored");
});

test("installed hooks need only Git, shell and Python; corrupt settings do not suppress user hooks", async (t) => {
    const { root, directory, repository } = await fixture(t);
    const userHooks = path.join(repository.commonDir, "hooks");
    await script(path.join(userHooks, "pre-commit"), "touch user-hook-ran");
    await writeDecision(repository, true);
    await addModel(repository, "p/m");
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    // Symlinks are deliberately limited: no Node, Bun, npm or OpenCode.
    const { symlink } = await import("node:fs/promises");
    for (const name of ["git", "python3", "sh", "touch"]) {
        const { stdout } = await execute("which", [name]);
        await symlink(stdout.trim(), path.join(bin, name));
    }
    await execute(
        path.join(bin, "git"),
        ["-C", root, "commit", "--allow-empty", "-qm", "offline"],
        { env: { ...env, PATH: bin } },
    );
    assert.equal(await message(root), "offline\n\nAssisted-by: p/m");
    await rm(path.join(root, "user-hook-ran"));
    await writeFile(settingsPath(repository), "{");
    const result = await commit(root, "-qm", "corrupt settings");
    assert.match(result.stderr, /Trailmate:/);
    await readFile(path.join(root, "user-hook-ran"));
    assert.equal(await message(root), "corrupt settings");
});
