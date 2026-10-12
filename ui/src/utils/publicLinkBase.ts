export interface PublicLinkConfig {
  domain?: string | null;
  webUrl?: string | null;
}

// Match the backend PrimaryDomain: the first non-empty, trimmed entry.
export const primaryDomain = (domain?: string | null): string | undefined => (
  domain?.split(';').map(value => value.trim()).find(Boolean)
);

export const resolvePublicLinkBase = (
  config?: PublicLinkConfig | null,
): string | undefined => {
  const domain = primaryDomain(config?.domain);
  if (!domain) return undefined;
  let base = domain;
  if (!/^(https?:)?\/\//i.test(base)) {
    const protocol = typeof window === 'undefined' ? 'https:' : window.location.protocol;
    base = `${protocol}//${base}`;
  }
  base = base.replace(/\/+$/, '');
  const webUrl = (config?.webUrl?.trim() || '').replace(/^\/+|\/+$/g, '');
  return webUrl ? `${base}/${webUrl}` : base;
};
