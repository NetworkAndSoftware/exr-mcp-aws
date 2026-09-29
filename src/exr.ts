import type { ExrWorkoutFile } from "./workout.js";

// Client for the EXR web account at account.exrgame.com, a Laravel site with no public API. It
// uses the same pages and forms as a browser on the Custom workouts page (/trainings): a form
// POST to sign in, the workouts table to list, and form POSTs to upload and delete.
//
// Signing in returns a long-lived "remember me" cookie (remember_web_*, 5 years) that on its own
// signs a fresh client in, so that cookie is all a connection keeps. Laravel invalidates every
// remember cookie of an account when the person logs out of the EXR website anywhere.

const BASE = "https://account.exrgame.com";
const USER_AGENT = "exr-mcp (+https://github.com/NetworkAndSoftware/exr-mcp-aws)";
// Stops listing after this many pages of the workouts table
const MAX_PAGES = 20;

export type RememberCookie = { name: string; value: string };

// A row of the Custom workouts table. length is as EXR shows it: "0:30:00" or "5 km".
export type WorkoutListing = { id: string; title: string; description: string; length: string };

export class ExrSignedOutError extends Error {
  constructor() {
    super(
      "EXR has signed this connection out, for example after a log out on the EXR website. " +
        "Reconnect the EXR connector in Claude (Settings > Connectors) to sign in again."
    );
  }
}

// Signs in to EXR. Returns the remember cookie, or undefined when EXR rejects the email and
// password (Laravel also rejects every attempt for a while after too many failures).
export async function signIn(email: string, password: string): Promise<RememberCookie | undefined> {
  const jar = new CookieJar();
  const loginPage = await send(jar, "/login");
  const token = csrfToken(await loginPage.text());
  const response = await send(jar, "/login", { method: "POST", body: new URLSearchParams({ _token: token, mail: email, password }) });
  if (response.status !== 302) throw new Error(`EXR sign-in answered ${response.status}`);
  if (redirectsToLogin(response)) return undefined;
  const remember = jar.find((name) => name.startsWith("remember_web_"));
  if (!remember) throw new Error("EXR signed in but didn't set a remember cookie");
  return remember;
}

export class ExrClient {
  private jar = new CookieJar();

  constructor(remember: RememberCookie) {
    this.jar.set(remember.name, remember.value);
  }

  // Throws ExrSignedOutError if the remember cookie no longer works
  async check(): Promise<void> {
    await this.page("/trainings");
  }

  async listWorkouts(): Promise<WorkoutListing[]> {
    return (await this.readList()).workouts;
  }

  async downloadWorkout(id: string): Promise<ExrWorkoutFile> {
    // A download that is itself the request signing in with the remember cookie gets a 500
    if (!this.jar.find((name) => name === "exr_session")) await this.check();
    const response = await send(this.jar, `/trainings/download/${encodeURIComponent(id)}`);
    if (redirectsToLogin(response)) throw new ExrSignedOutError();
    const text = await response.text();
    if (!response.ok || !text.trimStart().startsWith("{")) throw new Error(`EXR has no workout ${id} (answered ${response.status})`);
    return JSON.parse(text) as ExrWorkoutFile;
  }

  // Returns the ID EXR gives the new workout
  async uploadWorkout(file: ExrWorkoutFile): Promise<string> {
    const before = await this.readList();
    const form = new FormData();
    form.set("_token", before.token);
    form.set("file", new Blob([JSON.stringify(file, null, 4)], { type: "application/json" }), `${file.metaData.guid}.json`);
    await this.postForm("/trainings/upload", form);

    // EXR answers every upload with a redirect, and silently drops files it doesn't accept
    const known = new Set(before.workouts.map((workout) => workout.id));
    const added = (await this.readList()).workouts.filter((workout) => !known.has(workout.id));
    const upload = added.find((workout) => workout.title === file.data.title.trim()) ?? added[0];
    if (!upload) throw new Error("EXR didn't accept the workout file (it rejects files it can't read without saying why)");
    return upload.id;
  }

  // Returns the workouts it deleted, and the IDs it didn't find
  async deleteWorkouts(ids: string[]): Promise<{ deleted: WorkoutListing[]; notFound: string[] }> {
    const before = await this.readList();
    const deleted = before.workouts.filter((workout) => ids.includes(workout.id));
    const notFound = ids.filter((id) => !deleted.some((workout) => workout.id === id));
    if (deleted.length === 0) return { deleted, notFound };

    await this.postForm(
      "/trainings/delete",
      // What the page's script sends; control is the "type delete to confirm" field
      new URLSearchParams({ _token: before.token, "selected-workouts": JSON.stringify(deleted.map((w) => w.id)), control: "delete" })
    );
    const remaining = new Set((await this.readList()).workouts.map((workout) => workout.id));
    const failed = deleted.filter((workout) => remaining.has(workout.id));
    if (failed.length > 0) throw new Error(`EXR didn't delete ${failed.map((w) => w.id).join(", ")}`);
    return { deleted, notFound };
  }

  // All pages of the workouts table, newest first, and the page's CSRF token for posting forms
  private async readList(): Promise<{ workouts: WorkoutListing[]; token: string }> {
    const first = await this.page("/trainings");
    const workouts = parseWorkouts(first);
    const pages = Math.min(Number(/var totalPages = (\d+)/.exec(first)?.[1] ?? 1), MAX_PAGES);
    for (let page = 2; page <= pages; page++) workouts.push(...parseWorkouts(await this.page(`/trainings/${page}`)));
    return { workouts, token: csrfToken(first) };
  }

  private async page(path: string): Promise<string> {
    const response = await send(this.jar, path);
    if (redirectsToLogin(response)) throw new ExrSignedOutError();
    if (!response.ok) throw new Error(`EXR ${path} answered ${response.status}`);
    return response.text();
  }

  // The Custom workouts forms answer with a redirect back to the page
  private async postForm(path: string, body: FormData | URLSearchParams): Promise<void> {
    const response = await send(this.jar, path, { method: "POST", body });
    if (redirectsToLogin(response)) throw new ExrSignedOutError();
    if (response.status !== 302) throw new Error(`EXR ${path} answered ${response.status}`);
  }
}

class CookieJar {
  private cookies = new Map<string, string>();

  set(name: string, value: string) {
    this.cookies.set(name, value);
  }

  find(match: (name: string) => boolean): RememberCookie | undefined {
    const name = [...this.cookies.keys()].find(match);
    return name === undefined ? undefined : { name, value: this.cookies.get(name)! };
  }

  update(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  get header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function send(jar: CookieJar, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(new URL(path, BASE), {
    ...init,
    // Redirects to /login are how EXR says a session isn't signed in
    redirect: "manual",
    headers: { "User-Agent": USER_AGENT, ...(jar.header ? { Cookie: jar.header } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  jar.update(response);
  return response;
}

function redirectsToLogin(response: Response): boolean {
  const location = response.headers.get("location");
  return response.status >= 300 && response.status < 400 && location !== null && new URL(location, BASE).pathname === "/login";
}

function csrfToken(html: string): string {
  const token = /name="_token" value="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error("EXR's page has no form token; its layout may have changed");
  return token;
}

// Rows of the workouts table. Columns: checkbox, title, description, length, download, delete.
function parseWorkouts(html: string): WorkoutListing[] {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? "";
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].flatMap(([, row]) => {
    const id = /name="selectedWorkouts\[\]"[^>]*value="([^"]+)"/.exec(row)?.[1];
    const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(([, cell]) => htmlText(cell));
    if (!id || cells.length < 4) return [];
    return [{ id, title: cells[1], description: cells[2], length: cells[3] }];
  });
}

function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (entity[0] !== "#") return named[entity.toLowerCase()];
      return String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    })
    .replace(/\s+/g, " ")
    .trim();
}
