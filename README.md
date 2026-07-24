# social-share

**https://social-share.mazaryk.com**

Paste a URL, hit Go, and see how that page looks when shared on social platforms:

- An example Facebook share tile and X (Twitter) card preview
- All Open Graph / Twitter / basic HTML share metadata, with missing tags flagged
- Per-platform support indicators (Facebook, X, LinkedIn, WhatsApp, Discord, Telegram, Slack, Pinterest)
- A 0–100 shareability score with a per-check breakdown

## How it works

A single Cloudflare Worker serves the static page (`public/`) and exposes
`GET /api/preview?url=...`, which fetches the target page server-side (with a
share-crawler user agent, so it sees what crawlers see and avoids CORS), parses
the head with `HTMLRewriter`, and verifies the share image actually resolves.
Nothing is stored.

## Develop

```sh
npx wrangler dev
```

## Deploy

```sh
npx wrangler deploy
```

Deployed to the `social-share.mazaryk.com` custom domain via `wrangler.jsonc`.
