// Mirrors hunter/funnel.py's source_for_url(): each registered source there
// matches on a domain substring; unmatched URLs fall back to the registered
// domain (last two dot-separated labels) so ad-hoc URLs still get a bucket.
const SOURCE_DOMAINS: [domain: string, name: string][] = [
  ['justjoin.it', 'justjoin'],
  ['nofluffjobs.com', 'nofluffjobs'],
  ['linkedin.com', 'linkedin'],
  ['pracuj.pl', 'pracuj'],
  ['theprotocol.it', 'theprotocol'],
  ['bulldogjob.com', 'bulldogjob'],
  ['solid.jobs', 'solidjobs'],
  ['inhire.io', 'inhire'],
  ['jobleads.com', 'jobleads'],
  ['remotive.com', 'remotive'],
  ['workingnomads.com', 'workingnomads'],
  ['weworkremotely.com', 'weworkremotely'],
  ['jobspresso.co', 'jobspresso'],
  ['arbeitnow.com', 'arbeitnow'],
  ['himalayas.app', 'himalayas'],
  ['4dayweek.io', 'fourdayweek'],
  ['remoteok.com', 'remoteok'],
  ['remoteleaf.com', 'remoteleaf'],
  ['justremote.co', 'justremote'],
  ['builtin.com', 'builtin'],
];

export function inferSource(url: string): string {
  if (!url) {
    return '—';
  }
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '?';
  }

  for (const [domain, name] of SOURCE_DOMAINS) {
    if (host.includes(domain)) {
      return name;
    }
  }

  if (
    host.includes('apply.workable.com') ||
    host.includes('greenhouse.io') ||
    host.includes('jobs.lever.co') ||
    host.endsWith('.recruitee.com') ||
    host.includes('jobs.ashbyhq.com')
  ) {
    return 'ats_aggregator';
  }

  return registeredDomain(host);
}

function registeredDomain(host: string): string {
  if (!host) {
    return '?';
  }
  const parts = host.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}
