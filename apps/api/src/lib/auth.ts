/**
 * Public site tokens → site (tenant, allowed origins). The token is public by design (it ships in the
 * widget), so the origin allow-list + rate limits + daily budget are the real controls.
 */
import { sql, type SiteRow } from './db.js';

const cache = new Map<string, { site: SiteRow | null; at: number }>();
const TTL_MS = 60_000;

export async function siteForToken(token: string): Promise<SiteRow | null> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.site;
  const [site] = await sql<SiteRow[]>`select * from sites where public_token = ${token}`;
  cache.set(token, { site: site ?? null, at: Date.now() });
  return site ?? null;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9_\-.]{8,200})$/.exec(header.trim());
  return m ? m[1]! : null;
}

/**
 * Browsers always send Origin on cross-origin fetch POSTs. Requests without an Origin are only
 * accepted for tools like curl when `allowNoOrigin` is set (never in production).
 */
export function originAllowed(origin: string | undefined, site: SiteRow, allowNoOrigin = false): boolean {
  if (!origin) return allowNoOrigin;
  return site.allowed_origins.includes(origin);
}

export function clearSiteCache(): void {
  cache.clear();
}
