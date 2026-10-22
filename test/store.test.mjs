import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { discoverRepository } from "../dist/repository.js";
import {
    clearModels,
    readDecision,
    readModels,
    settingsPath,
    writeDecision,
} from "../dist/settings.js";
import { registerManagement } from "../dist/management.js";

const execute = promisify(execFile);
const git = (cwd, ...args) => execute("git", ["-C", cwd, ...args]);

async function fixture(t) {
    const directory = await mkdtemp("/tmp/opencode/auto-attr-store-");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, "repository with spaces");
    await mkdir(root);
    await git(root, "init", "-q");
    return { directory, root, repository: await discoverRepository(root) };
}

async function seedModels(repository, models) {
    const file = settingsPath(repository);
    await mkdir(path.dirname(file), { recursive: true });
    let settings;
    try {
        settings = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        settings = { version: 1, enabled: null, models: {} };
    }
    settings.models[repository.root] = models;
    await writeFile(file, JSON.stringify(settings));
}

test("one JSON file stores preferences and sorted, deduplicated worktree models", async (t) => {
    const { repository } = await fixture(t);
    assert.deepEqual(await readModels(repository), []);
    const models = ["z/legacy", "a/vendor/model", "z/legacy"];
    await seedModels(repository, models);
    const contents = await readFile(settingsPath(repository), "utf8");
    assert.deepEqual(await readModels(repository), ["a/vendor/model", "z/legacy"]);
    assert.equal(await readFile(settingsPath(repository), "utf8"), contents);

    await writeDecision(repository, false);
    assert.deepEqual(
        JSON.parse(await readFile(settingsPath(repository), "utf8")).models[repository.root],
        models,
    );
    await clearModels(repository);
    await clearModels(repository);
    assert.deepEqual(await readModels(repository), []);
    assert.deepEqual(JSON.parse(await readFile(settingsPath(repository), "utf8")), {
        version: 1,
        enabled: false,
        models: {},
    });
});

test("linked worktrees share settings but clearing models stays worktree-local", async (t) => {
    const { root, directory, repository } = await fixture(t);
    await git(
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
    );
    const linked = path.join(directory, "linked worktree");
    await git(root, "worktree", "add", "-qb", "linked", linked);
    const other = await discoverRepository(linked);
    await seedModels(repository, ["original/model"]);
    await seedModels(other, ["linked/model"]);
    await writeDecision(other, true);
    assert.equal(await readDecision(repository), "enabled");
    await clearModels(other);
    assert.deepEqual(await readModels(other), []);
    assert.deepEqual(await readModels(repository), ["original/model"]);
    assert.equal(settingsPath(repository), settingsPath(other));

    // Separate OpenCode processes must not overwrite another worktree's clear
    // or resurrect its old models while changing the shared preference.
    await seedModels(other, ["linked/model"]);
    const module = new URL("../dist/settings.js", import.meta.url).href;
    const run = (repository, action) =>
        execute(process.execPath, [
            "--input-type=module",
            "-e",
            `import { clearModels, writeDecision } from ${JSON.stringify(module)};
         const repository = JSON.parse(process.argv[1]);
         for (let i = 0; i < 8; i++) {
             if (process.argv[2] === 'clear') await clearModels(repository);
             else await writeDecision(repository, false);
         }`,
            JSON.stringify(repository),
            action,
        ]);
    await Promise.all([run(repository, "clear"), run(other, "clear"), run(other, "disable")]);
    assert.deepEqual(await readModels(repository), []);
    assert.deepEqual(await readModels(other), []);
    assert.equal(await readDecision(repository), "disabled");
});

test("settings preserve extra fields and refuse to overwrite corrupt state", async (t) => {
    const { repository } = await fixture(t);
    await writeDecision(repository, true);
    await writeFile(settingsPath(repository), '{"version":1,"enabled":true,"extra":{"keep":1}}');
    await writeDecision(repository, false);
    assert.deepEqual(JSON.parse(await readFile(settingsPath(repository), "utf8")), {
        version: 1,
        enabled: false,
        models: {},
        extra: { keep: 1 },
    });
    for (const contents of ["{", '{"version":2,"enabled":true}', Buffer.from([0xff])]) {
        await writeFile(settingsPath(repository), contents);
        await assert.rejects(writeDecision(repository, true), /Invalid/);
        assert.deepEqual(await readFile(settingsPath(repository)), Buffer.from(contents));
    }
});

test("concurrent decisions publish complete settings and leave no temporary files", async (t) => {
    const { repository } = await fixture(t);
    await writeDecision(repository, true);
    await seedModels(repository, ["p/model"]);
    const otherRoot = path.join(repository.root, "other worktree");
    await seedModels({ ...repository, root: otherRoot }, ["other/model"]);
    await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => writeDecision(repository, !!(i % 2))),
        ...Array.from({ length: 20 }, () => readDecision(repository)),
        clearModels(repository),
        clearModels(repository),
    ]);
    assert.ok(["enabled", "disabled"].includes(await readDecision(repository)));
    assert.deepEqual(await readModels(repository), []);
    assert.deepEqual(
        await readdir(path.dirname(settingsPath(repository))),
        (await readDecision(repository)) === "enabled"
            ? ["hook.py", "settings.json"]
            : ["settings.json"],
    );
    assert.deepEqual(JSON.parse(await readFile(settingsPath(repository), "utf8")).models, {
        [otherRoot]: ["other/model"],
    });
});

test("clearing an undecided repository preserves unknown opt-in", async (t) => {
    const { repository } = await fixture(t);
    await clearModels(repository);
    assert.equal(await readDecision(repository), "unknown");
    assert.deepEqual(JSON.parse(await readFile(settingsPath(repository), "utf8")), {
        version: 1,
        enabled: null,
        models: {},
    });
});

test("contention is bounded and does not delete another writer's lock", async (t) => {
    const { repository } = await fixture(t);
    await writeDecision(repository, true);
    const lock = `${settingsPath(repository)}.lock`;
    await writeFile(lock, "held");
    await assert.rejects(
        writeDecision(repository, false),
        /Timed out waiting for attribution lock/,
    );
    assert.equal(await readDecision(repository), "enabled");
    assert.equal(await readFile(lock, "utf8"), "held");
    await rm(lock);
    await writeDecision(repository, false);
    assert.equal(await readDecision(repository), "disabled");
});

test("native management provides only status, enable, disable, list and clear", async (t) => {
    const { root, repository } = await fixture(t);
    await seedModels(repository, ["existing/model"]);
    let commands;
    let dialog;
    let complete;
    let dispose;
    const api = {
        state: { path: { directory: root } },
        lifecycle: {
            signal: new AbortController().signal,
            onDispose: (fn) => {
                dispose = fn;
            },
        },
        command: {
            register: (get) => {
                commands = get();
                return () => {
                    commands = [];
                };
            },
        },
        ui: {
            DialogSelect: (props) => props,
            DialogAlert: (props) => {
                complete(props);
                return props;
            },
            toast: (input) => assert.fail(input.message),
            dialog: {
                replace: (render) => {
                    dialog = render();
                },
                clear: () => {},
            },
        },
    };
    registerManagement(api);
    assert.equal(commands[0].slash.name, "attribution");
    const actions = ["status", "enable", "disable", "list", "clear"];
    for (const action of actions) {
        const result = new Promise((resolve) => {
            complete = resolve;
        });
        commands[0].onSelect();
        assert.deepEqual(
            dialog.options.map(({ value }) => value),
            actions,
        );
        dialog.onSelect({ value: action });
        const { message } = await result;
        if (action === "status") assert.match(message, /^Attribution: unknown\n/);
        if (action === "enable") assert.equal(await readDecision(repository), "enabled");
        if (action === "disable") assert.equal(await readDecision(repository), "disabled");
        if (action === "list") assert.equal(message, "existing/model");
        if (action === "clear") assert.deepEqual(await readModels(repository), []);
    }
    dispose();
    assert.deepEqual(commands, []);
});
