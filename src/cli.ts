import * as process from "process";
import yargs from "yargs";
import { runReplay } from "./stradaReplay.js";
import { installDependencies } from "./installPackages.js";

void yargs(process.argv.slice(2))
    .command(
        "strada-replay <project> <requests> <server>",
        "Replay a TS <= 6 fuzzer repro",
        yargs => yargs
            .positional("project", { type: "string", desc: "location of directory containing repro project", demandOption: true })
            .positional("requests", { type: "string", desc: "location of file containing server request stubs", demandOption: true })
            .positional("server", { type: "string", desc: "location of tsserver.js", demandOption: true })
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
                "s": {
                    alias: ["simple"],
                    describe: "Replay only file opening and closing, plus the final request",
                    type: "boolean",
                },
                "S": {
                    alias: ["superSimple", "super-simple"],
                    describe: "Replay only the final file opening and the final request",
                    type: "boolean",
                },
            })
            .conflicts("s", "S"),
        async args => {
            await runReplay({
                project: args.project,
                requests: args.requests,
                server: args.server,
                traceDir: args.t,
                logDir: args.l,
                inspectPort: args.i,
                unattended: args.u,
                simple: args.s,
                superSimple: args.S,
            });
        },
    )
    .command(
        "install <project>",
        "Install dependencies for a repro project",
        yargs => yargs
            .positional("project", { type: "string", desc: "location of directory containing repro project", demandOption: true })
            .options({
                "quietOutput": {
                    describe: "Run install commands in quiet/silent mode",
                    type: "boolean",
                    default: false,
                },
                "recursiveSearch": {
                    describe: "Recursively search directories for package.json files to install dependencies for",
                    type: "boolean",
                    default: true,
                },
                "timeout": {
                    describe: "timeout for installing dependencies (ms)",
                    type: "number",
                    default: 10 * 60 * 1000,
                },
            }),
        async args => {
            await installDependencies(args.project, args.quietOutput, args.recursiveSearch, args.timeout);
        },
    )
    .help("h").alias("h", "help")
    .strict()
    .parse();