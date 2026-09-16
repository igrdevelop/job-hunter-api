import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { isIP } from 'net';

/**
 * Throttles the public /auth/* routes per real client IP.
 *
 * In production every request reaches this API through the `cloudflared`
 * container (Cloudflare Tunnel) over the compose network, so `req.ip` is that
 * container's Docker address for EVERY visitor — keying on it put all clients
 * into one shared bucket, letting anyone exhaust it and lock the owner out of
 * /auth/login. Cloudflare sets `CF-Connecting-IP` to the real client address,
 * so that header is used when present.
 *
 * SECURITY ASSUMPTION: this is only safe while the API port is reachable
 * solely through the tunnel. `docker-compose.prod.yml` binds it to
 * `127.0.0.1:3000` (not published on public interfaces), and cloudflared
 * reaches it as `http://job-hunter-api:3000` on the compose network. If the
 * port is ever published publicly (e.g. `"3000:3000"`) or another ingress is
 * added, a caller could forge `CF-Connecting-IP` per request and get an
 * unlimited number of login attempts — revisit this guard before doing that.
 *
 * Without the header (local dev, e2e) or with a value that is not a valid
 * IP, it falls back to `req.ip`, i.e. the stock ThrottlerGuard behavior.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(clientIpFromCloudflare(req) ?? (req.ip as string));
  }
}

function clientIpFromCloudflare(req: Record<string, unknown>): string | null {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const raw = headers?.['cf-connecting-ip'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') {
    return null;
  }
  // Cloudflare sends a single address; take the first entry defensively in
  // case a list ever arrives.
  const candidate = first.split(',')[0].trim();
  return isIP(candidate) ? candidate : null;
}
