const sh = require("@typescript/server-harness");
const fs = require("fs");
const process = require("process");
const path = require("path");
const readline = require("readline");
const events = require("events");
const yargs = require("yargs");

const args = yargs(process.argv.slice(2))
    .command("$0 <project> <requests> <server>", "Replay a fuzzer repro", yargs => yargs
        .positional("project", { type: "string", desc: "location of directory containing repro project" })
        .positional("requests", { type: "string", desc: "location of file containing server request stubs" })
        .positional("server", { type: "string", desc: "location of tsserver.js" })
        .options({
            "t": {
                alias: ["traceDir", "trace-dir"],
                describe: "Enable tsserver tracing and write outputs to specified directory",
                type: "string",
            },
            "l": {
                alias: ["logDir", "log-dir"],
                describe: "Enable tsserver logging and write log to specified directory",
                type: "string",
            },
            "i": {
                alias: ["inspectPort", "inspect-port"],
                describe: "Enable --inspect-brk on the specified port",
                type: "number",
            },
            "u": {
                alias: ["unattended"],
                describe: "Stop at the first sign of trouble and use line-oriented output",
                type: "boolean",
            },
        })
        .help("h").alias("h", "help")
        .strict())
    .argv;

// @ts-ignore yargs prevents undefined
const testDir = canonicalizePath(args.project);
// @ts-ignore yargs prevents undefined
const requestsPath = canonicalizePath(args.requests);
// @ts-ignore yargs prevents undefined
const serverPath = canonicalizePath(args.server);

const traceDir = args.t && canonicalizePath(args.t);
const logDir = args.l && canonicalizePath(args.l);
const inspectPort = args.i && +args.i;
const unattended = !!args.u;

/**
 * @param {string} p
 */
function canonicalizePath(p) {
    // Resolve relative paths now, before we chdir
    // Match the slashes used in server requests
    return path.resolve(p).replace(/\\/g, "/");
}

// Needed for excludedDirectories
process.chdir(testDir);

main().catch(e => {
    console.log(e);
    process.exit(1);
});

async function main() {
    const rl = readline.createInterface({
        input: fs.createReadStream(requestsPath),
        crlfDelay: Infinity,
    });

    let rootDirPlaceholder = "@PROJECT_ROOT@";
    let serverArgs = [
        "--disableAutomaticTypingAcquisition",
    ];

    let firstLine = true;
    let sawExit = false;
    const requests = [];


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
            if (request.command === "applyChangedToOpenFiles") {
                for (const openFile of request.arguments.openFiles) {
                    const openFileContents = fs.readFileSync(openFile.fileName, { encoding: "utf-8" });
                    openFile.content = openFileContents;
                }
            }
            sawExit = sawExit || request.command === "exit";
            requests.push(request);
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
    await events.once(rl, 'close');

    const synthesizedExitRequest = { "seq": 999999, "command": "exit" };
    if (!sawExit) {
        requests.push(synthesizedExitRequest);
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
        // "--require=E:/tsserver-stress/node_modules/pprof-it/dist/index.js",
    ];

    if (inspectPort) {
        nodeArgs.push(`--inspect-brk=${inspectPort}`);
    }

    let exitRequested = false;
    const server = sh.launchServer(serverPath, serverArgs, nodeArgs);

    server.on("exit", code => {
        if (!unattended || !exitRequested || code) {
            console.log(`${exitRequested ? "Shut down" :"Exited unexpectedly"}${code ? ` with code ${code}` : ""}`);
        }
        if (unattended) {
            process.exit(3);
        }
    });

    server.on("event", async e => {
        if (e.event === "projectLanguageServiceState" && !e.body.languageServiceEnabled) {
            console.log(`Language service disabled for ${e.body.projectName ? path.normalize(e.body.projectName) : "unknown project"}`);
            if (unattended) {
                try {
                    await server.message(synthesizedExitRequest);
                }
                catch {
                    // Ignore errors during shutdown
                }
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
                    exitRequested = true;
                    await server.message(synthesizedExitRequest);
                }
                catch {
                }
                process.exit(5);
            }

            console.log(request);
            console.log(response);
        }
    }
}