import { WorkerEntrypoint } from 'cloudflare:workers';

/** Named service entrypoint on discord-linear-sync. Its public fetch handler stays unchanged. */
export class SimKitSupportLinear extends WorkerEntrypoint<{ LINEAR_API_KEY: string }> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    // This entrypoint is reachable only through an account-owned service binding.
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 32_768) return new Response(null, { status: 413 });
    if (new URL(request.url).pathname === '/asset') {
      if (!URL.canParse(body)) return new Response(null, { status: 400 });
      const asset = new URL(body);
      if (asset.origin !== 'https://uploads.linear.app') return new Response(null, { status: 400 });
      const response = await fetch(asset, { headers: { Authorization: this.env.LINEAR_API_KEY },
        signal: AbortSignal.timeout(8_000), redirect: 'manual' });
      const location = response.headers.get('Location');
      if (response.status < 300 || response.status >= 400 || !location) return response;
      if (!URL.canParse(location)) return new Response(null, { status: 502 });
      const target = new URL(location);
      if (target.protocol !== 'https:' || !(target.hostname.endsWith('.amazonaws.com')
        || target.hostname.endsWith('.cloudfront.net') || target.hostname === 'storage.googleapis.com'))
        return new Response(null, { status: 502 });
      // Follow only the signed storage URL, without the Linear credential.
      return fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(8_000) });
    }
    return fetch('https://api.linear.app/graphql', { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', Authorization: this.env.LINEAR_API_KEY },
      signal: AbortSignal.timeout(8_000), redirect: 'manual' });
  }
}
