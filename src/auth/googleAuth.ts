import { readFile } from 'node:fs/promises';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { AppConfig } from '../config.js';

interface TokenFile {
  refresh_token?: string;
}

export async function loadRefreshToken(config: AppConfig): Promise<string> {
  if (config.googleRefreshToken) return config.googleRefreshToken;

  try {
    const tokenFile = JSON.parse(await readFile(config.gmailTokenPath, 'utf8')) as TokenFile;
    if (tokenFile.refresh_token?.trim()) return tokenFile.refresh_token.trim();
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT') throw error;
  }

  throw new Error(
    'No Gmail OAuth refresh token configured. Set GOOGLE_REFRESH_TOKEN or run `npm run auth:init` and configure GMAIL_TOKEN_PATH.',
  );
}

export async function createOAuthClient(config: AppConfig): Promise<OAuth2Client> {
  const client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    config.googleRedirectUri,
  );
  client.setCredentials({ refresh_token: await loadRefreshToken(config) });
  return client;
}

export async function createGmailClient(config: AppConfig) {
  const auth = await createOAuthClient(config);
  return google.gmail({ version: 'v1', auth });
}

export async function createDriveClient(config: AppConfig) {
  const auth = await createOAuthClient(config);
  return google.drive({ version: 'v3', auth });
}

export async function createPeopleClient(config: AppConfig) {
  const auth = await createOAuthClient(config);
  return google.people({ version: 'v1', auth });
}
