import * as sh from "@typescript/server-harness";
import * as fs from "fs";
import * as process from "process";
import * as path from "path";
import * as readline from "readline";
import * as events from "events";

export interface ReplayOptions {
    /** Location of directory containing repro project. */
    project: string;
    /** Location of file containing server request stubs. */
    requests: string;
    /** Location of tsserver.js. */
    server: string;
    /** Enable tsserver tracing and write outputs to specified directory. */
    traceDir?: string;
    /** Enable tsserver logging and write log to specified directory. */
    logDir?: string;
    /** Enable --inspect-brk on the specified port. */
    inspectPort?: number;
    /** Stop at the first sign of trouble and use line-oriented output. */
    unattended?: boolean;
    /** Replay only file opening and closing, plus the final request. */
    simple?: boolean;
    /** Replay only the final file opening and the final request. */
    superSimple?: boolean;
}

export function canonicalizePath(p: string): string {
    // Resolve relative paths now, before we chdir
    // Match the slashes used in server requests
    return path.resolve(p).replace(/\\/g, "/");
}

export async function runReplay(options: ReplayOptions): Promise<void> {
    const testDir = canonicalizePath(options.project);
    const requestsPath = canonicalizePath(options.requests);
    const serverPath = canonicalizePath(options.server);

    const traceDir = options.traceDir && canonicalizePath(options.traceDir);
    const logDir = options.logDir && canonicalizePath(options.logDir);
    const inspectPort = options.inspectPort && +options.inspectPort;
    const unattended = !!options.unattended;
    const simple = !!options.simple;
    const superSimple = !!options.superSimple;

    // Needed for excludedDirectories
    process.chdir(testDir);

    const rl = readline.createInterface({
        input: fs.createReadStream(requestsPath),
        crlfDelay: Infinity,
    });

    let rootDirPlaceholder = "@PROJECT_ROOT@";
    let serverArgs: string[] = [
        "--disableAutomaticTypingAcquisition",
    ];

    let firstLine = true;
    let sawExit = false;
    let requests: any[] = [];


    rl.on('line', line => {
        try {
            // Ignore blank lines
            if (line.trim().length === 0) {
                return;
            }

            if (firstLine) {
                const obj = JSON.parse(line);
                if (!obj.command) {
                    rootDirPlaceholder = obj.rootDirPlaceholder ?? rootDirPlaceholder;
                    serverArgs = obj.serverArgs ?? serverArgs;
                    return;
                }
            }

            const request = JSON.parse(line.replace(new RegExp(rootDirPlaceholder, "g"), testDir));
            if (request.command === "updateOpen") {
                for (const openFile of request.arguments.openFiles) {
                    const openFileContents = fs.readFileSync(openFile.file, { encoding: "utf-8" });
                    openFile.fileContent = openFileContents;
                }
            }
            else if (request.command === "applyChangedToOpenFiles") {
                for (const openFile of request.arguments.openFiles) {
                    const openFileContents = fs.readFileSync(openFile.fileName, { encoding: "utf-8" });
                    openFile.content = openFileContents;
                }
            }
            // Drop exit requests in unattended mode - we need to tear down more explicitly
            const isExit = request.command === "exit";
            sawExit = sawExit || isExit;
            if (!isExit || !unattended) {
                requests.push(request);
            }
        }
        catch {
            console.log(`Bad input "${line}"`);
            if (unattended) {
                process.exit(2);
            }
        }
        finally {
            firstLine = false;
        }
    });
    await events.EventEmitter.once(rl, 'close');

    if (!requests.length) {
        if (!unattended) {
            console.log("No requests to replay");
        }
        process.exit(0);
    }

    if (!sawExit && !unattended) {
        requests.push({ "seq": 999999, "command": "exit" });
    }

    if (simple) {
        const newRequests: any[] = [];
        let i = 0;
        if (requests[i].command === "configure") {
            newRequests.push(requests[i]);
            i++;
        }
        let j = requests.length - 1;
        if (requests[j].command === "exit") {
            j--;
        }

        for (; i < j; i++) {
            const req = requests[i];
            if (req.command === "updateOpen" || req.command === "applyChangedToOpenFiles") {
                if (req.arguments.openFiles?.length || req.arguments.closedFiles?.length) {
                    newRequests.push(req);
                }
            }
        }

        for (j = Math.max(i, j); j < requests.length; j++) {
            newRequests.push(requests[j]);
        }

        requests = newRequests;
    }
    else if (superSimple) {
        const newRequests: any[] = [];

        let h = 0;
        if (requests[h].command === "configure") {
            newRequests.push(requests[h]);
            h++;
        }

        let i = requests.length - 1;
        for (; i >= h; i--) {
            const req = requests[i];
            if (req.command === "updateOpen" || req.command === "applyChangedToOpenFiles") {
                if (req.arguments.openFiles?.length) {
                    // We're not opening other files, so changeFiles and closeFiles can only cause problems, if they're present
                    req.arguments.changedFiles = [];
                    req.arguments.closedFiles = [];
                    newRequests.push(req);
                    break;
                }
            }
        }

        // NB: i === h-1 if no file open request was found and i >= h-1 in all cases

        let j = requests.length - 1;
        if (requests[j].command === "exit") {
            if (j - 1 > i) {
                newRequests.push(requests[j - 1]);
            }
            newRequests.push(requests[j]);
        }
        else if (j > i) {
            newRequests.push(requests[j]);
        }

        requests = newRequests;
    }

    if (traceDir) {
        await fs.promises.mkdir(traceDir, { recursive: true });
        serverArgs.push("--traceDirectory", traceDir);
    }

    if (logDir) {
        await fs.promises.mkdir(logDir, { recursive: true });
        serverArgs.push("--logVerbosity", "verbose");
        serverArgs.push("--logFile", path.join(logDir, "tsserver.PID.log"));
    }

    const nodeArgs = [
        "--max-old-space-size=4096",
        "--expose-gc",
        "--stack-size=2048",
        // "--require=E:/tsserver-stress/node_modules/pprof-it/dist/index.js",
    ];

    if (inspectPort) {
        nodeArgs.push(`--inspect-brk=${inspectPort}`);
    }

    let exitRequested = false;
    const server = sh.launchServer(serverPath, serverArgs, nodeArgs);

    // On Linux, it's idiomatic to shut down your child processes when you receive SIGTERM.
    // This helps us ensure clean teardown during lab runs.
    // NB: As of Node 16, SIGTERM never fires on Windows.
    process.once("SIGTERM", async () => {
        exitRequested = true; // Shouldn't matter, but might as well
        await server.kill();
        // This is a sneaky way to invoke node's default SIGTERM handler
        process.kill(process.pid, "SIGTERM");
    });

    server.on("close", (code, signal) => {
        if (!unattended || !exitRequested || code || signal) {
            console.log(`${exitRequested ? "Shut down" : "Exited unexpectedly"}${code ? ` with code ${code}` : signal ? ` with signal ${signal}` : ""}`);
        }
        if (unattended && !exitRequested) {
            process.exit(3);
        }
    });

    server.on("communicationError", async err => {
        console.error(`Error communicating with server:\n${err}`);
        if (unattended) {
            exitRequested = true; // Suppress "exit" event handler
            await server.kill();
            process.exit(7);
        }
    });

    server.on("event", async e => {
        if (e.event === "projectLanguageServiceState" && !e.body.languageServiceEnabled) {
            console.log(`Language service disabled for ${e.body.projectName ? path.normalize(e.body.projectName) : "unknown project"}`);
            if (unattended) {
                exitRequested = true; // Suppress "exit" event handler
                await server.kill();
                process.exit(4);
            }
        }
    });

    for (const request of requests) {
        exitRequested = exitRequested || request.command === "exit";
        if (!unattended) console.log(`${request.seq}\t${request.command}`);
        const response = await server.message(request);
        if (response && !response.success && response.message !== "No content available.") {
            if (unattended) {
                console.log(JSON.stringify(response)); // Print on a single line - includes request seq and error message, if any
                try {
                    await exitOrKillServer();
                }
                catch {
                    // Ignore errors during shutdown
                }
                process.exit(5);
            }

            console.log(request);
            console.log(response);
        }
    }

    if (unattended) {
        if (!await exitOrKillServer()) {
            // Server didn't exit cleanly and had to be killed
            process.exit(6);
        }
    }

    async function exitOrKillServer(): Promise<boolean> {
        exitRequested = true; // Suppress "exit" event handler
        return await server.exitOrKill(5000);
    }
}
