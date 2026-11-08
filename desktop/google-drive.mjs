import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const SCOPE = 'openid email https://www.googleapis.com/auth/drive.appdata';
export function requireDriveConsent(tokens) {
  const granted = new Set(String(tokens.scope || '').split(/\s+/));
  if (!granted.has('https://www.googleapis.com/auth/drive.appdata'))
    throw new Error(
      'Drive permission was not selected. Sign in again and allow “See, create, and delete its own configuration data in your Google Drive.” Your other Drive files are not requested.',
    );
  if (!tokens.refresh_token)
    throw new Error('Google did not grant offline access. Sign in again to enable sync.');
}
export function validateClient(input) {
  const c = input.installed || input;
  if (
    !c ||
    typeof c.client_id !== 'string' ||
    !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(c.client_id) ||
    (c.client_secret !== undefined && typeof c.client_secret !== 'string')
  )
    throw new Error('Choose a Google Desktop app OAuth client JSON file.');
  return {
    client_id: c.client_id,
    ...(c.client_secret ? { client_secret: c.client_secret } : {}),
  };
}
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `Google request failed (${response.status}). Check your connection, consent, and Drive API configuration.`,
    );
  return response.json();
}
export async function authorize(client, openBrowser) {
  const state = randomBytes(32).toString('base64url'),
    verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let complete, fail;
  const result = new Promise((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  // Attach immediately so browser-launch failures cannot create an unhandled rejection.
  result.catch(() => {});
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const supplied = Buffer.from(u.searchParams.get('state') || '');
    if (
      u.pathname !== '/oauth/callback' ||
      supplied.length !== state.length ||
      !timingSafeEqual(supplied, Buffer.from(state))
    ) {
      res.writeHead(400);
      res.end('Invalid sign-in response.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.end('You can close this tab and return to Orbis.');
    if (u.searchParams.get('error') || !u.searchParams.get('code'))
      fail(new Error('Google sign-in was cancelled.'));
    else complete(u.searchParams.get('code'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const timer = setTimeout(
    () => fail(new Error('Google sign-in timed out. Try again.')),
    300000,
  );
  const redirect_uri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  try {
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri,
      response_type: 'code',
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent select_account',
    });
    await openBrowser(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    const code = await result;
    const tokens = await jsonRequest('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        ...client,
        code,
        code_verifier: verifier,
        redirect_uri,
        grant_type: 'authorization_code',
      }),
    });
    requireDriveConsent(tokens);
    const user = await jsonRequest('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    return { refresh_token: tokens.refresh_token, email: user.email, sub: user.sub };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

export class Drive {
  constructor(client, credentials) {
    this.client = client;
    this.credentials = credentials;
  }
  async token() {
    if (!this.access || Date.now() > this.expires) {
      const result = await jsonRequest('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          ...this.client,
          refresh_token: this.credentials.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      this.access = result.access_token;
      this.expires = Date.now() + (result.expires_in - 60) * 1000;
    }
    return this.access;
  }
  async request(path, options = {}, upload = false) {
    const response = await fetch(
      `https://www.googleapis.com/${upload ? 'upload/' : ''}drive/v3/${path}`,
      {
        ...options,
        signal: AbortSignal.timeout(60000),
        redirect: 'error',
        headers: { ...options.headers, Authorization: `Bearer ${await this.token()}` },
      },
    );
    if (!response.ok) {
      if (response.status === 401) this.access = null;
      if (response.status === 403) {
        const failure = await response.json().catch(() => ({}));
        if (failure.error?.errors?.some((item) => item.reason === 'storageQuotaExceeded'))
          throw new Error(
            'Google Drive storage is full. Free space in your Drive, then retry sync. Local originals and edits are preserved.',
          );
      }
      if (response.status === 429)
        throw new Error(
          'Google Drive is limiting requests. Automatic sync will retry with backoff; local edits are preserved.',
        );
      throw new Error(
        `Drive sync failed (${response.status}). Your local changes are safe; reconnect if access was revoked.`,
      );
    }
    return response;
  }
  async list(kind, vault) {
    let pageToken,
      files = [];
    do {
      const q =
        `trashed = false and appProperties has { key='orbisKind' and value='${kind}' }` +
        (vault ? ` and appProperties has { key='vault' and value='${vault}' }` : '');
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        q,
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,appProperties)',
        ...(pageToken ? { pageToken } : {}),
      });
      const result = await (await this.request(`files?${params}`)).json();
      files.push(...(result.files || []));
      pageToken = result.nextPageToken;
    } while (pageToken);
    return files;
  }
  async create(name, properties, bytes) {
    const boundary = 'orbis' + randomBytes(16).toString('hex');
    const metadata = { name, parents: ['appDataFolder'], appProperties: properties };
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return (
      await this.request(
        'files?uploadType=multipart&fields=id',
        {
          method: 'POST',
          body,
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        },
        true,
      )
    ).json();
  }
  async download(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid Drive file');
    const response = await this.request(`files/${id}?alt=media`);
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 32 * 1024 * 1024) throw new Error('Sync file exceeds the download limit');
      parts.push(part);
    }
    return Buffer.concat(parts);
  }
}
