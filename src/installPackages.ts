import { constants } from "buffer";
import cp = require("child_process");
import fs = require("fs");
import globCps = require("glob");
import json5 = require("json5");
import path = require("path");
import yaml = require("js-yaml");

export async function installDependencies(project: string, quietOutput: boolean, recursiveSearch: boolean, packageTimeout: number): Promise<void> {
    const commands = await getInstallPackagesCommands(project, quietOutput, recursiveSearch);
    await installPackages(project, commands, packageTimeout);
}

/**
 * String value will be the unqualified command name.
 */
export enum InstallTool {
    Npm = "npm",
    Yarn = "yarn",
    Pnpm = "pnpm",
}

export interface InstallCommand {
    directory: string;
    prettyDirectory: string;
    tool: InstallTool;
    arguments: readonly string[];
}

/**
 * Traverses the given directory and returns a list of commands that can be used, in order, to install
 * the packages required for building.
 */
export async function getInstallPackagesCommands(repoDir: string, quietOutput: boolean, recursiveSearch: boolean, monorepoPackages?: readonly string[], types?: string[]): Promise<InstallCommand[]> {
    monorepoPackages = monorepoPackages ?? await getMonorepoOrder(repoDir);

    const repoName = path.basename(repoDir);

    const isRepoYarn = await exists(path.join(repoDir, "yarn.lock"));
    // The existence of .yarnrc.yml indicates that this repo uses yarn 2
    const isRepoYarn2 = await exists(path.join(repoDir, ".yarnrc.yml"));
    const isRepoPnpm = await exists(path.join(repoDir, "pnpm-lock.yaml"));

    const commands: InstallCommand[] = [];

    const globPattern = recursiveSearch ? "**/package.json" : "package.json";
    const packageFiles = glob(repoDir, globPattern);

    for (const packageFile of packageFiles) {
        let inMonorepoPackageDir = false;
        for (const monorepoPackage of monorepoPackages) {
            if (inMonorepoPackageDir = packageFile.startsWith(monorepoPackage)) break;
        }
        if (inMonorepoPackageDir) {
            // Skipping installation of monorepo package
            continue;
        }

        // CONSIDER: If we're ignoring scripts, there are lerna packages, and we're not
        // using yarn workspaces, we might want to `lerna bootstrap`.  In practice,
        // this has not proven to be necessary, since this combination is uncommon.

        const packageRoot = path.dirname(packageFile);

        // Heuristic, these are rarely valuable and often fail.
        if (/fixtures?/i.test(packageRoot)) {
            continue;
        }

        let tool: InstallTool;
        let args: string[];

        const isProjectYarn2 = isRepoYarn2 || await exists(path.join(packageRoot, ".yarnrc.yml"));
        if (isProjectYarn2 ||
            await exists(path.join(packageRoot, "yarn.lock")) ||
            (isRepoYarn && !(await exists(path.join(packageRoot, "package-lock.json"))))) {
            tool = InstallTool.Yarn;

            // Yarn 2 dropped support for most `install` arguments
            if (isProjectYarn2) {
                // TODO: this seems to be called --skip-build in yarn 3 - we might want to try to distinguish
                args = ["install", "--no-immutable", "--mode=skip-build"];
            }
            else {
                args = ["install", "--ignore-engines", "--ignore-scripts"];

                if (quietOutput) {
                    args.push("--silent");
                }
            }
        }
        else if (isRepoPnpm || await exists(path.join(packageRoot, "pnpm-lock.yaml"))) {
            tool = InstallTool.Pnpm;
            args = ["install", "--no-frozen-lockfile", "--prefer-offline", "--ignore-scripts"];

            if (quietOutput) {
                args.push("--reporter=silent");
            }

        }
        else if (await exists(path.join(packageRoot, "package.json"))) {
            tool = InstallTool.Npm;

            const haveLock = await exists(path.join(packageRoot, "package-lock.json")) ||
                await hasCurrentShrinkwrap(packageRoot);

            args = [haveLock ? "ci" : "install", "--prefer-offline", "--no-audit", "--no-progress", "--legacy-peer-deps", "--ignore-scripts"];

            if (quietOutput) {
                args.push("-q");
            }
        }
        else {
            continue;
        }

        const prettyDirectory = path.join(repoName, path.relative(repoDir, packageRoot));

        commands.push({
            directory: packageRoot,
            prettyDirectory,
            tool,
            arguments: args,
        });

        if (types && types.length > 0) {
            // `types` is only present for user tests and all known user tests use npm, not yarn
            // Besides, we're using --no-save, so it shouldn't matter which tool we use
            const typesPackageNames = types.map(t => `@types/${t}`);
            const args = ["install", ...typesPackageNames, "--no-save", "--ignore-scripts", "--legacy-peer-deps"];

            commands.push({
                directory: packageRoot,
                prettyDirectory,
                tool: InstallTool.Npm,
                arguments: args
            });
        }
    }

    return commands;
}

async function hasCurrentShrinkwrap(packageRoot: string): Promise<boolean> {
    if (!exists(path.join(packageRoot, "npm-shrinkwrap.json"))) {
        return false;
    }
    
    try {
        const contents = await fs.promises.readFile(path.join(packageRoot, "npm-shrinkwrap.json"), { encoding: "utf-8" });
        const value = json5.parse(contents);
        return +value.lockfileVersion >= 1;
    }
    catch {
        return false;
    }
}

async function installPackages(repoDir: string, commands: readonly InstallCommand[], timeoutMs: number) {
    let usedYarn = false;

    const installEnv: Record<string, string> = {
        ...process.env,
        // yarn2 produces extremely verbose output unless CI=true is set and it should be harmless for yarn1 and npm
        CI: "true",
        YARN_ENABLE_SCRIPTS: "false",
        npm_config_ignore_scripts: "true",
        npm_config_allow_git: "none",
        // pnpm reads npm_config_* too, but not in 11+
        pnpm_config_ignore_scripts: "true",
        // Block git-protocol dependencies entirely.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "protocol.allow",
        GIT_CONFIG_VALUE_0: "never",
    };

    try {
        let timedOut = false;
        const startMs = performance.now();
        for (const { directory: packageRoot, tool, arguments: args } of commands) {
            if (timedOut) break;

            usedYarn = usedYarn || tool === InstallTool.Yarn;

            const elapsedMs = performance.now() - startMs;
            const packageRootDescription = packageRoot.substring(repoDir.length + 1) || "root directory";

            const spawnResult = await spawnWithTimeoutAsync(packageRoot, tool, args, timeoutMs - elapsedMs, installEnv);
            if (!spawnResult) {
                throw new Error(`Timed out after ${timeoutMs} ms`);
            }

            if (spawnResult.code || spawnResult.signal) {
                if (tool === InstallTool.Npm && args[0] === "ci" && /update your lock file/.test(spawnResult.stderr)) {
                    const elapsedMs2 = performance.now() - startMs;
                    const args2 = args.slice();
                    args2[0] = "install";
                    const spawnResult2 = await spawnWithTimeoutAsync(packageRoot, tool, args2, timeoutMs - elapsedMs2, installEnv);
                    if (spawnResult2 && !spawnResult2.code && !spawnResult2.signal) {
                        continue; // Succeeded on retry
                    }
                }

                const errorText = `Exited with ${spawnResult.code ? `code ${spawnResult.code}` : `signal ${spawnResult.signal}`}
${spawnResult.stdout.trim() || "No stdout"}\n${spawnResult.stderr.trim() || "No stderr"}`;

                if (!/ENOSPC/.test(errorText) && (/(?:ex|s)amples?\//i.test(packageRootDescription) || /tests?\//i.test(packageRootDescription))) {
                    console.log(`Ignoring package install error from non-product folder ${packageRootDescription}:`);
                    console.log(insetLines(reduceSpew(errorText)));
                }
                else {
                    throw new Error(`Failed to install packages for ${packageRootDescription}:\n${errorText}`);
                }
            }
        }
    }
    finally {
        if (usedYarn) {
            await execAsync(repoDir, "yarn cache clean --all");
        }
    }
}

// === Shared helpers ===

/**
 * Returns true if the path exists.
 */
export async function exists(path: string): Promise<boolean> {
    return new Promise(resolve => fs.exists(path, e => resolve(e)));
}

/**
 * `glob`, but ignoring node_modules and symlinks, and returning absolute paths.
 */
export function glob(cwd: string, pattern: string): string[] {
    return globCps.sync(pattern, { cwd, absolute: true, ignore: "**/node_modules/**", follow: false })
}

/**
 * Heuristically returns a list of package.json paths in monorepo dependency order.
 * NB: Does not actually consume lerna.json.
 */
export async function getMonorepoOrder(repoDir: string): Promise<readonly string[]> {
    const yarnOrNpmLockFiles = glob(repoDir, "**/{yarn.lock,package-lock.json}");
    if (yarnOrNpmLockFiles.length) {
        const workspaceOrder: string[] = [];
        for (const lockFile of yarnOrNpmLockFiles) {
            const dir = path.dirname(lockFile);
            const pkgPath = path.join(dir, "package.json");
            if (await exists(pkgPath)) {
                const contents = await fs.promises.readFile(pkgPath, { encoding: "utf-8" });
                const pkg: Package = json5.parse(contents);
                const workspaces = pkg.workspaces;
                if (workspaces) {
                    const workspaceDirs = "packages" in workspaces ? workspaces.packages : workspaces;
                    for (const workspaceDir of workspaceDirs) {
                        // workspaceDir might end with `/*` - glob will do the right thing
                        const pkgPaths = glob(dir, path.join(workspaceDir, "package.json"));
                        await appendOrderedMonorepoPackages(pkgPaths, workspaceOrder);
                    }
                }
            }
        }
        if (workspaceOrder.length) {
            return workspaceOrder;
        }
    }

    const pnpmWorkspaceFiles = glob(repoDir, "**/pnpm-workspace.yaml");
    if (pnpmWorkspaceFiles.length) {
        const pnpmWorkspaceOrder: string[] = [];
        for (const pnpmWorkspaceFile of pnpmWorkspaceFiles) {
            const contents = await fs.promises.readFile(pnpmWorkspaceFile, { encoding: "utf-8" });
            const config = yaml.load(contents) as { packages?: string[] } | undefined; // undefined for an empty test fixture
            const workspaceDirs = config?.packages;
            if (workspaceDirs) {
                const pnpmDir = path.dirname(pnpmWorkspaceFile);
                for (const workspaceDir of workspaceDirs) {
                    // CONSIDER: Should technically exclude those beginning with `!`
                    if (workspaceDir.startsWith("!")) continue;
                        // workspaceDir might end with `/*` - glob will do the right thing
                    const pkgPaths = glob(pnpmDir, path.join(workspaceDir, "package.json"));
                    await appendOrderedMonorepoPackages(pkgPaths, pnpmWorkspaceOrder);
                }
            }
        }
        if (pnpmWorkspaceOrder.length) {
            return pnpmWorkspaceOrder;
        }
    }

    const lernaFiles = glob(repoDir, "**/lerna.json");
    if (lernaFiles.length) {
        const lernaOrder: string[] = [];
        for (const lernaFile of lernaFiles) {
            const lernaDir = path.dirname(lernaFile);
            if (await exists(path.join(lernaDir, "packages"))) {
                const pkgPaths = glob(path.join(lernaDir, "packages"), "**/package.json");
                await appendOrderedMonorepoPackages(pkgPaths, lernaOrder);
            }
        }
        if (lernaOrder.length) {
            return lernaOrder;
        }
    }

    return [];
}

interface Package {
    meta_dir: string,
    meta_state: "unvisited" | "visiting" | "visited",
    name: string,
    workspaces?: readonly string[] | { packages: readonly string[] },
    dependencies?: readonly string[],
    devDependencies?: readonly string[],
    peerDependencies?: readonly string[],
}

async function appendOrderedMonorepoPackages(pkgPaths: string[], monorepoOrder: string[]) {
    const pkgs = await Promise.all(pkgPaths.map(async (pkgPath) => {
        const contents = await fs.promises.readFile(pkgPath, { encoding: "utf-8" });
        const pkg: Package = json5.parse(contents);
        pkg.meta_dir = path.dirname(pkgPath);
        pkg.meta_state = "unvisited";
        return pkg;
    }));
    const pkgMap: Record<string, Package | undefined> = {};
    for (const pkg of pkgs) {
        pkgMap[pkg.name] = pkg;
    }

    while (true) {
        const pkg = pkgs.find(p => p.meta_state === "unvisited");
        if (!pkg) break;
        visit(pkg);
    }

    function visit(pkg: Package): void {
        // "visiting" indicates a cycle, which some monorepo systems (e.g. lerna) allow
        if (pkg.meta_state !== "unvisited") return;

        pkg.meta_state = "visiting";

        if (pkg.dependencies) {
            for (const dep in pkg.dependencies) {
                const depPkg = pkgMap[dep];
                if (depPkg) visit(depPkg);
            }
        }

        if (pkg.devDependencies) {
            for (const dep in pkg.devDependencies) {
                const depPkg = pkgMap[dep];
                if (depPkg) visit(depPkg);
            }
        }

        if (pkg.peerDependencies) {
            for (const dep in pkg.peerDependencies) {
                const depPkg = pkgMap[dep];
                if (depPkg) visit(depPkg);
            }
        }

        pkg.meta_state = "visited";
        monorepoOrder.push(pkg.meta_dir);
    }
}

export interface SpawnResult {
    stdout: string,
    stderr: string,
    code: number | null,
    signal: NodeJS.Signals | null,
}

/** Returns undefined if and only if executions times out. */
export function spawnWithTimeoutAsync(cwd: string, command: string, args: readonly string[], timeoutMs: number, env?: {}): Promise<SpawnResult | undefined> {
    console.log(`${cwd}> ${command} ${args.join(" ")}`);
    return new Promise<SpawnResult | undefined>((resolve, reject) => {
        if (timeoutMs <= 0) {
            resolve(undefined);
            return;
        }

        // We use `spawn`, rather than `execFile`, because package installation tends to write a lot
        // of data to stdout, overflowing `execFile`'s buffer.
        const childProcess = cp.spawn(command, args, {
            cwd,
            env,
            windowsHide: true,
        });

        let timedOut = false;

        let stdout = "";
        let stderr = "";

        childProcess.once("close", (code, signal) => {
            if (!timedOut) {
                clearTimeout(timeout);
                resolve({ stdout, stderr, code, signal });
            }
        });

        childProcess.stdout.on("data", data => {
            stdout = cappedAppend(stdout, data);
        });

        childProcess.stderr.on("data", data => {
            stderr = cappedAppend(stderr, data);
        });

        const timeout = setTimeout(async () => {
            timedOut = true;
            await killTree(childProcess);
            resolve(undefined);
        }, timeoutMs | 0); // Truncate to int
    });
}

function killTree(childProcess: cp.ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        // Ideally, we would wait for all of the processes to close, but we only get events for
        // this one, so we'll kill it last and hope for the best.
        childProcess.once("close", () => {
            resolve();
        });

        cp.exec("ps -e -o pid,ppid --no-headers", (err, stdout) => {
            if (err) {
                reject (err);
                return;
            }

            const childProcessPid = childProcess.pid!;
            let sawChildProcessPid = false;

            const childMap: Record<number, number[]> = {};
            const pidList = stdout.trim().split(/\s+/);
            for (let i = 0; i + 1 < pidList.length; i += 2) {
                const childPid = +pidList[i];
                const parentPid = +pidList[i + 1];

                childMap[parentPid] ||= [];
                childMap[parentPid].push(childPid);

                sawChildProcessPid ||= childPid === childProcessPid;
            }

            if (!sawChildProcessPid) {
                // Descendent processes may still be alive, but we have no way to identify them
                resolve();
                return;
            }

            const strictDescendentPids: number[] = [];
            const stack: number[] = [ childProcessPid ];
            while (stack.length) {
                const pid = stack.pop()!;
                if (pid !== childProcessPid) {
                    strictDescendentPids.push(pid);
                }
                const children = childMap[pid];
                if (children) {
                    stack.push(...children);
                }
            }

            console.log(`Killing process ${childProcessPid} and its descendents: ${strictDescendentPids.join(", ")}`);

            strictDescendentPids.forEach(pid => process.kill(pid));
            childProcess.kill();
            // Resolve when we detect that childProcess has closed (above)
        });
    });
}

const MAX_LENGTH = constants.MAX_STRING_LENGTH;
const TRUNCATION_MESSAGE = "\n...truncated...\n";

function cappedAppend(current: string, data: string): string {
    if (current.length + data.length <= MAX_LENGTH) {
        return current + data;
    }
    // Truncate before appending to avoid exceeding the limit.
    // Preserve the tail of the output.
    const hasTruncationMessage = current.startsWith(TRUNCATION_MESSAGE);
    const available = hasTruncationMessage ? MAX_LENGTH : MAX_LENGTH - TRUNCATION_MESSAGE.length;
    const tail = data.length >= available
        ? data.slice(data.length - available)
        : current.slice(current.length - (available - data.length)) + data;
    return hasTruncationMessage ? tail : TRUNCATION_MESSAGE + tail;
}

export async function execAsync(cwd: string, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        console.log(`${cwd}> ${command}`);
        cp.exec(command, { cwd }, (err, stdout, stderr) => {
            if (stdout?.length) {
                console.log(stdout);
            }
            if (stderr?.length) {
                console.log(stderr); // To stdout to maintain order
            }

            if (err) {
                return reject(err);
            }
            return resolve(stdout);
        });
    });
}

function insetLines(text: string): string {
    return text.trimEnd().replace(/(^|\n)/g, "$1> ");
}

function reduceSpew(message: string): string {
    // These are uninteresting in general and actually problematic when there are
    // thousands of instances of ENOSPC (which also appears as an error anyway)
    return message.replace(/npm WARN.*\n/g, "");
}