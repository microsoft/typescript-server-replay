# @typescript/server-replay
Tool for replaying TypeScript server requests from a file in order to reproduce bugs.
A convenient wrapper around [@typescript/server-harness](https://www.npmjs.com/package/@typescript/server-harness).

## Format

> :warning: **Subject to change**

Newline-delimited JSON with one request per line.
After the first line, which provides configuration information, each line describes a request.
Each request has be modified in two notable ways for configurability.

1. All paths have had the root path replaced by a placeholder (value specified when the script is run).
2. Requests that would contain the contents of an entire file (`updateOpen` or `applyChangedToOpenFiles`) omit those contents.

## Usage

`npx tsreplay project_root replay_script server_path`

- `project_root` is the directory that would be open in the editor if this were a manual scenario
- `replay_script` is the path to a newline-delimited JSON file, as described above
- `server_path` is the path to a copy of `tsserver.js` to be tested

To help with debugging, you can pass `-l`, `-t`, or `-i` to enable logging, tracing, or inspecting/debugging, respectively.

Future: a subsequent version is expected to have a switch for automatically reducing the script.

## Deployment

To publish a new version of this package, change the version in `package.json` and push to main.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
