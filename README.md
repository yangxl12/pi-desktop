# Pi Desktop

Pi Desktop is a standalone Electron application that controls a pinned Pi coding-agent runtime through its JSONL RPC interface.

The source repository intentionally contains no Pi source tree. The runtime is installed from the exact `@earendil-works/pi-coding-agent` version declared by `packages/desktop-pi-bridge`.

Run `npm install --ignore-scripts`, then `npm run dev --workspace=@earendil-works/pi-desktop`.
