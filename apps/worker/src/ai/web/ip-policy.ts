import { isIP } from "node:net";

const parseIpv4 = (address: string): number | undefined => {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return octets.reduce((result, octet) => (result << 8) + octet, 0) >>> 0;
};

const ipv4InCidr = (address: number, base: string, prefix: number): boolean => {
  const baseNumber = parseIpv4(base);
  if (baseNumber === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (baseNumber & mask) >>> 0;
};

const blockedIpv4Cidrs = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const expandIpv6 = (address: string): readonly number[] | undefined => {
  if (isIP(address) !== 6) return undefined;
  const withoutZone = address.split("%", 1)[0] ?? address;
  const [head = "", tail = "", ...extra] = withoutZone.split("::");
  if (extra.length > 0) return undefined;

  const parseSide = (side: string): number[] => {
    if (side === "") return [];
    const groups: number[] = [];
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const ipv4 = parseIpv4(part);
        if (ipv4 === undefined) return [];
        groups.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      } else {
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };

  const left = parseSide(head);
  const right = parseSide(tail);
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (!withoutZone.includes("::") && omitted !== 0)) return undefined;
  return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
};

const ipv6ToBigInt = (address: string): bigint | undefined => {
  const groups = expandIpv6(address);
  if (groups === undefined || groups.length !== 8) return undefined;
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
};

const ipv6InCidr = (address: bigint, base: string, prefix: number): boolean => {
  const baseNumber = ipv6ToBigInt(base);
  if (baseNumber === undefined) return false;
  const shift = BigInt(128 - prefix);
  return address >> shift === baseNumber >> shift;
};

const normalizedAddressValue = (
  address: string,
): { readonly family: 4 | 6; readonly value: bigint } | undefined => {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) return { family: 4, value: BigInt(ipv4) };
  const ipv6 = ipv6ToBigInt(address);
  if (ipv6 === undefined) return undefined;
  if (ipv6InCidr(ipv6, "::ffff:0:0", 96)) {
    return { family: 4, value: ipv6 & 0xffff_ffffn };
  }
  return { family: 6, value: ipv6 };
};

/** Compares textual IP forms, including IPv4-mapped IPv6 socket addresses. */
export const areEquivalentIpAddresses = (left: string, right: string): boolean => {
  const normalizedLeft = normalizedAddressValue(left);
  const normalizedRight = normalizedAddressValue(right);
  return (
    normalizedLeft !== undefined &&
    normalizedRight !== undefined &&
    normalizedLeft.family === normalizedRight.family &&
    normalizedLeft.value === normalizedRight.value
  );
};

const blockedIpv6Cidrs = [
  // IANA IETF protocol assignments include tunnelling, benchmarking,
  // non-locator identifiers, and anycast services rather than ordinary web
  // destinations. Blocking the parent /23 also covers future special entries.
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const;

export const isPrivateOrReservedAddress = (address: string): boolean => {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) {
    return blockedIpv4Cidrs.some(([base, prefix]) => ipv4InCidr(ipv4, base, prefix));
  }

  const ipv6 = ipv6ToBigInt(address);
  if (ipv6 === undefined) return true;

  // IPv4-mapped IPv6 retains the IPv4 policy rather than being treated as a
  // separate globally routable address.
  if (ipv6InCidr(ipv6, "::ffff:0:0", 96)) {
    const mapped = Number(ipv6 & 0xffff_ffffn) >>> 0;
    return blockedIpv4Cidrs.some(([base, prefix]) => ipv4InCidr(mapped, base, prefix));
  }
  // IANA currently assigns ordinary global unicast IPv6 only from 2000::/3.
  // Translation, local, link-local, multicast, discard, and unallocated
  // prefixes outside it are therefore never eligible for direct web fetches.
  if (!ipv6InCidr(ipv6, "2000::", 3)) return true;
  return blockedIpv6Cidrs.some(([base, prefix]) => ipv6InCidr(ipv6, base, prefix));
};
