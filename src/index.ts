import "dotenv/config";
import { S3Archive } from "./archive.js";
import { createHttpApp, parseAllowedEmails, redirectUrisFromEnv } from "./http.js";

// Local run of the server that Lambda hosts (src/lambda.ts), with settings from .env instead of
// SSM. For testing, or for MCP clients on this machine: http://localhost:3000/mcp. The archive is
// an S3 bucket, e.g. the deployed stack's (ArchiveBucket output), with your own AWS credentials.

const required = ["MCP_SIGNING_SECRET", "ALLOWED_EMAILS", "ARCHIVE_BUCKET"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")} in the environment. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const app = createHttpApp({
  archive: (email) => new S3Archive(process.env.ARCHIVE_BUCKET!, email),
  archiveDays: Number(process.env.ARCHIVE_DAYS ?? 5),
  allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS!),
  signingSecret: process.env.MCP_SIGNING_SECRET!,
  redirectUris: redirectUrisFromEnv(process.env.OAUTH_REDIRECT_URIS),
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
});
app.listen(port, () => console.error(`EXR MCP server listening on http://localhost:${port}/mcp`));
