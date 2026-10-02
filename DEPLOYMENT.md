# Deploying the frontend to Vercel

The frontend is a Vite SPA. Deploy it from the Vercel dashboard, or with the
CLI if you prefer. Nothing here needs a secret.

## Import the repository

1. Go to [vercel.com/new](https://vercel.com/new) and import **dhozil/exemplum**.
2. Set these before the first deploy:

   | Setting | Value |
   |---|---|
   | Root Directory | `frontend` |
   | Framework Preset | Vite |
   | Build Command | `npm run build` |
   | Output Directory | `dist` |
   | Install Command | `npm install` |

   The last three are already in `frontend/vercel.json`, so Vercel should fill
   them in on its own. Root Directory is not, because it is a property of the
   project rather than of the code.

3. Deploy.

That is enough. With no environment variables set, the build points at the
project's own public StudioNet deployment, so the site works immediately — read
operations included. See the overrides below to point it somewhere else.

## Environment variables

All optional. Set them under **Project Settings → Environment Variables** and
redeploy; changing one does not apply until you do.

| Variable | Default | What it does |
|---|---|---|
| `VITE_GENLAYER_NETWORK` | `studionet` | `localnet`, `studionet`, `testnetAsimov`, `testnetBradbury` |
| `VITE_NOTARY_ADDRESS` | the project's demo notary | the `AINotary` contract |
| `VITE_SETTLEMENT_ADDRESS` | the project's demo settlement | the `NotarizedSettlement` contract |
| `VITE_GENLAYER_RPC` | the network default | override the RPC endpoint |
| `VITE_GENLAYER_EXPLORER` | `https://explorer-studio.genlayer.com` | override the block explorer |
| `VITE_DEV_ACCOUNT_KEY` | unset | **do not set this** |

### Why the explorer is not defaulted from the SDK

The `studionet` chain definition in `genlayer-js` carries
`https://genlayer-explorer.vercel.app`, which answers 503 on every path. A build
that trusted it would produce explorer links that look correct and go nowhere, so
the URL is pinned here instead.

### Why the dev account key must stay unset

`VITE_DEV_ACCOUNT_KEY` puts a private key in the JavaScript bundle, served to
every visitor. It exists so local demos and CI can sign without a browser wallet.
Setting it on a deployment publishes the key.

## Two things that will bite you if they are missing

**Deep links.** The app uses `BrowserRouter`, so `/records/7` is a real URL. Vercel
serves static files and 404s anything it does not recognise, which means a
refreshed record page would come up empty. The rewrite in `vercel.json` sends
unknown paths to `index.html`; requests that look like files — anything under
`/assets/` or with a file extension — are passed through, so hashed bundles keep
working.

**Node version.** Vite 8 will not build on Node below 20.19. `engines` in
`frontend/package.json` and `frontend/.nvmrc` both say so; if you change one,
change the other.

## Deploying the contracts first

The addresses in `src/config.ts` are this project's own StudioNet pair. To point
a deployment at a newer one, deploy the contracts and set the two address
variables above — the frontend does not need a rebuild for anything else.

## With the CLI

```bash
cd frontend
npx vercel            # preview
npx vercel --prod     # production
```

Needs `vercel login` first. The dashboard route above avoids the CLI entirely.