import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { discoverRepository } from "../dist/repository.js";
import { discoverSubmodules, scanRepositories } from "../dist/discovery.js";
import { setupRepositories } from "../dist/setup.js";
import { readDecision, readSetupComplete, writeDecision } from "../dist/settings.js";

const execute = promisify(execFile);
const git = (cwd, ...args) => execute("git", ["-C", cwd, ...args]);
const host = { current: () => true, progress: () => { } };

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
