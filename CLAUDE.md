# EXR MCP Server

## Project Overview

An MCP server that manages custom rowing workouts in the user's account for EXR (exrgame.com), an indoor rowing app. A Claude training coach plans rowing workouts in intervals.icu; this server turns them into EXR workouts, because EXR's in-app Training Editor is badly broken while uploading a workout file on the EXR website works. It's hosted on AWS Lambda as an OAuth-protected claude.ai custom connector (web, mobile, Desktop), shared by several people who each sign in with their own EXR account.

It's a sibling of `../intervals-icu-mcp` (planned workouts live there as `Rowing` WORKOUT events with a `workout_doc`), `../google-health-mcp-aws` (same stack; this project started as a copy of its layout) and `../wahoo-systm-mcp-aws`. The same coach uses all of them.

## Tech Stack

- **Runtime:** Node.js (TypeScript), ESM
- **MCP SDK:** `@modelcontextprotocol/sdk` (`McpServer.registerTool`, zod input schemas)
- **Transport:** stateless Streamable HTTP (Express + `serverless-http`) on Lambda; the same Express app locally (`npm start`)
- **Build:** `npx tsc` → `dist/` (local run); `npm run build:lambda` (esbuild) → single-file bundle in `dist-lambda/`
- **Hosting:** AWS Lambda + Function URL via SAM (`template.yaml`), settings in SSM Parameter Store
- No stdio mode, no cache, no test framework, no linter

## Project Structure

```
src/
├── index.ts          # Local entry point: the Lambda app on localhost:3000, settings from .env
├── lambda.ts         # Lambda entry point: settings from SSM, wraps the app with serverless-http
├── http.ts           # Express app: OAuth routes, POST /login, stateless /mcp
├── oauth.ts          # OAuth server for Claude; sign-in page takes the EXR email + password (stateless, sealed tokens)
├── seal.ts           # AES-256-GCM sealing of token claims
├── exr.ts            # EXR website client: sign in, list, download, upload, delete
├── workout.ts        # EXR workout file format; intervals.icu steps → EXR blocks; guid mark; summaries
├── archive.ts        # S3 archive of removed workouts, per EXR account
├── server.ts         # createMcpServer(client, archive, days): registers tools, server instructions
└── tools/
    └── workouts.ts   # create_workout, list_workouts, get_workout, archive_workouts,
                      # list_archived_workouts, restore_workout
scripts/
├── build-lambda.mjs  # esbuild bundle → dist-lambda/index.mjs
└── admin.mjs         # npm run admin: allowlist and signing secret in SSM; recycles the Lambda
```

## The EXR website

EXR has no public API. `exr.ts` uses the Custom workouts page of the account site, `https://account.exrgame.com/trainings`, the way a browser does. It's a Laravel app (nginx, PHP 7.4, Plesk; no CDN or WAF in front as of 2026-09-29). Everything below was checked against a real account on 2026-09-29.

- **Sign-in:** `GET /login` gives a session cookie and a `_token` (CSRF) hidden field. `POST /login` with form fields `_token`, `mail`, `password`:
  - Success: 302 to `/account`, and a `remember_web_<sha1>` cookie that expires after 5 years. It's set even though the "Remember me" checkbox has no `name` and isn't submitted.
  - Wrong credentials: 302 back to `/login`, no remember cookie. Laravel's login throttling looks the same.
- **Remember cookie:** on its own it signs a fresh client in, so it's all a connection keeps. Laravel cycles the account's remember token on any logout, which invalidates every remember cookie of that account. So a log out on the EXR website ends every connection. Don't call `/logout` in tests.
- **Signed out:** requests redirect (302) to `/login`. `exr.ts` turns that into `ExrSignedOutError`.
- **List:** the table on `/trainings`, newest first, with columns checkbox (value = workout ID), title, description, length and download/delete buttons. Length is `0:09:25` for timed workouts, `1.5 km` for distance. More pages are at `/trainings/{n}`, and the page script has `var totalPages = N`. How many rows a page holds hasn't been seen yet.
- **Upload:** `POST /trainings/upload`, multipart, fields `_token` and `file`. EXR always answers 302 to `/trainings`, with no message, and silently drops files it rejects. Rejected: invalid JSON, a missing or empty `checksum`. So `uploadWorkout` confirms the upload by finding a new ID in the list.
- **IDs:** EXR gives each upload its own ID and writes it into the stored file's `uuid`. It doesn't deduplicate on `metaData.guid` or title.
- **Download:** `GET /trainings/download/{id}` returns the stored file (`text/plain`). The `checksum` is kept as uploaded.
  - It answers 500 when the download is the request that signs in with the remember cookie, so the client views `/trainings` first.
  - An unknown ID gives 200 with a non-JSON body.
- **Delete:** `POST /trainings/delete`, form fields `_token`, `selected-workouts` (JSON array of IDs; the page's single-delete button sends `{"1":"<id>"}`, which isn't used here) and `control=delete` (the "type delete to confirm" field).

## Workout file format

From a known-good file that imports cleanly, and from what the website accepts:

```json
{
  "metaData": { "fileVersionNumber": 2, "guid": "<uuid>" },
  "data": {
    "category": "Custom Workouts",
    "title": "...",
    "unitType": 1,
    "description": "...",
    "schedule": [ { "length": 300, "FTPTarget": -1, "strokesPerMin": 0 }, ... ],
    "events": []
  },
  "editorData": { "eventLinks": [] },
  "checksum": "<32 hex>",
  "uuid": "<uuid>",
  "_id": 1
}
```

- `unitType`: 1 means time, with `length` in seconds (the example's 565 s shows as 0:09:25). 0 means distance, with `length` in meters (1500 shows as 1.5 km). 2 is accepted but shows no length, so it's not valid. A workout can't mix time and distance.
- `FTPTarget`: a fraction of the rower's FTP in EXR (1.5 is 150%). -1 means a free-row block, which EXR's editor offers for rest.
- `strokesPerMin`: a stroke rate target, 0 for none.
- `events` / `editorData.eventLinks`: always empty so far; what they hold is unknown.
- **Checksum:** EXR's algorithm is unknown.
  - It isn't a plain MD5 of any obvious serialization of `data`, `schedule` or the whole file (compact or indented, CRLF, float32 or `-1.0` number formats).
  - The website only requires a non-empty value; `"000…0"` and a stale checksum were both accepted. `workoutFile` writes an MD5 of `JSON.stringify(data)`.
  - The EXR app accepts that too: "2026-09-29 EXR row 30' Z2 — easy", uploaded this way, synced to the app and passed the user's check there on 2026-09-29, "—" in the title included.
- The EXR game (Unity, Mono) was removed from the development PC, so its code isn't available to read.

## Conversion (`convertSteps`)

Input is intervals.icu `workout_doc.steps`, passed unchanged. Unknown fields (`warmup`, `text`, `hr`, ...) are stripped by zod.

- Repeats (`reps` + nested `steps`) are written out in full. intervals.icu doesn't nest repeats, so the schema allows one level.
- Power in `%ftp` is used as-is. Watts (`"w"`) need `ftp_watts`. Other units (zones, `%mmp`) are errors, telling Claude to convert.
- Ranges (`start`/`end` without `ramp`) use the midpoint. Ramps become up to 10 equal steps of about 60 s or 250 m, each at the ramp's power halfway through it.
- Steps without a power target (heart rate or pace targets) and `freeride` steps become free rows.
- `cadence` becomes `strokesPerMin` (the midpoint of a range, rounded).
- The result's `notes` say which approximations were made, so Claude can tell the user.

## Removing workouts (soft delete)

Claude in claude.ai won't call a tool that permanently deletes data in someone's account, even when asked. It will call one whose removal can be undone. So there's no delete tool. Instead, `archive_workouts` removes workouts reversibly:

- **Archive first:** it downloads each workout and saves the complete EXR file to S3 (`archive/<encoded email>/<workout ID>.json`, with the listing and `archivedAt`). It only asks EXR to delete once every copy is saved. A failed save removes nothing.
- **Restore:** `restore_workout` uploads the archived file unchanged, so EXR gives it a new ID. The archive keeps its copy until it's purged. `list_archived_workouts` shows what can be restored, and until when.
- **Purge:** only the bucket's lifecycle rule purges, `ArchiveDays` after archiving. That's 5 days by default, and `ARCHIVE_DAYS` passes the value to the tool descriptions. S3 rounds expiry up to the next midnight UTC. The function's role can put, get and list objects but not delete them, and no tool purges. The bucket is kept when the stack is deleted (`DeletionPolicy: Retain`).
- **Scoping:** only workouts created through the connector can be removed, so hand-made ones like "My Training" are safe.
  - `workoutFile` gives each file a `metaData.guid` whose last 12 hex digits are a SHA-256 of `exr-mcp:` plus the rest. It's still a valid v4 UUID, and EXR keeps the guid as uploaded. `isCreatedHere` checks the mark after download.
  - Workouts created before the mark existed (2026-09-29) aren't marked and can only be removed on the website.
- The tool descriptions say all this, because Claude decides whether to call a tool from its description.

## Remote Hosting (AWS Lambda)

Setup and day-to-day commands are in README.md. Design notes and gotchas:

- **Why a sign-in page:** claude.ai connectors support only OAuth or no auth. `oauth.ts` is an authorization server on the SDK's `mcpAuthRouter` with DCR and PKCE.
  - `authorize()` shows a page asking for the EXR email and password. Claude's authorization request travels, sealed, in a hidden field.
  - `POST /login` checks the email against `ALLOWED_EMAILS` before contacting EXR, so the page can't be used to try passwords on other accounts. It then signs in to EXR and redirects to Claude with a code.
  - `/login` is rate-limited to 10 per 15 minutes per IP, and failures are delayed 0.5–1 s.
- **Stateless tokens:** client IDs, codes and tokens are sealed claims (AES-256-GCM, key derived from `MCP_SIGNING_SECRET`, with the token kind as associated data).
  - Access tokens (1 hour) and refresh tokens (180 days, renewed on use) carry the EXR remember cookie (`rc`). The password isn't kept anywhere.
  - `exchangeRefreshToken` checks the cookie against EXR. A signed-out cookie becomes `InvalidGrantError`, so Claude asks the person to reconnect. Other failures become `ServerError`, so the refresh can be retried.
  - A tool call with a dead cookie returns `ExrSignedOutError`'s message, which tells the person to reconnect.
- **Sign-out:** tokens carry the email, which is checked against the allowlist on every use, so `admin deny` signs someone out. `sign-out-all` rotates the signing secret.
- **Origin:** OAuth metadata needs absolute URLs, but a Lambda can't know its Function URL at deploy time. `http.ts` takes the origin from the `Host` header, only when it matches `*.lambda-url.*.on.aws`; `PUBLIC_URL` overrides this. Routes are built lazily, which is why the rate limiters have `creationStack` validation off.
- **serverless-http + MCP SDK:** the SDK's transport reads `req.rawHeaders`, which serverless-http leaves empty. `lambda.ts` rebuilds them; without that every MCP call fails with "Not Acceptable".
- **Stateless MCP:** a new `McpServer`, transport, `ExrClient` and archive (scoped to the token's email) per request (`sessionIdGenerator: undefined`, `enableJsonResponse: true`). GET and DELETE on `/mcp` return 405.
- **Settings:** two SecureStrings under `/exr-mcp/`: `MCP_SIGNING_SECRET` and `ALLOWED_EMAILS` (a JSON array). They're read once per cold start; a missing one fails the cold start. `scripts/admin.mjs` recycles the function after each change.
- **Archive bucket:** created by the stack, name in the `ArchiveBucket` output and the function's `ARCHIVE_BUCKET` variable.
- **Deploy:** `sam deploy` zips `dist-lambda/` as-is. Don't run `sam build`. `@aws-sdk/*` is external in the bundle because the Node.js runtime provides it. `@aws-sdk/client-s3` is still a dependency, for local runs.

## Testing

No test framework in the repo. What worked while building it (scripts kept outside the repo):

- A real EXR account in `.env` (`EXR_EMAIL`, `EXR_PASSWORD`; only test scripts read them). Name test workouts "ZZ MCP test …" and delete them afterwards.
- Import `dist/http.js`, start the app on localhost with the account's email in `allowedEmails`, and drive the whole flow with fetch: register, authorize, `POST /login` (also a disallowed email and a wrong password), token (PKCE), MCP `initialize`, `tools/list`, `tools/call` for every tool, then refresh.
- For the Lambda bundle, run `dist-lambda/index.mjs` with `node --import` and a `module.register` hook that swaps `@aws-sdk/client-ssm` for a stub. Then feed the handler Function URL (payload v2) events with a `*.lambda-url.*.on.aws` Host header.
- For archive logic without touching EXR: connect `createMcpServer` from `dist/server.js` to an MCP `Client` over `InMemoryTransport`, with a fake client (`listWorkouts`, `downloadWorkout`, `deleteWorkouts`, `uploadWorkout`) and a Map-backed archive. Log the call order to check that every copy is saved before the delete.
- `sam validate --lint` checks the template.

## Development Notes

- Keep the repo out of cloud-synced folders.
- The sign-in page escapes text, so "isn't" appears as `isn&#39;t` in its HTML; match on that in tests.
- Tool output is indented JSON, with workout blocks as one-line strings (`"5:00 57.5% FTP, 22 spm"`).
- `create_workout` puts `date` (default: today in UTC) in front of the title, unless the title already starts with it. The server instructions ask Claude to pass the user's local date.
