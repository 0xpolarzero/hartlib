const ipv4LikeHostname = /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/iu;
const dnsHostname =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
const privateHostnameSuffixes = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".corp",
  ".lan",
  ".home",
  ".home.arpa",
] as const;

/**
 * Canonical public-source links are browser-visible provenance. Keep them on an
 * ordinary credential-free HTTPS origin even when a corrupted database row is
 * projected through an API response.
 */
export const canonicalPublicSourceHttpsUrl = (value: string): string | null => {
  if (
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      hostname === "localhost" ||
      privateHostnameSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
      hostname.startsWith("[") ||
      hostname.length > 253 ||
      !dnsHostname.test(hostname) ||
      ipv4LikeHostname.test(hostname)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
};

export const isCanonicalPublicSourceHttpsUrl = (value: string): boolean =>
  canonicalPublicSourceHttpsUrl(value) !== null;
