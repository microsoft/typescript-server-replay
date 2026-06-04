import fs = require("fs");
import globCps = require("glob");
import json5 = require("json5");
import path = require("path");

export async function installDependencies(project: string): Promise<void> {
    // TODO: Implement dependency installation for the repro project at `project`.
    throw new Error(`'install' command is not yet implemented (project: ${project})`);
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
export async function installPackages(repoDir: string, ignoreScripts: boolean, quietOutput: boolean, recursiveSearch: boolean, monorepoPackages?: readonly string[], types?: string[]): Promise<InstallCommand[]> {
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
                args = ["install", "--no-immutable"]

                if (ignoreScripts) {
                    // TODO: this seems to be called --skip-build in yarn 3 - we might want to try to distinguish
                    args.push("--mode=skip-build");
                }
            }
            else {
                args = ["install", "--ignore-engines"];

                if (ignoreScripts) {
                    args.push("--ignore-scripts");
                }

                if (quietOutput) {
                    args.push("--silent");
                }
            }
        }
        else if (isRepoPnpm || await exists(path.join(packageRoot, "pnpm-lock.yaml"))) {
            tool = InstallTool.Pnpm;
            args = ["install", "--no-frozen-lockfile", "--prefer-offline"];

            if (ignoreScripts) {
                args.push("--ignore-scripts");
            }

            if (quietOutput) {
                args.push("--reporter=silent");
            }

        }
        else if (await exists(path.join(packageRoot, "package.json"))) {
            tool = InstallTool.Npm;

            const haveLock = await exists(path.join(packageRoot, "package-lock.json")) ||
                await hasCurrentShrinkwrap(packageRoot);

            args = [haveLock ? "ci" : "install", "--prefer-offline", "--no-audit", "--no-progress", "--legacy-peer-deps"];

            if (ignoreScripts) {
                args.push("--ignore-scripts");
            }

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

/**
 * Returns true if the path exists.
 */
export async function exists(path: string): Promise<boolean> {
    return !!await fs.promises.stat(path, { throwIfNoEntry: false });
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