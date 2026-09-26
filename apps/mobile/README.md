# PolykatoikiaOS mobile

This package is an Expo/React Native application managed by pnpm and Nx.

## Local commands

```bash
pnpm nx run @polykatoikia/mobile:start
pnpm nx run @polykatoikia/mobile:test
pnpm nx run @polykatoikia/mobile:export
```

The default API endpoint is `http://localhost:3000/api`, matching the local
API Nx target and the web development proxy. Set `EXPO_PUBLIC_API_URL` before
starting or exporting when a different API host is required; the client
normalizes the value and always retains exactly one `/api` suffix:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.20:3000/api \
  pnpm nx run @polykatoikia/mobile:start
```

For an Android emulator, use the host machine's LAN address (or the Expo
host's tunnel URL) instead of `localhost`. iOS Simulator can use `localhost`.

`export` writes the web bundle to `dist/apps/mobile` and is the reproducible
build used by CI. The checked-in PNG assets are referenced by `app.json`, so
Expo config validation does not depend on an untracked icon.
