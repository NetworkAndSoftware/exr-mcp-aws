import { randomInt } from "node:crypto";
import type { Request, Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ExrClient, ExrSignedOutError, signIn, type RememberCookie } from "./exr.js";
import { now, Sealer } from "./seal.js";

// OAuth server for claude.ai custom connectors, which only support OAuth or no auth. People sign
// in with their own EXR account: authorize() shows a page asking for their EXR email and
// password, and POST /login signs in to EXR with them. The password goes to EXR and nowhere
// else; the connection keeps only EXR's remember cookie.
//
// Everything is stateless so it runs on Lambda without a database: client IDs, codes and tokens
// are sealed (encrypted) claims, and access and refresh tokens carry the EXR remember cookie. The
// trade-offs: a single token can't be revoked (removing an email from the allowlist signs that
// person out, and changing MCP_SIGNING_SECRET signs out everyone), and codes can't be marked as
// used, so they're short-lived and PKCE-bound instead.

export const LOGIN_PATH = "/login";

const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
// Renewed on every refresh. EXR's remember cookie lasts 5 years.
const REFRESH_TOKEN_TTL = 180 * 24 * 60 * 60;
const CODE_TTL = 2 * 60;
const LOGIN_FORM_TTL = 10 * 60;

// Bump the version if a claims type changes incompatibly: older values then fail to open
const KIND = {
  client: "exr-mcp/v1/client",
  login: "exr-mcp/v1/login",
  code: "exr-mcp/v1/code",
  access: "exr-mcp/v1/access",
  refresh: "exr-mcp/v1/refresh",
};

type ClientClaims = { r: string[]; m: string; exp?: never };
// An authorization request from Claude, carried by the sign-in form
type LoginClaims = { cid: string; ru: string; cc: string; st?: string; sc: string[]; exp: number };
type CodeClaims = { cid: string; ru: string; cc: string; sc: string[]; email: string; rc: RememberCookie; exp: number };
type TokenClaims = { cid: string; sc: string[]; email: string; rc: RememberCookie; exp: number };

export type ExrSignInOptions = {
  // EXR account emails that may connect
  allowedEmails: string[];
  signingSecret: string;
  // Redirect URIs a client may register, e.g. claude.ai's connector callback
  redirectUris: string[];
  // The MCP endpoint these tokens are for
  resourceUrl: URL;
};

export class ExrSignInProvider implements OAuthServerProvider {
  private sealer: Sealer;
  private allowedEmails: Set<string>;

  constructor(private options: ExrSignInOptions) {
    this.sealer = new Sealer(options.signingSecret);
    this.allowedEmails = new Set(options.allowedEmails.map((email) => email.toLowerCase()));
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => {
        const disallowed = client.redirect_uris.filter((uri) => !this.options.redirectUris.includes(uri));
        if (disallowed.length > 0) {
          throw new InvalidClientMetadataError(`redirect_uri not allowed: ${disallowed.join(", ")}`);
        }
        const method = client.token_endpoint_auth_method ?? (client.client_secret ? "client_secret_post" : "none");
        const clientId = this.sealer.seal(KIND.client, { r: client.redirect_uris, m: method } satisfies ClientClaims);
        return { ...client, ...this.getClient(clientId)!, client_id_issued_at: now() };
      },
    };
  }

  private getClient(clientId: string): OAuthClientInformationFull | undefined {
    const claims = this.sealer.open<ClientClaims>(KIND.client, clientId);
    if (!claims) return undefined;
    return {
      client_id: clientId,
      redirect_uris: claims.r.filter((uri) => this.options.redirectUris.includes(uri)),
      token_endpoint_auth_method: claims.m,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Confidential clients get a secret derived from their ID, so it needn't be stored
      ...(claims.m === "none"
        ? {}
        : { client_secret: this.sealer.mac(`secret:${clientId}`), client_secret_expires_at: 0 }),
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const request = this.sealer.seal(KIND.login, {
      cid: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: params.scopes ?? [],
      exp: now() + LOGIN_FORM_TTL,
    } satisfies LoginClaims);
    this.sendLoginPage(res, request, params.redirectUri);
  }

  // POST /login, submitted by the page from authorize()
  async handleLogin(req: Request, res: Response): Promise<void> {
    const request = typeof req.body?.request === "string" ? req.body.request : "";
    const login = this.sealer.open<LoginClaims>(KIND.login, request);
    if (!login || !this.getClient(login.cid)?.redirect_uris.includes(login.ru)) {
      this.sendPage(res.status(400), "<p>This sign-in link has expired. Start connecting again from Claude.</p>");
      return;
    }

    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    // Checked before contacting EXR, so the page can't be used to try passwords on other accounts
    if (!this.isAllowed(email)) {
      await pause();
      const message = `${email || "That email address"} isn't allowed to use this server. Ask the person who runs it to add your EXR account's email address.`;
      this.sendLoginPage(res.status(403), request, login.ru, message, email);
      return;
    }
    let remember: RememberCookie | undefined;
    try {
      remember = await signIn(email, password);
    } catch (error) {
      console.error("EXR sign-in failed:", error);
      this.sendLoginPage(res.status(502), request, login.ru, "Couldn't reach EXR. Try again in a moment.", email);
      return;
    }
    if (!remember) {
      await pause();
      this.sendLoginPage(res.status(401), request, login.ru, "EXR didn't accept that email and password.", email);
      return;
    }

    const code = this.sealer.seal(KIND.code, {
      cid: login.cid,
      ru: login.ru,
      cc: login.cc,
      sc: login.sc,
      email,
      rc: remember,
      exp: now() + CODE_TTL,
    } satisfies CodeClaims);
    const target = new URL(login.ru);
    target.searchParams.set("code", code);
    if (login.st !== undefined) target.searchParams.set("state", login.st);
    res.set("Cache-Control", "no-store").redirect(302, target.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.verifyCode(client, authorizationCode).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const claims = this.verifyCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== claims.ru) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.checkResource(resource);
    return this.issueTokens(client.client_id, claims);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const claims = this.sealer.open<TokenClaims>(KIND.refresh, refreshToken);
    if (!claims || claims.cid !== client.client_id || !this.isAllowed(claims.email)) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    this.checkResource(resource);

    // Checks the EXR cookie still works, so Claude asks the person to connect again once it
    // doesn't. Other failures (EXR unreachable) leave the refresh token usable for a retry.
    try {
      await new ExrClient(claims.rc).check();
    } catch (error) {
      if (error instanceof ExrSignedOutError) {
        console.warn(`EXR signed out ${claims.email}`);
        throw new InvalidGrantError("EXR has signed this connection out; connect again");
      }
      console.error("Checking the EXR sign-in failed:", error);
      throw new ServerError("Couldn't reach EXR; try again");
    }
    return this.issueTokens(client.client_id, claims);
  }

  // AuthInfo.extra carries the signed-in person's email and EXR remember cookie
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = this.sealer.open<TokenClaims>(KIND.access, token);
    if (!claims || !this.isAllowed(claims.email)) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: claims.cid,
      scopes: claims.sc,
      expiresAt: claims.exp,
      resource: this.options.resourceUrl,
      extra: { email: claims.email, exrRemember: claims.rc },
    };
  }

  private verifyCode(client: OAuthClientInformationFull, code: string): CodeClaims {
    const claims = this.sealer.open<CodeClaims>(KIND.code, code);
    if (!claims || claims.cid !== client.client_id || !this.isAllowed(claims.email)) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return claims;
  }

  private isAllowed(email: string): boolean {
    return this.allowedEmails.has(email);
  }

  private checkResource(resource: URL | undefined) {
    if (resource && resource.href !== this.options.resourceUrl.href) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.options.resourceUrl.href}`);
    }
  }

  private issueTokens(clientId: string, { sc, email, rc }: { sc: string[]; email: string; rc: RememberCookie }): OAuthTokens {
    const issuedAt = now();
    const claims = { cid: clientId, sc, email, rc };
    return {
      access_token: this.sealer.seal(KIND.access, { ...claims, exp: issuedAt + ACCESS_TOKEN_TTL } satisfies TokenClaims),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: this.sealer.seal(KIND.refresh, { ...claims, exp: issuedAt + REFRESH_TOKEN_TTL } satisfies TokenClaims),
      ...(sc.length > 0 ? { scope: sc.join(" ") } : {}),
    };
  }

  private sendLoginPage(res: Response, request: string, redirectUri: string, error?: string, email = "") {
    this.sendPage(
      res,
      `<p>Connect <strong>${escapeHtml(new URL(redirectUri).host)}</strong> to the custom workouts in your EXR account.</p>
      <form method="post" action="${LOGIN_PATH}">
        <input type="hidden" name="request" value="${escapeHtml(request)}">
        <label for="email">EXR email</label>
        <input id="email" name="email" type="email" value="${escapeHtml(email)}" autocomplete="username" autocapitalize="none" spellcheck="false" required${email ? "" : " autofocus"}>
        <label for="password">EXR password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required${email ? " autofocus" : ""}>
        ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
        <button type="submit">Allow access</button>
      </form>
      <p class="muted">Your password is only passed on to EXR to sign in. This server doesn't store it.</p>`
    );
  }

  private sendPage(res: Response, body: string) {
    // The sign-in form redirects to the client, and Chrome applies form-action to that redirect too
    const formTargets = [...new Set(this.options.redirectUris.map((uri) => new URL(uri).origin))];
    res
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formTargets.join(" ")}; frame-ancestors 'none'; base-uri 'none'`,
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      })
      .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EXR MCP sign-in</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f7f9; --card: #fff; --text: #1a1d21; --muted: #676d75; --accent: #0e7490; --error: #b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #131517; --card: #1f2226; --text: #eceef1; --muted: #a1a7ae; --accent: #22d3ee; --error: #f87171; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(360px, calc(100vw - 32px)); background: var(--card); border-radius: 12px; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  label { display: block; margin-top: 16px; font-weight: 600; }
  input[type=email], input[type=password] { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px 12px; font: inherit; border: 1px solid var(--muted); border-radius: 8px; background: transparent; color: inherit; }
  button { width: 100%; margin-top: 16px; padding: 12px; font: inherit; font-weight: 600; border: 0; border-radius: 8px; background: var(--accent); color: #fff; }
  @media (prefers-color-scheme: dark) { button { color: #0b1f24; } }
  .error { color: var(--error); margin: 8px 0 0; }
  .muted { color: var(--muted); font-size: 14px; margin: 16px 0 0; }
</style>
</head>
<body><main><h1>EXR MCP</h1>${body}</main></body>
</html>`);
  }
}

// Slows down guessing
const pause = () => new Promise((resolve) => setTimeout(resolve, 500 + randomInt(500)));

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
