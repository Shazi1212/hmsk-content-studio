# Connecting Instagram and TikTok (official APIs)

One-time setup guide for the owner. Facts checked against the official documentation on **2026-09-30** (sources at the
bottom). Menu names in Meta's and TikTok's dashboards move around now and then: if a label below is missing, look for the
closest one; the goal of each step stays the same.

## What "connect once" means

You press **Connect** next to an account in the app. Instagram or TikTok asks you to log in and approve. The app then keeps a
login token for that account (stored encrypted, never your password) and, once a week, renews the token if needed and pulls
the account's own posts with their numbers. You only press Connect again if the token is lost.

| | Token you get | How long it lives | Renewed by the app? |
|---|---|---|---|
| Instagram | long-lived access token | 60 days | Yes, during the weekly sync once fewer than 14 days are left. Instagram only allows a renewal when the token is at least 24 hours old and **not yet expired**. |
| TikTok | access token + refresh token | access token 24 hours, refresh token 365 days | Yes, every sync. TikTok may hand out a new refresh token each time; the app stores it. |

Connect again when: the app shows "reconnect needed", you changed the Instagram password, you removed the app in the
Instagram/TikTok settings, or (Instagram) no sync ran for 60 days.

## Before you start

- Every Instagram account must be a **Professional account** (Business or Creator). Personal accounts do not work. No Facebook
  Page is needed.
- A free Meta developer login (your Facebook account) and a free TikTok developer login.
- Access to the app's environment variables (.env file or container environment).
- The two redirect addresses (the app is reachable here):
  - Instagram: `https://studio.example.com/api/connect/instagram/callback`
  - TikTok: `https://studio.example.com/api/connect/tiktok/callback`

## Part 1: Instagram (Meta)

Uses "Instagram API with Instagram Login". Nothing has to be reviewed by Meta as long as only your own accounts connect.

1. Go to <https://developers.facebook.com/>, log in with the Facebook account that should own the app and register as a
   developer if Meta asks (free).
2. **My Apps → Create App.** Name it, for example, "Content Studio". If it asks for an app type, choose **Business**: the Instagram
   login API only works in a Business-type app.
3. In the app dashboard open **Use cases → Add use cases → Content management** and add **Manage messaging & content on
   Instagram**. Then press **Customize** on it and open **API setup with Instagram login**.
4. On that page copy the **Instagram app ID** and the **Instagram app secret** (Show; Meta asks for your Facebook password
   first). These are *not* the App ID and App Secret under Settings → Basic; using those is the most common mistake. Put them in
   the environment (.env).
5. Still in **Customize**, open **Permissions and features** and press **Add** for `instagram_business_basic` and
   `instagram_business_manage_insights`, plus `instagram_business_content_publish` if you want publishing later (see "Publish
   permissions" below). Each then shows "Ready for testing". Do not use "Add all required permissions" on the setup page: it adds
   messaging permissions the app does not need.
6. Back on **API setup with Instagram login**, in step **4. Set up Instagram business login**, press **Set up**, enter this
   address as the **Redirect URL** and save (the step gets a green check):
   `https://studio.example.com/api/connect/instagram/callback`
7. Add every Instagram account as a tester: left menu **App roles → Roles → Add People**, choose **Instagram Tester** (under
   "Additional roles", not the plain "Tester"), type the Instagram username, pick it from the list, press **Add**. Several
   usernames can be added in one go.
8. Accept the invitation **inside Instagram**, once per account: log in to that Instagram account in a browser, open
   <https://www.instagram.com/accounts/manage_access/>, tab **Tester Invites**, press **Accept**. (In the Instagram app:
   Profile → Settings → Website permissions → Apps and Websites → Tester Invites.) Until this is done the account shows as
   "pending" in the Meta dashboard and Connect fails.
9. Check the account type: Instagram app → Settings and privacy → Account type and tools → **Switch to professional account**
   (Business or Creator). Skip if it already is one.
10. Leave the app in **Development** mode (the switch at the top of the dashboard). Do not publish it.
11. In the app press **Connect** next to the Instagram account, log in as that account, press **Allow**. If Instagram shows a
    different account than the one you want, log out of Instagram in that browser first or use a private window.

**What development mode means for you:** only accounts with a role on the Meta app (your testers) can connect, which is exactly
what you need. Connecting accounts of other people would need "Advanced Access": Meta App Review plus business verification.
Not needed here.

## Part 2: TikTok

Uses Login Kit (sign-in, and reading the account's own public videos with `video.list`) and, for the planned publishing feature, the
Content Posting API.

1. Go to <https://developers.tiktok.com/>, log in with a TikTok account and accept the developer terms.
2. **Manage apps → Connect an app (create an app).** Fill in app name, icon, category and description. TikTok also asks for the
   website, Terms of Service and Privacy Policy addresses: use pages on your own website. Platform: **Web**.
3. **Add products: Login Kit, and Content Posting API if you want publishing later** (it needs Login Kit; there is no separate
   Display API product, its scopes come with Login Kit). Under **Platforms** tick **Web** and enter `https://studio.example.com` as the
   Web/Desktop URL. In Login Kit (Web) add the redirect address `https://studio.example.com/api/connect/tiktok/callback` (https only,
   no `?` and no `#` in it). Under **Scopes → Add scopes** add **video.list**; `user.info.basic` comes with Login Kit. With Content
   Posting API added, turn **Direct Post** on: that adds `video.publish` next to `video.upload` (see "Publish permissions" below).
4. Use **Sandbox**: switch the app to Sandbox mode (the **Sandbox** tab next to **Production**), open or create the sandbox, give it
   the same basic information, products, scopes and redirect address, and press **Apply changes** ("Saved"). Then under **Sandbox
   settings → Target users** press **Add account** and log in with each TikTok account you want to connect (up to 10 accounts, up to
   5 sandboxes per app). A newly added target user can take about an hour to show up.
5. Copy the **Client key** and **Client secret** of the app (if the Sandbox page shows its own key and secret, use those while
   you are in Sandbox) and put them in the environment (.env).
6. In the app press **Connect** next to the TikTok account, log in with the account that is listed as a target user, press
   **Authorize**.

**Production review, honest note:** TikTok's app review rules say apps "must not be for private or personal use" and ask for a
demo video, a public website and privacy/terms pages. An internal tool for your own accounts may be refused. Sandbox with up to 10
target accounts is the route that needs no review; TikTok calls it a testing environment, so keep an eye on it. If you ever want
production, import the sandbox settings into a Draft of the app and submit it for review.

## How it works inside the app

- **Panel:** Research data tab → *Data sources*: one row per brand with an Instagram and a TikTok cell. A cell shows the connected account, its
  status (*Connected*, *Reconnect needed*, *Sync error*), when it was last synced and how many posts, plus *Sync now*, *Reconnect* and *Disconnect*;
  an unconnected cell shows *Connect …*. *Sync all now* runs every account that can still work.
- **Connect:** the button is a link to `GET /api/connect/<platform>/start?brand=<slug>`. The app puts brand, platform and a random nonce into a signed,
  10-minute `state` (and the nonce into an httpOnly cookie), then redirects to the platform's consent screen. The platform sends the browser back to
  `/api/connect/<platform>/callback?code=…&state=…`; the app checks the state, the cookie and the session, exchanges the code, stores the account
  (`PlatformConnection`, tokens AES-256-GCM encrypted, see `lib/crypto.ts`) and starts a first sync in the background. Two accounts of one platform can be
  connected to the same brand; the same account can be connected to two brands.
- **Sync** (`lib/sync.ts`): renews the token when the connector asks for it (and stores the renewed token, TikTok rotates the refresh token), fetches the
  latest 60 posts (120 on the first sync) and writes them into `ReferencePost`. A post that is already there (matched by Instagram shortcode or TikTok video
  id, so the scraped research rows match too) only gets fresh numbers; its research analysis and human rating stay. A new post becomes a row with source
  `api-instagram` / `api-tiktok`: hook = first caption line, the numbers, and a rating against the median of the account's latest posts (Exceptional ≥ 4×,
  High ≥ 1.75×, Low ≤ 0.5×, otherwise Typical; Unknown below 6 posts). Pillar, hook type and mechanism stay empty for these rows.
- **Weekly:** the scheduler (`lib/scheduler.ts`, task `sync-weekly`) runs every Monday from 03:00 Berlin time; a run that failed for a transient reason
  (network, rate limit, 5xx) is retried after an hour, up to 3 attempts. Accounts that need a reconnect are skipped and shown in the panel.
- **Disconnect** deletes the stored tokens; imported posts stay. To revoke the app at the platform as well, remove it in the Instagram / TikTok settings.
- **Publish permissions (opt-in):** by default Connect asks only for read access (Instagram `instagram_business_basic` and
  `instagram_business_manage_insights`; TikTok `user.info.basic` and `video.list`). To have the planned publishing feature covered by
  the same consent, set `INSTAGRAM_EXTRA_SCOPES=instagram_business_content_publish` and `TIKTOK_EXTRA_SCOPES=video.upload,video.publish` in the environment (.env)
  and keep the matching permissions and scopes enabled in the Meta and TikTok dashboards (a scope the dashboard does not know makes the authorize
  page refuse the request). Nothing in the app publishes yet. Tokens that carry publish scopes can post on the brand accounts, so they stay encrypted,
  the app stays behind its login, and Disconnect deletes them. Accounts connected before the variables were set press **Reconnect** once to grant the
  new scopes. Unknown names in these variables are ignored.
- **Not needed today:** Meta's *Deauthorize* and *Data deletion* callback URLs (only required when an app goes Live).
- Extra env vars used by the app itself: `APP_URL` (public address, builds the redirect URIs; derived from the request headers when empty) and the optional
  `TOKEN_ENCRYPTION_KEY` (otherwise `AUTH_SECRET` is used; changing either makes stored tokens unreadable, the accounts then show *Reconnect needed*).

## Environment variables

Add these to `.env` (or your container environment) and restart the app. Names only here; the values come from the steps above
and are never committed.

| Name | Where it comes from |
|---|---|
| `INSTAGRAM_APP_ID` | Meta dashboard → Instagram → API setup with Instagram login → Instagram app ID |
| `INSTAGRAM_APP_SECRET` | same page → Instagram app secret |
| `TIKTOK_CLIENT_KEY` | TikTok developer portal → your app → Client key |
| `TIKTOK_CLIENT_SECRET` | same page → Client secret |
| `APP_URL` | `https://studio.example.com` (recommended: makes the redirect URIs independent of proxy headers) |
| `INSTAGRAM_EXTRA_SCOPES` | Optional. `instagram_business_content_publish` to also request publish permission (see "Publish permissions") |
| `TIKTOK_EXTRA_SCOPES` | Optional. `video.upload,video.publish` to also request upload and publish permission |

Until both variables of a platform are set, the app shows that platform as "not configured" and names the missing variables.

## LinkedIn: what is possible and what is not

LinkedIn **stays on export/import for now** (download your analytics from LinkedIn, import the file in the app). Reasons, from
LinkedIn's current API documentation:

- **Company Pages.** The Community Management API can list a Page's posts and return their statistics, but LinkedIn has to approve
  the application first: it is only offered "to registered legal organizations for commercial use cases", needs a verified business
  email, a Page super admin who verifies the app, a review, and later a second review (screen recording) for the Standard tier. A
  rejected application cannot be re-submitted with the same app. Approval for an internal tool is possible but not guaranteed, and
  it is not quick.
- **Personal profiles.** Since 2025 there is a *Member Post Analytics* API (permission `r_member_postAnalytics`, part of the same
  Community Management API) with impressions, members reached, reactions, comments, reshares, saves and sends. It needs the same
  approval and works only when you already know a post's ID. Reading your own list of posts needs `r_member_social`, which LinkedIn
  has **closed** ("not accepting access requests at this time"). So an automatic weekly pull of all personal posts is not possible
  today. (The older assumption "no analytics API for personal profiles" is out of date, but the API is unusable without the post
  list.)
- Nothing is scraped and no LinkedIn password is ever entered into the app.

Revisit this if LinkedIn reopens `r_member_social` or if you decide to apply for Community Management API access for its
Company Page.

## What the weekly sync brings and what it cannot

| | Instagram | TikTok |
|---|---|---|
| Posts | Feed posts, Reels and carousels of the connected account (stories are skipped) | Public videos of the connected account |
| Numbers | views, reach, saves, shares, likes, comments | views, likes, comments, shares (no saves, no reach) |
| Caption | full caption (see the caption note below) | description, documented with a 150 character maximum, so long captions can arrive shortened |
| Delay | Instagram updates insights with up to 48 hours delay and keeps them for 2 years | no delay documented |
| Not included | album children, stories, older plays/impressions figures (Instagram retired them in favour of "views") | private videos, account handle (only the display name is available with the basic scope) |

Caption note: Meta's reference page marks the `caption` and `media_product_type` fields as "Available for Instagram API with
Facebook Login only". The connector asks for them anyway and copes when they are missing (empty caption; Reels are then
recognised by their `/reel/` link). If captions are empty after the first sync, this is the reason; the fix would be Facebook
Login for Business, which needs each Instagram account linked to a Facebook Page.

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| Instagram page says your account has no role on the app ("Insufficient developer role") | Instagram connects **the account that is logged in in that browser**, and that one is not a tester of the app: the wrong login (a personal account, or another brand's), or the invitation of the right account is not accepted yet | Log in as the brand's own account first, or press **Use another login** next to the Connect button (it shows Instagram's login screen). Check that the account accepted its invite: Meta app, App roles, Roles shows "Pending" until it did (Part 1, steps 7 and 8). Use "Instagram Tester", not "Tester". The account only sees a **Tester Invites** tab on instagram.com/accounts/manage_access/ while an invite is open, and only when logged in as that account (not through another linked account). |
| Instagram: "code exchange failed (HTTP 400): Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request" although the redirect address is registered correctly | The wrong secret: `INSTAGRAM_APP_SECRET` is the Meta app's secret (Settings, Basic, "App secret"). Instagram login needs the **Instagram app secret**: Meta dashboard, Use cases, Instagram, **API setup with Instagram login**, next to "Instagram app ID" (Show asks for the Facebook password). The two look alike (32 hex characters). The error also appears when a code is used twice or a different redirect address is sent | Copy the Instagram app secret into `INSTAGRAM_APP_SECRET` in the environment (.env). |
| "Sync error: Invalid `prisma.referencePost.create()` invocation: unexpected end of hex escape" | A caption with an emoji was cut in the middle of the emoji (a lone UTF-16 surrogate), which Prisma's engine refuses (fixed 2026-10-01: `lib/text.ts`, every write is scrubbed in `lib/db.ts`) | Press **Sync now** again. |
| No Connect button for a brand and platform ("–") | The brand's platform list does not mention that platform and the app does not know an account for it | Add the platform to the brand's platform list in the Brands tab. A second account of the same brand: **Add another account** (it asks for the login again). |
| Instagram or TikTok says the redirect address is invalid | The address in the dashboard differs from the one the app uses (also a missing trailing slash, http instead of https) | Copy the address from this guide exactly, save, try again. |
| App says "reconnect needed", Instagram code 190 or "Session has expired" | Token expired (no sync for 60 days), password changed, access removed, or the app was removed in Instagram settings | Press Connect again for that account. |
| Connect fails with "only professional accounts" or the account cannot be added | Personal Instagram account | Part 1, step 9. |
| Instagram posts appear but views/reach/saves/shares are empty | The insights permission was not granted (connected before it was added), or the post is older than the switch to a professional account, or the post is very new (up to 48 h delay) | Press Connect again and tick every permission. Old posts stay empty; new posts fill in. |
| Instagram captions are empty, Reels show as "Video" | Fields that Meta lists as Facebook-Login-only (see the caption note) | Tell the developer; see the caption note. |
| Instagram: "Invalid Scopes" or a permission error on the authorize page | A permission the app requests is not added to the app's Instagram use case | Part 1, step 5 (also for `instagram_business_content_publish` when `INSTAGRAM_EXTRA_SCOPES` is set). If the insights permission cannot be added, tell the developer: removing `instagram_business_manage_insights` from `INSTAGRAM_SCOPES` in `lib/connectors/instagram.ts` lets posts sync without the numbers. |
| TikTok: "scope not authorized" or no videos | A permission was not ticked when approving, or a scope the app requests is not enabled in the portal | Enable Login Kit, the scope `video.list` and, when `TIKTOK_EXTRA_SCOPES` is set, Content Posting API with Direct Post, apply the changes, then Connect again and approve everything. |
| TikTok authorize page says `non_sandbox_target` | The TikTok account that is logged in is not a Target user of the sandbox | Part 2, step 4: add the account under Target users, or log in with one that is listed. |
| TikTok authorization page shows an error for your account | The account is not listed under the Sandbox's Target users (or was added less than an hour ago) | Part 2, step 4, wait an hour, try again. |
| TikTok "access token invalid" once | The 24-hour token expired | The app renews it by itself. If it repeats after renewal, press Connect again. |
| "Rate limit" message | Too many calls in a short time | Nothing to do; the next sync continues. |
| "not configured" | Environment variables missing | Add them in the environment (.env). |

## For developers: what is pinned

- Instagram: `https://graph.instagram.com/v25.0/...` (`INSTAGRAM_GRAPH_VERSION`, the version used in every example of the Instagram
  Platform docs; Graph API v26.0 exists since 2026-07-29, v25.0 stays available until 2028-07-29). Token endpoints are unversioned.
  Scopes: `instagram_business_basic`, `instagram_business_manage_insights`, optionally `instagram_business_content_publish` via
  `INSTAGRAM_EXTRA_SCOPES` (`INSTAGRAM_OPTIONAL_SCOPES`). Authorize: `https://www.instagram.com/oauth/authorize`.
  Code exchange: `POST https://api.instagram.com/oauth/access_token`. Long-lived: `GET https://graph.instagram.com/access_token`.
  Refresh: `GET https://graph.instagram.com/refresh_access_token`. Posts: `GET /me/media`. Insights: `GET /{media-id}/insights`
  (`views,reach,saved,shares,likes`, falling back to smaller sets on HTTP 400).
- TikTok: API v2 (`TIKTOK_API_VERSION`). Authorize: `https://www.tiktok.com/v2/auth/authorize/`. Token:
  `POST https://open.tiktokapis.com/v2/oauth/token/` (form-encoded). User: `GET /v2/user/info/`. Videos: `POST /v2/video/list/`
  (`max_count` up to 20, `cursor` in milliseconds). Scopes: `user.info.basic`, `video.list`, optionally `video.upload` and `video.publish` via
  `TIKTOK_EXTRA_SCOPES` (`TIKTOK_OPTIONAL_SCOPES`).
- Code: `lib/connectors/types.ts` (contract and shared helpers), `instagram.ts`, `tiktok.ts`, `index.ts` (`CONNECTORS`).

## Sources

All read on 2026-09-30.

Instagram (Meta for Developers):

- Business Login for Instagram (authorization window, code exchange, long-lived token): <https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login>
- Get started with Instagram API with Instagram Login (`/me`, `/<IG_ID>/media`, v25.0): <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started>
- Long-lived token exchange: <https://developers.facebook.com/documentation/instagram-platform/reference/access_token>
- Refresh access token: <https://developers.facebook.com/documentation/instagram-platform/reference/refresh_access_token>
- `/me`: <https://developers.facebook.com/documentation/instagram-platform/reference/me>
- IG Media fields: <https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media>
- IG Media insights (metrics per media type): <https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights>
- Insights overview (permission `instagram_business_manage_insights`): <https://developers.facebook.com/documentation/instagram-platform/insights>
- IG User media edge (10K most recent, stories excluded): <https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media>
- Platform overview (rate limits, Standard vs Advanced access): <https://developers.facebook.com/docs/instagram-platform/overview>
- App Review: <https://developers.facebook.com/documentation/instagram-platform/app-review>
- Changelog (insights deprecations, `views`): <https://developers.facebook.com/documentation/instagram-platform/changelog>
- Graph API versions: <https://developers.facebook.com/docs/graph-api/changelog>
- Documentation index: <https://developers.facebook.com/documentation/instagram-platform/llms.txt>
- Instagram Tester invitations (community answer, the official roles page does not mention them): <https://developers.facebook.com/community/threads/2645731442173067/>

TikTok for Developers:

- Login Kit for Web: <https://developers.tiktok.com/doc/login-kit-web>
- Manage user access tokens (token endpoint, lifetimes): <https://developers.tiktok.com/doc/oauth-user-access-token-management>
- Get user info: <https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info>
- List videos: <https://developers.tiktok.com/doc/tiktok-api-v2-video-list>
- Video object: <https://developers.tiktok.com/doc/tiktok-api-v2-video-object>
- Error handling: <https://developers.tiktok.com/doc/tiktok-api-v2-error-handling>
- Rate limits: <https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit>
- Scopes: <https://developers.tiktok.com/doc/tiktok-api-scopes>
- Display API get started: <https://developers.tiktok.com/docs/en/display-api-get-started>
- Add a sandbox: <https://developers.tiktok.com/docs/en/add-a-sandbox>
- Sandbox announcement: <https://developers.tiktok.com/blog/introducing-sandbox>
- App review guidelines: <https://developers.tiktok.com/doc/app-review-guidelines>

LinkedIn (Microsoft Learn):

- Community Management overview: <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-09>
- Community Management app review: <https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-09>
- Quick start (apply for API access): <https://learn.microsoft.com/en-us/linkedin/marketing/quick-start?view=li-lms-2026-09>
- Member post statistics: <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics?view=li-lms-2026-07>
- Organization share statistics: <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics?view=li-lms-2026-09>
