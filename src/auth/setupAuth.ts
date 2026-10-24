import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { URL } from 'node:url';
import { google } from 'googleapis';
import { loadConfig } from '../config.js';

const config = loadConfig();
const state = randomBytes(32).toString('hex');
const redirect = new URL(config.googleRedirectUri);

if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(redirect.hostname)) {
  throw new Error('auth:init only permits localhost HTTP redirect URIs for this local OAuth helper.');
}

const client = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);
const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: config.googleScopes,
  state,
  include_granted_scopes: true,
});

console.error('\nOpen this URL in your browser to authorize Gmail MCP:\n');
console.error(authUrl);
console.error('\nWaiting for OAuth callback...\n');

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? '/', `http://${redirect.host}`);
    if (requestUrl.pathname !== redirect.pathname) {
      res.writeHead(404).end('Not Found');
      return;
    }

    if (requestUrl.searchParams.get('state') !== state) {
      res.writeHead(400).end('Invalid OAuth state');
      return;
    }

    const code = requestUrl.searchParams.get('code');
    const oauthError = requestUrl.searchParams.get('error');
    if (oauthError) {
      res.writeHead(400).end(`OAuth error: ${oauthError}`);
      console.error(`Google OAuth authorization failed: ${oauthError}`);
      server.close(() => process.exit(1));
      return;
    }
    if (!code) {
      res.writeHead(400).end('Missing OAuth code');
      return;
    }

    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      res.writeHead(400).end('No refresh token returned. Revoke the app grant and retry auth:init.');
      throw new Error('Google did not return a refresh token. Revoke the previous grant and retry auth:init.');
    }

    const tokenPath = resolve(config.gmailTokenPath);
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Authorization successful. You may close this browser tab.');
    console.error(`Saved OAuth token to ${tokenPath}`);
    setTimeout(() => server.close(() => process.exit(0)), 50);
  } catch (error) {
    res.writeHead(500).end('OAuth setup failed. Check the terminal for details.');
    console.error(error instanceof Error ? error.message : error);
  }
});

server.listen(Number(redirect.port || 80), redirect.hostname, () => {
  console.error(`Listening on ${config.googleRedirectUri}`);
});
