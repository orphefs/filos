// "owner/repo#n" for a pull request URL from the graph (https://<host>/<owner>/<repo>/pull/<n>).
// The URL comes from the agent or from gh, so it is untrusted: only a strict shape is recognised
// (the same patterns the host uses before it calls gh), and it is only ever shown as text.

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** The URL as given (text only: the webview doesn't open links). */
  url: string;
  /** "owner/repo#n" */
  label: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,252})(?::\d{1,5})?$/;

/** Undefined for anything but a plain https pull request URL (no credentials, query, fragment or extra path). */
export function parsePrUrl(url: unknown): PrRef | undefined {
  if (typeof url !== 'string' || url.length > 400) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return undefined;
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})\/?$/.exec(u.pathname);
  if (!m || !OWNER.test(m[1]) || !REPO.test(m[2]) || m[2] === '.' || m[2] === '..') return undefined;
  const host = u.host.toLowerCase();
  if (!HOST.test(host)) return undefined;
  const number = Number(m[3]);
  if (!Number.isInteger(number) || number < 1) return undefined;
  return { host, owner: m[1], repo: m[2], number, url, label: `${m[1]}/${m[2]}#${number}` };
}
