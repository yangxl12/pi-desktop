# Pi Desktop Host

This is the phase 0-2 desktop host. It exposes the platform-neutral application through a local HTTP IPC bridge and a small renderer preview. The host ports are intentionally replaceable by a Tauri 2 or Electron adapter without changing `desktop-core` or the Pi RPC bridge.

Run `npm run dev --workspace=@earendil-works/pi-desktop` and open `http://127.0.0.1:4317`. The root page bootstraps a HttpOnly loopback token cookie; API calls require that cookie or `x-pi-desktop-token` and reject other origins. Run `npm run spike --workspace=@earendil-works/pi-desktop` for the phase 0 capability report.
