import { createHash, createHmac, timingSafeEqual } from "node:crypto";

interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface S3Fixture {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly objectCount: () => number;
  readonly setVersioningStatus: (status: "Enabled" | "Suspended" | null) => void;
}

export interface S3FixtureAuthentication {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string;
  readonly now?: () => Date;
}

const defaultAuthentication: S3FixtureAuthentication = {
  accessKeyId: "brief-e2e-access-key",
  secretAccessKey: "brief-e2e-secret-key",
};

const sigV4Algorithm = "AWS4-HMAC-SHA256";
const maxPresignedExpirySeconds = 7 * 24 * 60 * 60;
const headerSignatureClockSkewMs = 15 * 60 * 1_000;
const requiredQueryParameters = [
  "X-Amz-Algorithm",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-Signature",
  "X-Amz-SignedHeaders",
] as const;

const awsUriEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const canonicalUri = (url: URL): string | null => {
  try {
    return url.pathname
      .split("/")
      .map((segment) => awsUriEncode(decodeURIComponent(segment)))
      .join("/");
  } catch {
    return null;
  }
};

const canonicalQuery = (url: URL, excludePresignedSignature: boolean): string =>
  [...url.searchParams.entries()]
    .filter(([name]) => !excludePresignedSignature || name !== "X-Amz-Signature")
    .map(([name, value]) => [awsUriEncode(name), awsUriEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

const normalizedHeaderValue = (value: string): string => value.trim().replace(/\s+/gu, " ");

const canonicalHeaders = (
  request: Request,
  url: URL,
  signedHeadersValue: string,
): { readonly names: string; readonly values: string } | null => {
  const names = signedHeadersValue.split(";");
  if (
    names.length === 0 ||
    names.some((name) => !/^[a-z0-9-]+$/u.test(name)) ||
    names.some((name, index) => index > 0 && names[index - 1]! >= name) ||
    !names.includes("host")
  ) {
    return null;
  }

  const values: string[] = [];
  for (const name of names) {
    const value = name === "host" ? url.host : request.headers.get(name);
    if (value === null) return null;
    values.push(`${name}:${normalizedHeaderValue(value)}\n`);
  }
  return { names: names.join(";"), values: values.join("") };
};

const parseAmzDate = (value: string): number | null => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const canonical = new Date(timestamp).toISOString().replace(/[-:]/gu, "").replace(".000", "");
  return canonical === value ? timestamp : null;
};

const hmac = (key: string | Uint8Array, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

const signingKey = (
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer => {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
};

const signatureMatches = (expectedHex: string, suppliedHex: string): boolean => {
  if (!/^[0-9a-f]{64}$/u.test(suppliedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const supplied = Buffer.from(suppliedHex, "hex");
  return expected.byteLength === supplied.byteLength && timingSafeEqual(expected, supplied);
};

const queryParameterExactlyOnce = (url: URL, name: string): string | null => {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0]! : null;
};

interface CredentialScope {
  readonly credentialDate: string;
  readonly region: string;
}

const parseCredentialScope = (
  credential: string,
  authentication: S3FixtureAuthentication,
): CredentialScope | null => {
  const credentialParts = credential.split("/");
  if (credentialParts.length !== 5) return null;
  const [accessKeyId, credentialDate, region, service, terminal] = credentialParts;
  if (
    accessKeyId !== authentication.accessKeyId ||
    !/^\d{8}$/u.test(credentialDate!) ||
    region !== (authentication.region ?? "auto") ||
    service !== "s3" ||
    terminal !== "aws4_request"
  ) {
    return null;
  }
  return { credentialDate: credentialDate!, region: region! };
};

const verifyPresignedRequest = (
  request: Request,
  url: URL,
  authentication: S3FixtureAuthentication,
): boolean => {
  const parameters = Object.fromEntries(
    requiredQueryParameters.map((name) => [name, queryParameterExactlyOnce(url, name)]),
  ) as Record<(typeof requiredQueryParameters)[number], string | null>;
  if (Object.values(parameters).some((value) => value === null)) return false;
  if (parameters["X-Amz-Algorithm"] !== sigV4Algorithm) return false;

  const credential = parseCredentialScope(parameters["X-Amz-Credential"]!, authentication);
  if (credential === null) return false;
  const { credentialDate, region } = credential;

  const amzDate = parameters["X-Amz-Date"]!;
  const signedAt = parseAmzDate(amzDate);
  if (signedAt === null || amzDate.slice(0, 8) !== credentialDate) return false;
  const expiresValue = parameters["X-Amz-Expires"]!;
  if (!/^[1-9]\d*$/u.test(expiresValue)) return false;
  const expiresSeconds = Number(expiresValue);
  if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds > maxPresignedExpirySeconds) {
    return false;
  }
  const now = (authentication.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(now) || now < signedAt || now >= signedAt + expiresSeconds * 1_000) {
    return false;
  }

  const uri = canonicalUri(url);
  const headers = canonicalHeaders(request, url, parameters["X-Amz-SignedHeaders"]!);
  if (uri === null || headers === null) return false;
  const payloadHash = url.searchParams.get("X-Amz-Content-Sha256") ?? "UNSIGNED-PAYLOAD";
  if (payloadHash !== "UNSIGNED-PAYLOAD") return false;
  const canonicalRequest = [
    request.method,
    uri,
    canonicalQuery(url, true),
    headers.values,
    headers.names,
    payloadHash,
  ].join("\n");
  const scope = `${credentialDate}/${region}/s3/aws4_request`;
  const stringToSign = [
    sigV4Algorithm,
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const expectedSignature = createHmac(
    "sha256",
    signingKey(authentication.secretAccessKey, credentialDate, region, "s3"),
  )
    .update(stringToSign, "utf8")
    .digest("hex");
  return signatureMatches(expectedSignature, parameters["X-Amz-Signature"]!);
};

const verifyHeaderSignedRequest = async (
  request: Request,
  url: URL,
  authentication: S3FixtureAuthentication,
): Promise<boolean> => {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith(`${sigV4Algorithm} `)) return false;
  const attributes = new Map<string, string>();
  for (const attribute of authorization.slice(sigV4Algorithm.length + 1).split(/,\s*/u)) {
    const separator = attribute.indexOf("=");
    if (separator <= 0) return false;
    const name = attribute.slice(0, separator);
    const value = attribute.slice(separator + 1);
    if (value === "" || attributes.has(name)) return false;
    attributes.set(name, value);
  }
  if (
    attributes.size !== 3 ||
    !attributes.has("Credential") ||
    !attributes.has("SignedHeaders") ||
    !attributes.has("Signature")
  ) {
    return false;
  }

  const credential = parseCredentialScope(attributes.get("Credential")!, authentication);
  if (credential === null) return false;
  const amzDate = request.headers.get("x-amz-date");
  const signedAt = amzDate === null ? null : parseAmzDate(amzDate);
  if (signedAt === null || amzDate!.slice(0, 8) !== credential.credentialDate) return false;
  const now = (authentication.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(now) || Math.abs(now - signedAt) > headerSignatureClockSkewMs) return false;

  const uri = canonicalUri(url);
  const headers = canonicalHeaders(request, url, attributes.get("SignedHeaders")!);
  const payloadHash = request.headers.get("x-amz-content-sha256");
  if (uri === null || headers === null || payloadHash === null) {
    return false;
  }
  const canonicalRequest = [
    request.method,
    uri,
    canonicalQuery(url, false),
    headers.values,
    headers.names,
    payloadHash,
  ].join("\n");
  const scope = `${credential.credentialDate}/${credential.region}/s3/aws4_request`;
  const stringToSign = [
    sigV4Algorithm,
    amzDate!,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const expectedSignature = createHmac(
    "sha256",
    signingKey(authentication.secretAccessKey, credential.credentialDate, credential.region, "s3"),
  )
    .update(stringToSign, "utf8")
    .digest("hex");
  if (!signatureMatches(expectedSignature, attributes.get("Signature")!)) return false;

  if (/^[0-9a-f]{64}$/u.test(payloadHash)) {
    try {
      const payload = new Uint8Array(await request.clone().arrayBuffer());
      const actualPayloadHash = createHash("sha256").update(payload).digest("hex");
      return signatureMatches(actualPayloadHash, payloadHash);
    } catch {
      return false;
    }
  }
  if (payloadHash === "UNSIGNED-PAYLOAD") {
    return request.method === "GET" || request.method === "HEAD";
  }
  return false;
};

const accessDenied = (): Response =>
  new Response(null, { status: 403, headers: responseHeaders() });

const responseHeaders = (extra: HeadersInit = {}, origin: string | null = null): Headers => {
  const headers = new Headers(extra);
  headers.set("access-control-allow-origin", origin ?? "*");
  if (origin !== null) headers.set("access-control-allow-credentials", "true");
  headers.set(
    "access-control-expose-headers",
    "content-disposition, content-length, etag, x-brief-e2e-authorization-received",
  );
  return headers;
};

const objectKeyFrom = (url: URL, buckets: readonly string[]): string | null => {
  for (const bucket of buckets) {
    const prefix = `/${bucket}/`;
    if (!url.pathname.startsWith(prefix)) continue;
    const encoded = url.pathname.slice(prefix.length);
    if (encoded === "") return null;
    const objectKey = encoded
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    return `${bucket}/${objectKey}`;
  }
  return null;
};

const indexOfCrlf = (bytes: Uint8Array, from: number): number => {
  for (let index = from; index + 1 < bytes.byteLength; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) return index;
  }
  return -1;
};

export const decodeAwsChunked = (encoded: Uint8Array): Uint8Array => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let offset = 0;
  const decoder = new TextDecoder();

  while (offset < encoded.byteLength) {
    const lineEnd = indexOfCrlf(encoded, offset);
    if (lineEnd < 0) throw new Error("invalid aws-chunked size line");
    const sizeToken = decoder.decode(encoded.subarray(offset, lineEnd)).split(";", 1)[0]?.trim();
    if (sizeToken === undefined || !/^[0-9a-f]+$/iu.test(sizeToken)) {
      throw new Error("invalid aws-chunked size");
    }
    const size = Number.parseInt(sizeToken, 16);
    offset = lineEnd + 2;
    if (size === 0) break;
    if (offset + size + 2 > encoded.byteLength) throw new Error("truncated aws-chunked body");
    const chunk = encoded.slice(offset, offset + size);
    chunks.push(chunk);
    total += chunk.byteLength;
    offset += size;
    if (encoded[offset] !== 13 || encoded[offset + 1] !== 10) {
      throw new Error("invalid aws-chunked delimiter");
    }
    offset += 2;
  }

  const body = new Uint8Array(total);
  let writeOffset = 0;
  for (const chunk of chunks) {
    body.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return body;
};

const bodyBytes = async (request: Request): Promise<Uint8Array> => {
  const encoded = new Uint8Array(await request.arrayBuffer());
  const contentEncoding = request.headers.get("content-encoding") ?? "";
  const body = contentEncoding
    .split(",")
    .some((value) => value.trim().toLowerCase() === "aws-chunked")
    ? decodeAwsChunked(encoded)
    : encoded;
  const expectedLength = request.headers.get("x-amz-decoded-content-length");
  if (expectedLength !== null && Number(expectedLength) !== body.byteLength) {
    throw new Error("aws-chunked decoded length mismatch");
  }
  return body;
};

const quotedEtag = async (body: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(body).buffer),
  );
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
};

export const makeS3Fixture = (
  bucket: string | readonly string[],
  authentication: S3FixtureAuthentication = defaultAuthentication,
): S3Fixture => {
  const buckets = typeof bucket === "string" ? [bucket] : [...bucket];
  const objects = new Map<string, StoredObject>();
  let versioningStatus: "Enabled" | "Suspended" | null = null;

  return {
    objectCount: () => objects.size,
    setVersioningStatus: (status) => {
      versioningStatus = status;
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", objects: objects.size });
      }
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: responseHeaders({
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "GET, HEAD, PUT, DELETE, OPTIONS",
          }),
        });
      }

      const isVersioningRequest =
        request.method === "GET" &&
        buckets.some(
          (candidate) => url.pathname === `/${candidate}` || url.pathname === `/${candidate}/`,
        ) &&
        url.searchParams.has("versioning");
      const queryAuthorized =
        !isVersioningRequest &&
        (request.method === "GET" || request.method === "HEAD") &&
        verifyPresignedRequest(request, url, authentication);
      const headerAuthorized = await verifyHeaderSignedRequest(request, url, authentication);
      if (!queryAuthorized && !headerAuthorized) return accessDenied();

      if (isVersioningRequest) {
        const status = versioningStatus === null ? "" : `<Status>${versioningStatus}</Status>`;
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${status}</VersioningConfiguration>`,
          {
            status: 200,
            headers: responseHeaders({ "content-type": "application/xml" }),
          },
        );
      }

      const objectKey = objectKeyFrom(url, buckets);
      if (objectKey === null) {
        return new Response("NoSuchBucket", { status: 404, headers: responseHeaders() });
      }

      if (request.method === "PUT") {
        if (request.headers.get("if-none-match") === "*" && objects.has(objectKey)) {
          return new Response(
            "<Error><Code>PreconditionFailed</Code><Message>Object exists</Message></Error>",
            {
              status: 412,
              headers: responseHeaders({ "content-type": "application/xml" }),
            },
          );
        }
        const body = await bodyBytes(request);
        const etag = await quotedEtag(body);
        const metadata = Object.fromEntries(
          [...request.headers.entries()]
            .filter(([name]) => name.startsWith("x-amz-meta-"))
            .map(([name, value]) => [name.slice("x-amz-meta-".length), value]),
        );
        objects.set(objectKey, {
          body,
          contentType: request.headers.get("content-type") ?? "application/octet-stream",
          etag,
          metadata,
        });
        return new Response(null, { status: 200, headers: responseHeaders({ etag }) });
      }

      if (request.method === "DELETE") {
        objects.delete(objectKey);
        return new Response(null, { status: 204, headers: responseHeaders() });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const object = objects.get(objectKey);
        if (object === undefined) {
          return new Response("NoSuchKey", { status: 404, headers: responseHeaders() });
        }
        const contentType = url.searchParams.get("response-content-type") ?? object.contentType;
        const contentDisposition = url.searchParams.get("response-content-disposition");
        const headers = responseHeaders(
          {
            "accept-ranges": "bytes",
            "cache-control": "private, no-store",
            "content-length": String(object.body.byteLength),
            "content-type": contentType,
            etag: object.etag,
            "x-brief-e2e-authorization-received": request.headers.has("authorization")
              ? "present"
              : "absent",
          },
          request.headers.get("origin"),
        );
        for (const [name, value] of Object.entries(object.metadata)) {
          headers.set(`x-amz-meta-${name}`, value);
        }
        if (contentDisposition !== null) headers.set("content-disposition", contentDisposition);
        return new Response(request.method === "HEAD" ? null : object.body.slice(), {
          status: 200,
          headers,
        });
      }

      return new Response("MethodNotAllowed", {
        status: 405,
        headers: responseHeaders({ allow: "GET, HEAD, PUT, DELETE, OPTIONS" }),
      });
    },
  };
};
