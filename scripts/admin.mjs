// Manages the Lambda-hosted server's settings: who can connect, and the token-signing secret.
// They're SecureString parameters in SSM Parameter Store, in the region of your default AWS
// profile (the one `sam deploy` uses). Lambda reads them once per cold start, so every change
// here also recycles the function's running instances.
import { randomBytes } from "node:crypto";
import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { LambdaClient, ResourceNotFoundException, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";

const USAGE = `Usage: npm run admin -- <command>

  allow <email>...      Let EXR accounts connect
  deny <email>...       Stop EXR accounts connecting (signs them out everywhere)
  list                  Show who can connect
  sign-out-all          Replace the signing secret (everyone has to connect again)`;

const prefix = process.env.SSM_PREFIX ?? "/exr-mcp";
const functionName = "exr-mcp"; // FunctionName in template.yaml
const ssm = new SSMClient({});
const lambda = new LambdaClient({});
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const [command, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function getParameter(name) {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: `${prefix}/${name}`, WithDecryption: true }));
    return result.Parameter.Value;
  } catch (error) {
    if (error instanceof ParameterNotFound) return undefined;
    throw error;
  }
}

async function putParameter(name, value) {
  await ssm.send(new PutParameterCommand({ Name: `${prefix}/${name}`, Value: value, Type: "SecureString", Overwrite: true }));
}

async function loadEmails() {
  return JSON.parse((await getParameter("ALLOWED_EMAILS")) ?? "[]");
}

async function saveEmails(emails) {
  if (!(await getParameter("MCP_SIGNING_SECRET"))) await putParameter("MCP_SIGNING_SECRET", randomBytes(32).toString("hex"));
  // A JSON array, as SSM values can't be empty
  await putParameter("ALLOWED_EMAILS", JSON.stringify([...new Set(emails)].sort()));
}

function parseEmails(values) {
  if (values.length === 0) fail(`${command} needs at least one email address`);
  const emails = values.map((value) => value.trim().toLowerCase());
  const invalid = emails.filter((email) => !EMAIL.test(email));
  if (invalid.length > 0) fail(`Not valid email addresses: ${invalid.join(", ")}`);
  return emails;
}

// Any configuration change makes Lambda start fresh instances, which read the new values
async function recycleLambda() {
  try {
    await lambda.send(
      new UpdateFunctionConfigurationCommand({ FunctionName: functionName, Description: `Settings updated ${new Date().toISOString()}` })
    );
    console.log(`Recycled ${functionName} so it picks up the change.`);
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
    console.log(`${functionName} isn't deployed yet; run npm run deploy next.`);
  }
}

if (!command) {
  console.log(USAGE);
  process.exit(0);
}
console.log(`Region: ${await ssm.config.region()}`);

switch (command) {
  case "allow": {
    const added = parseEmails(args);
    const current = await loadEmails();
    await saveEmails([...current, ...added]);
    for (const email of added) console.log(current.includes(email) ? `${email} already can connect.` : `${email} can connect.`);
    await recycleLambda();
    break;
  }

  case "deny": {
    const removed = parseEmails(args);
    const current = await loadEmails();
    const unknown = removed.filter((email) => !current.includes(email));
    if (unknown.length > 0) fail(`Not on the allowlist: ${unknown.join(", ")}`);
    const remaining = current.filter((email) => !removed.includes(email));
    if (remaining.length === 0) fail("Can't remove the last email; the server needs at least one. Use sam delete to take it down.");
    await saveEmails(remaining);
    for (const email of removed) console.log(`${email} can no longer connect.`);
    await recycleLambda();
    break;
  }

  case "list": {
    const emails = await loadEmails();
    console.log(emails.length > 0 ? `Can connect:\n${emails.map((e) => `  ${e}`).join("\n")}` : "Nobody can connect yet (npm run admin -- allow <email>)");
    break;
  }

  case "sign-out-all": {
    await putParameter("MCP_SIGNING_SECRET", randomBytes(32).toString("hex"));
    console.log("Replaced the signing secret: everyone has to connect again.");
    await recycleLambda();
    break;
  }

  default:
    console.log(USAGE);
    process.exitCode = 1;
}
