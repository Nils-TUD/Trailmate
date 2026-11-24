import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { discoverRepository } from "../dist/repository.js";
import { discoverSubmodules, scanRepositories } from "../dist/discovery.js";
import { setupRepositories } from "../dist/setup.js";
import { clearRepositories } from "../dist/clear.js";
import { runWorkspaceAction } from "../dist/actions.js";
import { discoverWorkspace } from "../dist/workspace.js";
import { addModel, markSetupComplete, readClearAfterCommit, readDecision, readModels, readSetupComplete, toggleClearAfterCommit, writeDecision } from "../dist/settings.js";

const execute = promisify(execFile);
const git = (cwd, ...args) => execute("git", ["-C", cwd, ...args]);
const host = { current: () => true, progress: () => { } };

test("non-Git actions rescan without saving a global inventory", async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "trailmate-container-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = path.join(directory, "state");
    t.after(async () => {
        if (previous === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previous;
        await rm(directory, { recursive: true, force: true });
    });
    const root = path.join(directory, "container");
    const child = path.join(root, "child");
    await mkdir(child, { recursive: true });
    await git(child, "init", "-q");
    const workspace = await discoverWorkspace(root);
    const target = await discoverRepository(child);
    assert.equal(workspace.commonDir, undefined);
    const reports = [];
    const setup = setupHost(["scan", child, "apply"], reports);
    const select = setup.select;
    setup.select = (title, options) => {
        if (title.startsWith("Enable Trailmate?")) {
            assert.deepEqual(options.map(({ value }) => value), ["scan", "later"]);
        } else if (title.startsWith("Select repositories")) {
            assert.ok(!options.some(({ value }) => value === root));
        }
        return select(title, options);
    };
    assert.equal(await setupRepositories(workspace, setup), "configured");
    assert.equal(await discoverRepository(root), undefined);
    assert.equal(await readDecision(target), "enabled");
    assert.match(reports[0], /Enabled: child/);

    await addModel(target, "provider/model");
    const another = path.join(root, "another");
    await mkdir(another);
    await git(another, "init", "-q");
    const status = await runWorkspaceAction(workspace, "status", setupHost([], []));
    assert.match(status, /child: enabled; hook: installed; 1 pending model/);
    assert.match(status, /another: unknown/);
    const picker = setupHost([child, child], []);
    const pick = picker.select;
    picker.select = (title, options) => {
        if (title !== "Discovering Git repositories…") {
            assert.ok(options.some(({ value }) => value === another));
            assert.ok(!options.some(({ value }) => value === "scan"));
        }
        return pick(title, options);
    };
    assert.equal(await runWorkspaceAction(workspace, "list", picker), "provider/model");
    assert.match(await runWorkspaceAction(workspace, "toggle-auto-clear", picker), /disabled/);
    const clear = setupHost(["all", "confirm"], []);
    clear.notify = (message, failed) => assert.ok(!failed, message);
    assert.equal(await clearRepositories(workspace, clear), "done");
    assert.deepEqual(await readModels(target), []);
    assert.deepEqual(await readdir(directory), ["container"]);
});

test("Git worktree list and toggle pick from submodules, known children, and optional scan results", async (t) => {
    const { root, repository } = await fixture(t);
    const module = path.join(root, "module");
    const known = path.join(root, "known");
    const unknown = path.join(root, "unknown");
    for (const child of [module, known, unknown]) {
        await mkdir(child);
        await git(child, "init", "-q");
    }
    await git(module, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
    await git(root, "add", "module");
    await markSetupComplete(repository, [known]);
    const target = await discoverRepository(unknown);
    await writeDecision(target, true);
    await addModel(target, "provider/model");
    await toggleClearAfterCommit(target);

    const list = setupHost(["scan", unknown], []);
    const select = list.select;
    const menus = [];
    list.select = (title, options) => {
        if (title === "List pending models") menus.push(options.map(({ value }) => value));
        return select(title, options);
    };
    assert.equal(await runWorkspaceAction(repository, "list", list), "provider/model");
    assert.deepEqual(menus[0], [root, module, known, "scan", "cancel"]);
    assert.ok(menus[1].includes(unknown));

    const toggle = setupHost(["scan", unknown], []);
    const selectToggle = toggle.select;
    toggle.select = (title, options) => {
        if (title === "Toggle auto-clear") {
            assert.match(options.find(({ value }) => value === root).description, /enabled → disable/);
            const child = options.find(({ value }) => value === unknown);
            if (child) assert.match(child.description, /disabled → enable/);
        }
        return selectToggle(title, options);
    };
    assert.match(await runWorkspaceAction(repository, "toggle-auto-clear", toggle), /enabled/);
    assert.equal(await readClearAfterCommit(target), true);
    assert.equal(await readClearAfterCommit(repository), true);
});

async function fixture(t) {
    const directory = await mkdtemp(path.join(tmpdir(), "trailmate-discovery-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, "root");
    await mkdir(root);
    await git(root, "init", "-q");
    return { directory, root, repository: await discoverRepository(root) };
}

test("manual scan finds nested .git files and directories, but skips caches and symlinks", async (t) => {
    const { directory, root, repository } = await fixture(t);
    const nested = path.join(root, "nested");
    const separate = path.join(nested, "separate");
    const cache = path.join(root, ".cargo", "git", "checkouts", "cached");
    const ignored = path.join(root, "invalid");
    await mkdir(separate, { recursive: true });
    await mkdir(cache, { recursive: true });
    await mkdir(path.join(ignored, ".git"), { recursive: true });
    await git(nested, "init", "-q");
    await git(separate, "init", "-q", `--separate-git-dir=${path.join(directory, "metadata")}`);
    await git(cache, "init", "-q");
    await symlink(root, path.join(root, "loop"));
    const submodules = await discoverSubmodules(repository, host);
    assert.equal(submodules.candidates.length, 1);
    const result = await scanRepositories(repository, submodules, host);
    assert.deepEqual(new Set(result.candidates.map((item) => item.repository.root)), new Set([root, nested, separate]));
    assert.ok(result.skipped.some((item) => item.includes("cache exclusion")));
});

test("recursive submodule discovery finds initialized modules and reports missing checkouts", async (t) => {
    const { directory, root, repository } = await fixture(t);
    const source = path.join(directory, "source");
    await mkdir(source);
    await git(source, "init", "-q");
    await git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
    await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module");
    const module = path.join(root, "module");
    await git(module, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "inner");
    let result = await discoverSubmodules(repository, host);
    assert.deepEqual(result.candidates.map((item) => item.repository.root), [root, module, path.join(module, "inner")]);
    await git(root, "submodule", "deinit", "-f", "module");
    await rm(path.join(root, ".gitmodules"));
    await rm(module, { recursive: true });
    result = await discoverSubmodules(repository, host);
    assert.equal(result.candidates.length, 1);
    assert.ok(result.skipped.some((item) => item.includes("not initialized")));
});

test("submodule discovery follows the index even with missing or stale .gitmodules entries", async (t) => {
    const { root, repository } = await fixture(t);
    const name = "child with\ta tab\nand a newline";
    const child = path.join(root, name);
    const stale = path.join(root, "stale");
    for (const directory of [child, stale]) {
        await mkdir(directory);
        await git(directory, "init", "-q");
        await git(directory, "-c", "user.name=Test", "-c", "user.email=test@example.com",
            "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
    }
    await git(root, "add", "--", name);
    await writeFile(path.join(root, ".gitmodules"), '[submodule "stale"]\n\tpath = stale\n');

    const initial = await discoverSubmodules(repository, host);
    assert.deepEqual(initial.candidates.map(({ repository, kind }) => [repository.root, kind]), [
        [root, "current"], [child, "submodule"],
    ]);
    assert.deepEqual(initial.skipped, []);

    await git(root, "rm", "--cached", "-f", "--", name);
    const afterRemoval = await discoverSubmodules(repository, host);
    assert.equal(afterRemoval.candidates.length, 1);
    const scanned = await scanRepositories(repository, afterRemoval, host);
    assert.equal(scanned.candidates.find((item) => item.repository.root === child)?.kind, "nested repository");
});

test("conflicted gitlinks are reported once and not offered as submodules", async (t) => {
    const { root, repository } = await fixture(t);
    const child = path.join(root, "child");
    await mkdir(child);
    await git(child, "init", "-q");
    await git(child, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
    const { stdout } = await git(child, "rev-parse", "HEAD");
    const oid = stdout.trim();
    const input = `${[1, 2, 3].map((stage) => `160000 ${oid} ${stage}\tchild`).join("\n")}\n`;
    await new Promise((resolve, reject) => {
        const git = execFile("git", ["-C", root, "update-index", "--index-info"], (error) => {
            if (error) reject(error);
            else resolve();
        });
        git.stdin.end(input);
    });

    const result = await discoverSubmodules(repository, host);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.skipped, [`${child} (conflicted gitlink)`]);
});

function setupHost(choices, reports, titles = []) {
    let finish;
    return {
        ...host,
        select: async (title) => {
            titles.push(title);
            if (title === "Discovering Git repositories…") {
                return new Promise((resolve) => { finish = resolve; });
            }
            assert.ok(choices.length, `Unexpected dialog: ${title}`);
            return choices.shift();
        },
        close: () => finish?.(),
        report: async (message) => reports.push(message),
    };
}

test("selective scan can enable children without enabling the parent", async (t) => {
    const { root, repository } = await fixture(t);
    const child = path.join(root, "child");
    await mkdir(child);
    await git(child, "init", "-q");
    const reports = [];
    const result = await setupRepositories(repository, setupHost(["scan", root, child, "apply"], reports));
    assert.equal(result, "configured");
    assert.equal(await readDecision(repository), "unknown");
    assert.equal(await readSetupComplete(repository), true);
    assert.equal(await readDecision(await discoverRepository(child)), "enabled");
    assert.match(reports[0], /Enabled: child/);
});

test("setup does not recreate Git metadata removed while selecting repositories", async (t) => {
    const { root, repository } = await fixture(t);
    const child = path.join(root, "child");
    await mkdir(child);
    await git(child, "init", "-q");
    const reports = [];
    const ui = setupHost(["scan", child, "apply"], reports);
    const select = ui.select;
    const marker = path.join(child, ".git");
    ui.select = async (title) => {
        const choice = await select(title);
        if (choice === "apply") await rename(marker, path.join(child, "saved-git-dir"));
        return choice;
    };

    await setupRepositories(repository, ui);

    assert.match(reports[0], /Failed: child: .*no longer available/);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    assert.equal(await readDecision(repository), "enabled");
});

test("cancelling selective setup does not change existing preferences", async (t) => {
    const { root, repository } = await fixture(t);
    await writeDecision(repository, true);
    const reports = [];
    const titles = [];
    assert.equal(await setupRepositories(repository, setupHost(["select", root, "cancel", "later"], reports, titles)), "later");
    assert.equal(titles.filter((title) => title.startsWith("Enable Trailmate?")).length, 2);
    assert.equal(await readDecision(repository), "enabled");
    assert.equal(await readSetupComplete(repository), false);
    assert.deepEqual(reports, []);
});

for (const mode of ["select", "scan"]) {
    for (const cancel of ["cancel", undefined]) {
        test(`${mode} selection ${cancel ?? "Escape"} returns to setup and allows disabling`, async (t) => {
            const { repository } = await fixture(t);
            await writeDecision(repository, true);
            const reports = [];
            const titles = [];
            const result = await setupRepositories(repository, setupHost([mode, cancel, "disable"], reports, titles));
            assert.equal(result, "configured");
            assert.equal(titles.filter((title) => title.startsWith("Enable Trailmate?")).length, 2);
            assert.equal(await readDecision(repository), "disabled");
            assert.equal(await readSetupComplete(repository), false);
            assert.deepEqual(reports, []);
        });
    }
}

for (const mode of ["select", "scan"]) {
    for (const cancel of ["cancel", undefined]) {
        test(`${mode} discovery ${cancel ?? "Escape"} returns to setup without applying changes`, async (t) => {
            const { repository } = await fixture(t);
            const reports = [];
            const titles = [];
            const ui = setupHost([mode, "later"], reports, titles);
            const select = ui.select;
            ui.select = async (title, options) => {
                if (title === "Discovering Git repositories…") return cancel;
                return select(title, options);
            };
            assert.equal(await setupRepositories(repository, ui), "later");
            assert.equal(titles.filter((title) => title.startsWith("Enable Trailmate?")).length, 2);
            assert.equal(await readDecision(repository), "unknown");
            assert.equal(await readSetupComplete(repository), false);
            assert.deepEqual(reports, []);
        });
    }
}

test("a location switch during discovery exits instead of reopening setup", async (t) => {
    const { repository } = await fixture(t);
    const titles = [];
    const ui = setupHost(["scan"], [], titles);
    let current = true;
    ui.current = () => current;
    const select = ui.select;
    ui.select = async (title, options) => {
        if (title === "Discovering Git repositories…") {
            current = false;
            return undefined;
        }
        return select(title, options);
    };
    assert.equal(await setupRepositories(repository, ui), "later");
    assert.equal(titles.length, 1);
    assert.equal(await readDecision(repository), "unknown");
});

test("clear refreshes after individual clears and closes after confirmed bulk clear", async (t) => {
    const { root, repository } = await fixture(t);
    const nestedPath = path.join(root, "nested");
    await mkdir(nestedPath);
    await git(nestedPath, "init", "-q");
    const nested = await discoverRepository(nestedPath);
    for (const target of [repository, nested]) {
        await writeDecision(target, true);
        await addModel(target, "provider/model");
    }

    const notifications = [];
    const replies = ["scan", nestedPath, root, "all", undefined, "all", "confirm"];
    const menus = [];
    const ui = setupHost([], []);
    const select = ui.select;
    ui.select = async (title, options) => {
        if (title === "Discovering Git repositories…") return select(title, options);
        assert.ok(replies.length, `Unexpected dialog: ${title}`);
        if (title === "Clear pending attribution") menus.push(options);
        const reply = replies.shift();
        if (title.startsWith("Clear attribution in all")) {
            if (!reply) {
                await addModel(repository, "provider/new");
                await addModel(nested, "provider/new");
            } else {
                assert.deepEqual(await readModels(repository), ["provider/new"]);
                assert.deepEqual(await readModels(nested), ["provider/new"]);
            }
        }
        return reply;
    };
    ui.notify = (message) => notifications.push(message);

    assert.equal(await clearRepositories(repository, ui), "done");
    assert.equal(replies.length, 0);
    assert.equal(menus[0].some(({ value }) => value === nestedPath), false);
    assert.match(menus[1].find(({ value }) => value === nestedPath).description, /1 pending model/);
    assert.match(menus[2].find(({ value }) => value === nestedPath).description, /0 pending models/);
    assert.match(menus[3].find(({ value }) => value === root).description, /0 pending models/);
    assert.match(notifications.at(-1), /2 of 2 listed worktrees/);
    assert.deepEqual(await readModels(repository), []);
    assert.deepEqual(await readModels(nested), []);
    assert.equal(await readDecision(nested), "enabled");
    assert.equal(await readSetupComplete(repository), false);
});

test("canceling a clear scan returns to the clear list without changing attribution", async (t) => {
    const { repository } = await fixture(t);
    await writeDecision(repository, true);
    await addModel(repository, "provider/model");
    const titles = [];
    const ui = setupHost(["scan", undefined], [], titles);
    const select = ui.select;
    let discoveries = 0;
    ui.select = (title, options) => {
        if (title === "Discovering Git repositories…" && ++discoveries === 2) {
            return Promise.resolve(undefined);
        }
        return select(title, options);
    };
    ui.notify = () => assert.fail("Nothing should have been cleared");

    assert.equal(await clearRepositories(repository, ui), "back");
    assert.equal(titles.filter((title) => title === "Clear pending attribution").length, 2);
    assert.deepEqual(await readModels(repository), ["provider/model"]);
});

test("clear includes valid cached children without scanning for unknown ones", async (t) => {
    const { root, directory, repository } = await fixture(t);
    const known = path.join(root, "known");
    const unknown = path.join(root, "unknown");
    const stale = path.join(root, "stale");
    const outside = path.join(directory, "outside");
    for (const target of [known, unknown, stale, outside]) await mkdir(target);
    for (const target of [known, unknown, outside]) {
        await git(target, "init", "-q");
        const child = await discoverRepository(target);
        await writeDecision(child, true);
        await addModel(child, "provider/model");
    }
    await markSetupComplete(repository, [known, known, stale, outside]);

    const ui = setupHost(["all", "confirm"], []);
    const select = ui.select;
    ui.select = (title, options) => {
        if (title === "Clear pending attribution") {
            assert.deepEqual(options.map(({ value }) => value), [root, known, "all", "scan", "cancel"]);
            assert.match(options[1].description, /1 pending model/);
        }
        return select(title, options);
    };
    ui.notify = (message, error) => assert.equal(error, false, message);

    assert.equal(await clearRepositories(repository, ui), "done");
    assert.deepEqual(await readModels(await discoverRepository(known)), []);
    for (const target of [unknown, outside]) {
        assert.deepEqual(await readModels(await discoverRepository(target)), ["provider/model"]);
    }
});
