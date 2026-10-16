# Content Studio

Self-hosted web app that turns a short, dropdown-based brief into platform-ready social media content (hook, script, caption, shot list, hashtags) for your own brands, with optional voice-over, video and key visuals, using your own AI provider keys.

More about the tool: <https://hmsk.life/tools/content-studio/>

## Features

- **Brief to finished draft.** Pick brand, platform (Instagram, TikTok, LinkedIn, YouTube, Facebook, X), post type, goal, pillar, hook type, tone, language (English / German) and number of variants. A detailed strategist prompt returns structured output: strategy, hook, script or voice-over, on-screen text, shot list, caption, hashtags, CTA and a self-review.
- **Bring your own model.** Anthropic, OpenAI, Google Gemini or any OpenAI-compatible server (LM Studio, Ollama, vLLM, OpenRouter). A keyless **Mock** provider produces template drafts so you can try the whole flow for free.
- **Brands you define.** The Brands tab stores each brand's description, audience, voice, visual identity, offers and guardrails; the model treats them as the only source of facts. Per brand you can switch on a second-pass **compliance review** that checks every draft against the guardrails, plus forbidden strings and claim-check words for the built-in lint.
- **Learns from history.** Each brief is grounded in the brand's reference posts (high and low performers) and previously approved drafts, with a repetition check against earlier hooks.
- **Optional production.** Voice-over with ElevenLabs, short video with Higgsfield (Kling 3.0, text-to-video or image-to-video) and key visuals with OpenAI or Gemini image models, using the brand's uploaded reference photos (logo, product, packaging, people, mood).
- **Review and keep.** Approve, save as draft or reject into a Postgres history; download any draft as JSON or Markdown.
- Also included: an Ideas tab for brainstorming hooks with an OpenAI-compatible model, a Research view of the reference posts, and optional Instagram / TikTok OAuth sync of your own accounts' posts and numbers ([docs/CONNECTORS.md](docs/CONNECTORS.md)).

Nothing is ever published to a social network automatically.

## Cost

The app itself is free (MIT). Every AI provider you configure bills its own API usage to your own account (text, voice, video and image generation all cost money per call; video is the most expensive). The Mock provider costs nothing.

## Quick start

### Docker Compose (recommended)

Requires Docker with Compose v2.24 or newer.

```bash
cp .env.example .env
# edit .env: set APP_PASSWORD (16+ characters), AUTH_SECRET (32+ random characters), POSTGRES_PASSWORD,
# and any API keys you want to use
docker compose up -d --build
```

Open <http://localhost:3000> and sign in with `APP_PASSWORD`. On start the container applies the database migrations and, on an empty database, seeds the fictional demo brand **Northwind Coffee Roasters** with six demo reference posts. Choose **Mock** as text provider to try it without keys. Data is kept in the `pgdata` volume.

### Node.js + PostgreSQL

Requires Node.js 20.9+ (22 recommended) and PostgreSQL 14+.

```bash
npm install                      # also runs prisma generate
cp .env.example .env             # set DATABASE_URL to your database
npx prisma migrate deploy        # create the tables
npx prisma db seed               # demo brand (only when the database has no brands)
npm run dev                      # http://localhost:3000, no login while APP_PASSWORD is empty
```

Production: `npm run build`, then `npm run start:prod` (migrate, seed, `next start`). In production `APP_PASSWORD` and `AUTH_SECRET` are required; without them the app stays locked.

## Your own brands and data

1. **Brands tab:** create a brand and fill in description, audience, voice, visual identity, offers (prices, links, CTAs the model may quote) and guardrails (what it must never say). Delete the demo brand when you are done.
2. **Brand assets tab:** upload reference photos (PNG, JPEG or WebP, up to 8 MB). Default images are sent to the image model so key visuals show your real product and logo.
3. **Reference posts (optional but recommended):** import your past posts with their results so the strategist learns what works for you:
   ```bash
   npm run db:import -- <brand-slug> my-posts.json
   ```
   The file format is the one in `data/demo-references.json` (required: `Platform`, `Post URL`, `Hook`; useful: `Content Pillar`, `Performance Level` High / Typical / Low, `Views`, `Likes`, `Content Mechanism`, `Observations`). With Docker, copy the file into the container (`docker compose cp my-posts.json app:/tmp/`) and run `docker compose exec app npm run db:import -- <brand-slug> /tmp/my-posts.json`. The Instagram / TikTok sync fills the same table automatically.

## Configuration

All settings are environment variables; [.env.example](.env.example) lists every one with its default. Every provider is optional; an unconfigured provider shows as "not configured" in the UI together with the variable to set.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string (set automatically by Docker Compose) |
| `POSTGRES_PASSWORD` | Docker | Password of the bundled Postgres service |
| `APP_PASSWORD` | production | Shared login password, 16+ characters |
| `AUTH_SECRET` | production | Random 32+ character string that signs the session cookie |
| `APP_URL` | no | Public address, used for OAuth redirects and hosted media links |
| `PORT` | no | Host port in Docker Compose (default 3000) |
| `MOCK_LLM` | no | Keyless mock provider, on by default; `0` hides it |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | no | Anthropic text provider (default model `claude-haiku-4-5`) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | no | OpenAI text provider; the key also enables OpenAI key visuals |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | no | Google Gemini text provider |
| `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY` | no | Any OpenAI-compatible server (from Docker: `http://host.docker.internal:1234/v1`) |
| `COMPLIANCE_REVIEW` | no | `off` disables the per-brand compliance review globally |
| `IDEAS_LLM_BASE_URL`, `IDEAS_LLM_MODEL`, `IDEAS_LLM_API_KEY` | no | Ideas tab model; falls back to `LOCAL_LLM_*` |
| `IDEAS_WEEKLY`, `SCHEDULER_TIMEZONE` | no | `on` writes a weekly idea bank every Monday |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | no | Voice-over |
| `HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_SECRET` | no | Video (Kling 3.0 Standard by default) |
| `IMAGE_PROVIDER`, `OPENAI_IMAGE_MODEL`, `GEMINI_IMAGE_MODEL` | no | Key visual provider and models |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | no | Account sync, see [docs/CONNECTORS.md](docs/CONNECTORS.md) |
| `TOKEN_ENCRYPTION_KEY` | no | Key for encrypting platform tokens (defaults to one derived from `AUTH_SECRET`) |

Notes:

- Generated images and voice-overs are stored in the database and served at `/api/media/<random id>` without login (the video provider has to fetch the start image). Treat those links like unlisted links.
- Long generations stream a keep-alive while the model works; behind a reverse proxy, allow responses of a few minutes.

## Deploy to Hostinger

[![Deploy to Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostinger.com/docker-hosting?compose_url=RAW_COMPOSE_URL&REFERRALCODE=REFERRAL_CODE)

<!-- TODO before publishing: replace RAW_COMPOSE_URL with the URL-encoded raw URL of docker-compose.yml in the public repository
     and REFERRAL_CODE with the referral code. A one-click deploy cannot build from a local folder, so also publish a container
     image (e.g. to ghcr.io) and set CONTENT_STUDIO_IMAGE to it, or point `build:` at the repository's git URL. -->

Set `APP_PASSWORD`, `AUTH_SECRET` and `POSTGRES_PASSWORD` (and any API keys) as environment variables of the deployment.

## Development

- Stack: Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Prisma 6, PostgreSQL.
- `npm run lint`, `npx tsc --noEmit`, `npm run build` (the build needs only a syntactically valid `DATABASE_URL`).
- Prompt engine: `lib/prompt/`; providers: `lib/providers/`; pipeline: `lib/pipeline.ts`; brand settings: `lib/brands.ts`, `components/BrandsView.tsx`; schema: `prisma/schema.prisma`.

## License

[MIT](LICENSE) © 2026 Hafiz Muhammad Sharoz Khalid
