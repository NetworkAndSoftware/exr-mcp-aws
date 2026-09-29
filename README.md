# exr-mcp-aws

An MCP (Model Context Protocol) server that lets Claude create custom rowing workouts in [EXR](https://exrgame.com), the indoor rowing app. It runs on AWS Lambda as a claude.ai custom connector, so it works in claude.ai on the web, on mobile and in Claude Desktop. Several people can share one deployment, and each signs in with their own EXR account.

It's meant for a training coach in Claude that plans workouts in [intervals.icu](https://intervals.icu): Claude reads the planned rowing workout there and creates it in EXR, with the date in the title. That avoids EXR's in-app Training Editor.

- "Put today's row into EXR."
- "Create the EXR workouts for this week's planned rows."
- "Which custom workouts do I have in EXR? Delete the ones from last month."

## Tools

| Tool | Description |
|------|-------------|
| `create_workout` | Creates a workout from steps in intervals.icu's `workout_doc` format, with the date in front of the title. `dry_run` previews the blocks without creating anything. |
| `list_workouts` | The custom workouts in the EXR account, newest first: ID, title, description and total length. |
| `get_workout` | One workout, block by block: length, power target in % of FTP (or free row) and stroke rate. |
| `delete_workouts` | Deletes workouts. EXR has no undo. |

New workouts show up in the EXR app after a restart, under **Training Mode → My Workouts**.

### From intervals.icu to EXR

EXR workouts are simpler than intervals.icu's, so `create_workout` converts:

| intervals.icu | EXR |
|---------------|-----|
| Power in % FTP | The same %, of the FTP set in EXR |
| Power in watts | % of `ftp_watts`, which Claude passes |
| Range, e.g. 55–65% | Its midpoint, 60% |
| Ramp, e.g. 5 min from 45% to 60% | Steps of about a minute (or 250 m), each at the ramp's power halfway through it |
| Cadence | Stroke rate (spm) |
| Repeats | Written out in full |
| Free ride, or a heart rate or pace target | A free-row block (no power target) |

A workout is all timed or all distance-based. EXR can't mix the two, so `create_workout` refuses workouts that do. Other power units (such as zones) have to be converted to % FTP first.

## Setup

You need an AWS account and an EXR account.

Install Node.js 20+, the AWS CLI and the SAM CLI, then sign in to AWS with a default region:

```bash
winget install OpenJS.NodeJS.LTS
winget install Amazon.AWSCLI
winget install Amazon.SAM-CLI
aws configure        # or: aws login
npm install
```

### 1. Deploy

```bash
npm run deploy
```

Confirm the changeset when asked. The output ends with `McpServerUrl`, which people add to claude.ai. `sam list stack-outputs` shows it again later.

### 2. Allow your EXR account

```bash
npm run admin -- allow you@example.com
```

Use the email address you sign in to EXR with.

### 3. Connect Claude

In claude.ai, go to **Settings → Connectors → Add custom connector** and paste the `McpServerUrl` (it ends in `/mcp`). Click **Connect** and sign in with your EXR email and password.

The connector then works on web and mobile, and in Claude Desktop. To use it in a training-coach project, enable it in that project's chat, next to the intervals.icu connector.

## Adding someone

1. Run `npm run admin -- allow their@email.com` with the email of their EXR account.
2. Send them the `McpServerUrl`. They add the connector in their own claude.ai account and sign in with their EXR account. On the Free plan, claude.ai allows one custom connector.

Each person sees only their own EXR workouts.

## Day to day

| Task | Command |
|------|---------|
| Deploy code changes | `npm run deploy` |
| Show who can connect | `npm run admin -- list` |
| Let someone connect | `npm run admin -- allow <email>` |
| Stop someone connecting (signs them out) | `npm run admin -- deny <email>` |
| Sign everyone out | `npm run admin -- sign-out-all` |
| Show the URL | `sam list stack-outputs` |
| Remove everything | `sam delete`, then `aws ssm delete-parameters --names /exr-mcp/MCP_SIGNING_SECRET /exr-mcp/ALLOWED_EMAILS` |

Lambda reads its settings once per cold start, so every `admin` change also replaces the function's running instances. That way changes take effect immediately.

## How it works

- **EXR:** EXR has no API, so the server uses the same pages and forms as a browser on the EXR website's [Custom workouts](https://account.exrgame.com/trainings) page: it uploads, downloads and deletes workout files there.
- **Sign-in:** claude.ai custom connectors only support OAuth, so the server is a small OAuth server with its own sign-in page. It checks the email against the allowlist, then signs in to EXR with the email and password. The password goes to EXR only; the server keeps nothing but EXR's "remember me" cookie.
- **Tokens:** Claude's access and refresh tokens carry that cookie, encrypted (AES-256-GCM) with a key only the server has. Every hour Claude refreshes its token, and the server checks that EXR still accepts the cookie. If it doesn't, Claude asks you to connect again.
- **No database:** nothing is stored per person. The signing secret and the allowlist are SecureString parameters in SSM Parameter Store, so they never appear in the function's configuration or in the repo.
- **Cost:** normally $0, within Lambda's always-free allowance (1M requests and 400,000 GB-seconds a month). Set up an AWS budget alert anyway.

## Running locally

For testing, or for MCP clients on your own machine, the same server runs locally with settings from `.env`:

1. Copy `.env.example` to `.env` and fill it in.
2. Run:
   ```bash
   npm run build
   npm start
   ```

The server listens on `http://localhost:3000/mcp`. For example: `claude mcp add --transport http exr http://localhost:3000/mcp`.

## Known limitations

- **Logging out of the EXR website** signs out every connection to the same EXR account, because EXR then invalidates all of its "remember me" cookies. Claude asks you to connect again.
- **Relies on EXR's website:** a redesign of the Custom workouts page can break the server until it's updated.
- **Checksum:** EXR's workout files carry a checksum whose algorithm isn't public. The server writes its own, which the EXR website and app accept today. A future EXR version could start checking it.

## License

MIT
