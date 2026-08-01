# Pi Runtime Upgrade

The desktop repository does not merge Pi source tags. Its only runtime dependency is the exact
`@earendil-works/pi-coding-agent` version declared in
`packages/desktop-pi-bridge/package.json`.

To upgrade Pi:

1. Update that package version to the intended released Pi version.
2. Run `npm install --package-lock-only --ignore-scripts`.
3. Run `npm run check` and the package-level desktop tests.
4. Run the desktop RPC smoke test against the installed runtime before release.

The Windows packaging script bundles the installed package's `rpc-entry` export and copies its
runtime theme assets. It must never read `../pi` or any other Pi source checkout.
