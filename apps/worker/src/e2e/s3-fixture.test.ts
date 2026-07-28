import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeS3ExportObjectStore } from "../platform/adapters";
import { decodeAwsChunked, makeS3Fixture } from "./s3-fixture";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);
const requestBody = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
const fixtureAccessKeyId = "brief-e2e-access-key";
const fixtureSecretAccessKey = "brief-e2e-secret-key";
const signedAt = new Date("2026-07-11T12:34:56.000Z");
const fixtureNow = new Date("2026-07-11T12:35:00.000Z");

const awsUriEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

const presign = (input: {
  readonly url: string;
  readonly method?: "GET" | "HEAD";
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly date?: Date;
  readonly expires?: string;
  readonly region?: string;
}): URL => {
  const url = new URL(input.url);
  const method = input.method ?? "GET";
  const accessKeyId = input.accessKeyId ?? fixtureAccessKeyId;
  const secretAccessKey = input.secretAccessKey ?? fixtureSecretAccessKey;
  const date = input.date ?? signedAt;
  const expires = input.expires ?? "300";
  const region = input.region ?? "auto";
  const amzDate = date.toISOString().replace(/[-:]/gu, "").replace(".000", "");
  const credentialDate = amzDate.slice(0, 8);
  const scope = `${credentialDate}/${region}/s3/aws4_request`;
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD");
  url.searchParams.set("X-Amz-Credential", `${accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", expires);
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonicalUri = url.pathname
    .split("/")
    .map((segment) => awsUriEncode(decodeURIComponent(segment)))
    .join("/");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([name, value]) => [awsUriEncode(name), awsUriEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const dateKey = hmac(`AWS4${secretAccessKey}`, credentialDate);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  url.searchParams.set(
    "X-Amz-Signature",
    createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex"),
  );
  return url;
};

const headerSignedRequest = (input: {
  readonly url: string | URL;
  readonly method: "GET" | "HEAD" | "PUT" | "DELETE";
  readonly body?: Uint8Array;
  readonly headers?: HeadersInit;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly date?: Date;
  readonly region?: string;
  readonly payloadHash?: string;
}): Request => {
  const url = new URL(input.url);
  const headers = new Headers(input.headers);
  const accessKeyId = input.accessKeyId ?? fixtureAccessKeyId;
  const secretAccessKey = input.secretAccessKey ?? fixtureSecretAccessKey;
  const date = input.date ?? signedAt;
  const region = input.region ?? "auto";
  const amzDate = date.toISOString().replace(/[-:]/gu, "").replace(".000", "");
  const credentialDate = amzDate.slice(0, 8);
  const scope = `${credentialDate}/${region}/s3/aws4_request`;
  const payloadHash =
    input.payloadHash ??
    createHash("sha256")
      .update(input.body ?? new Uint8Array())
      .digest("hex");
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);
  const signedHeaderNames = ["host", ...headers.keys()]
    .filter((name) => name !== "authorization" && name !== "host")
    .concat("host")
    .sort();
  const canonicalHeaderValues = signedHeaderNames
    .map((name) => {
      const value = name === "host" ? url.host : headers.get(name)!;
      return `${name}:${value.trim().replace(/\s+/gu, " ")}\n`;
    })
    .join("");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([name, value]) => [awsUriEncode(name), awsUriEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalUri = url.pathname
    .split("/")
    .map((segment) => awsUriEncode(decodeURIComponent(segment)))
    .join("/");
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaderValues,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const dateKey = hmac(`AWS4${secretAccessKey}`, credentialDate);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const key = hmac(serviceKey, "aws4_request");
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${createHmac("sha256", key).update(stringToSign, "utf8").digest("hex")}`,
  );
  return new Request(
    url,
    input.method === "PUT"
      ? {
          method: input.method,
          headers,
          body: requestBody(input.body ?? new Uint8Array()),
        }
      : { method: input.method, headers },
  );
};

const makeAuthenticatedFixture = () =>
  makeS3Fixture("brief-e2e", {
    accessKeyId: fixtureAccessKeyId,
    secretAccessKey: fixtureSecretAccessKey,
    now: () => fixtureNow,
  });

describe("deterministic S3-compatible E2E fixture", () => {
  it("matches the AWS SDK SigV4 GET vector including response overrides and reserved paths", () => {
    const url = presign({
      url:
        "http://storage.test/brief-e2e/publisher-issues/i/a%20b.pdf" +
        "?response-content-disposition=inline%3B%20filename%3D%22a%20b.pdf%22" +
        "&response-content-type=application%2Fpdf" +
        "&x-amz-checksum-mode=ENABLED&x-id=GetObject",
    });
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "80942b409ec657dde35bdf9b0f6e5cfb109ae6c5ab4529f97c2413a88f1ea642",
    );
  });

  it("stores exact bytes and serves independent private signed-response copies", async () => {
    const fixture = makeAuthenticatedFixture();
    const body = bytes("%PDF-1.4\nexact fixture bytes");
    const objectUrl = "http://storage.test/brief-e2e/publisher-issues/i/documents/d.pdf";

    const put = await fixture.fetch(
      headerSignedRequest({
        url: objectUrl,
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body,
      }),
    );
    expect(put.status).toBe(200);
    expect(put.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/u);
    expect(fixture.objectCount()).toBe(1);

    const signedUrl = new URL(objectUrl);
    signedUrl.searchParams.set("response-content-type", "application/pdf");
    signedUrl.searchParams.set("response-content-disposition", 'inline; filename="fixture.pdf"');
    const authorizedUrl = presign({ url: signedUrl.href });
    const first = await fixture.fetch(new Request(authorizedUrl));
    const browser = await fixture.fetch(
      new Request(authorizedUrl, { headers: { origin: "http://127.0.0.1:46112" } }),
    );
    const second = await fixture.fetch(
      new Request(authorizedUrl, { headers: { authorization: "Bearer must-not-leak" } }),
    );

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("content-type")).toBe("application/pdf");
    expect(first.headers.get("content-disposition")).toBe('inline; filename="fixture.pdf"');
    expect(first.headers.get("x-brief-e2e-authorization-received")).toBe("absent");
    expect(browser.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:46112");
    expect(browser.headers.get("access-control-allow-credentials")).toBe("true");
    expect(second.headers.get("x-brief-e2e-authorization-received")).toBe("present");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(body);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(body);

    const deleted = await fixture.fetch(headerSignedRequest({ url: objectUrl, method: "DELETE" }));
    expect(deleted.status).toBe(204);
    expect(fixture.objectCount()).toBe(0);
    expect((await fixture.fetch(new Request(authorizedUrl))).status).toBe(404);
  });

  it("requires valid method-bound SigV4 query authentication for GET and HEAD", async () => {
    const fixture = makeAuthenticatedFixture();
    const objectUrl = "http://storage.test/brief-e2e/publisher-issues/i/a%20b.pdf";
    const body = bytes("signed object");
    expect(
      (await fixture.fetch(headerSignedRequest({ url: objectUrl, method: "PUT", body }))).status,
    ).toBe(200);

    expect((await fixture.fetch(new Request(objectUrl))).status).toBe(403);
    expect(
      (
        await fixture.fetch(
          new Request(objectUrl, {
            headers: {
              authorization:
                "AWS4-HMAC-SHA256 Credential=brief-e2e-access-key/20260711/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=" +
                "0".repeat(64),
              "x-amz-content-sha256": createHash("sha256").update("").digest("hex"),
              "x-amz-date": "20260711T123456Z",
            },
          }),
        )
      ).status,
    ).toBe(403);

    const getUrl = presign({ url: objectUrl });
    const get = await fixture.fetch(new Request(getUrl));
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(body);
    expect((await fixture.fetch(new Request(getUrl, { method: "HEAD" }))).status).toBe(403);

    const headUrl = presign({ url: objectUrl, method: "HEAD" });
    const head = await fixture.fetch(new Request(headUrl, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(body.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await fixture.fetch(new Request(headUrl))).status).toBe(403);
  });

  it("authenticates PUT, DELETE, and versioning before reading or mutating state", async () => {
    const fixture = makeAuthenticatedFixture();
    const objectUrl = "http://storage.test/brief-e2e/security/mutation.pdf";
    const body = bytes("authorized mutation");
    const expectDenied = async (request: Request): Promise<void> => {
      const response = await fixture.fetch(request);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("");
    };

    await expectDenied(new Request(objectUrl, { method: "PUT", body: requestBody(body) }));
    await expectDenied(
      headerSignedRequest({
        url: objectUrl,
        method: "PUT",
        body,
        secretAccessKey: "forged-secret",
      }),
    );
    await expectDenied(
      headerSignedRequest({
        url: objectUrl,
        method: "PUT",
        body,
        accessKeyId: "wrong-access-key",
      }),
    );
    await expectDenied(
      headerSignedRequest({
        url: objectUrl,
        method: "PUT",
        body,
        date: new Date(fixtureNow.getTime() + 16 * 60 * 1_000),
      }),
    );
    await expectDenied(
      headerSignedRequest({
        url: objectUrl,
        method: "PUT",
        body,
        payloadHash: "UNSIGNED-PAYLOAD",
      }),
    );
    await expectDenied(
      headerSignedRequest({
        url: objectUrl,
        method: "PUT",
        body,
        payloadHash: "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
      }),
    );
    const signedOriginalBody = headerSignedRequest({ url: objectUrl, method: "PUT", body });
    await expectDenied(
      new Request(objectUrl, {
        method: "PUT",
        headers: signedOriginalBody.headers,
        body: requestBody(bytes("tampered mutation")),
      }),
    );
    const signedAsDelete = headerSignedRequest({ url: objectUrl, method: "DELETE" });
    await expectDenied(
      new Request(objectUrl, {
        method: "PUT",
        headers: signedAsDelete.headers,
        body: requestBody(body),
      }),
    );
    expect(fixture.objectCount()).toBe(0);

    expect(
      (await fixture.fetch(headerSignedRequest({ url: objectUrl, method: "PUT", body }))).status,
    ).toBe(200);
    expect(fixture.objectCount()).toBe(1);

    await expectDenied(new Request(objectUrl, { method: "DELETE" }));
    await expectDenied(
      headerSignedRequest({
        url: objectUrl,
        method: "DELETE",
        secretAccessKey: "forged-secret",
      }),
    );
    await expectDenied(
      headerSignedRequest({
        url: objectUrl,
        method: "DELETE",
        accessKeyId: "wrong-access-key",
      }),
    );
    const signedAsPut = headerSignedRequest({ url: objectUrl, method: "PUT", body });
    await expectDenied(new Request(objectUrl, { method: "DELETE", headers: signedAsPut.headers }));
    expect(fixture.objectCount()).toBe(1);

    const versioningUrl = "http://storage.test/brief-e2e?versioning=";
    fixture.setVersioningStatus("Enabled");
    await expectDenied(new Request(versioningUrl));
    await expectDenied(new Request(presign({ url: versioningUrl })));
    await expectDenied(
      headerSignedRequest({
        url: versioningUrl,
        method: "GET",
        secretAccessKey: "forged-secret",
      }),
    );
    await expectDenied(
      headerSignedRequest({
        url: versioningUrl,
        method: "GET",
        accessKeyId: "wrong-access-key",
      }),
    );
    await expectDenied(
      headerSignedRequest({
        url: versioningUrl,
        method: "GET",
        date: new Date(fixtureNow.getTime() - 16 * 60 * 1_000),
      }),
    );
    const signedVersioningGet = headerSignedRequest({ url: versioningUrl, method: "GET" });
    await expectDenied(
      new Request(versioningUrl, { method: "HEAD", headers: signedVersioningGet.headers }),
    );
    const versioning = await fixture.fetch(signedVersioningGet);
    expect(versioning.status).toBe(200);
    expect(await versioning.text()).toContain("<Status>Enabled</Status>");

    expect(
      (await fixture.fetch(headerSignedRequest({ url: objectUrl, method: "DELETE" }))).status,
    ).toBe(204);
    expect(fixture.objectCount()).toBe(0);
  });

  it("rejects missing, duplicate, tampered, wrong-scope, wrong-secret, and expired signatures generically", async () => {
    const objectUrl = "http://storage.test/brief-e2e/publisher-issues/i/security.pdf";
    const fixture = makeAuthenticatedFixture();
    await fixture.fetch(
      headerSignedRequest({ url: objectUrl, method: "PUT", body: bytes("private") }),
    );
    const valid = presign({
      url:
        `${objectUrl}?response-content-type=application%2Fpdf` +
        "&response-content-disposition=inline%3B%20filename%3D%22security.pdf%22",
    });

    const requests: Request[] = [];
    for (const name of [
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
    ]) {
      const missing = new URL(valid);
      missing.searchParams.delete(name);
      requests.push(new Request(missing));
    }
    const duplicate = new URL(valid);
    duplicate.searchParams.append("X-Amz-Date", duplicate.searchParams.get("X-Amz-Date")!);
    requests.push(new Request(duplicate));
    for (const [name, value] of [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA1"],
      ["X-Amz-Date", "20260711T123456+0000"],
      ["X-Amz-Expires", "0300"],
      ["X-Amz-SignedHeaders", "host;host"],
    ] as const) {
      const malformed = new URL(valid);
      malformed.searchParams.set(name, value);
      requests.push(new Request(malformed));
    }
    const wrongService = new URL(valid);
    wrongService.searchParams.set(
      "X-Amz-Credential",
      wrongService.searchParams.get("X-Amz-Credential")!.replace("/s3/", "/sts/"),
    );
    requests.push(new Request(wrongService));
    const wrongCredentialDate = new URL(valid);
    wrongCredentialDate.searchParams.set(
      "X-Amz-Credential",
      wrongCredentialDate.searchParams.get("X-Amz-Credential")!.replace("/20260711/", "/20260710/"),
    );
    requests.push(new Request(wrongCredentialDate));
    const tamperedPath = new URL(valid);
    tamperedPath.pathname = `${tamperedPath.pathname}.tampered`;
    requests.push(new Request(tamperedPath));
    const tamperedResponse = new URL(valid);
    tamperedResponse.searchParams.set("response-content-type", "text/html");
    requests.push(new Request(tamperedResponse));
    const tamperedSignature = new URL(valid);
    const signature = tamperedSignature.searchParams.get("X-Amz-Signature")!;
    tamperedSignature.searchParams.set(
      "X-Amz-Signature",
      `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`,
    );
    requests.push(new Request(tamperedSignature));
    requests.push(new Request(presign({ url: objectUrl, accessKeyId: "wrong-access-key" })));
    requests.push(new Request(presign({ url: objectUrl, secretAccessKey: "wrong-secret" })));
    requests.push(new Request(presign({ url: objectUrl, region: "eu-west-1" })));
    requests.push(new Request(presign({ url: objectUrl, expires: "0" })));
    requests.push(new Request(presign({ url: objectUrl, expires: "604801" })));

    for (const request of requests) {
      const response = await fixture.fetch(request);
      expect(response.status).toBe(403);
      const deniedBody = await response.text();
      expect(deniedBody).toBe("");
      expect(deniedBody).not.toContain(fixtureAccessKeyId);
      expect(deniedBody).not.toContain(fixtureSecretAccessKey);
      const deniedHeaders = JSON.stringify([...response.headers.entries()]);
      expect(deniedHeaders).not.toContain(fixtureAccessKeyId);
      expect(deniedHeaders).not.toContain(fixtureSecretAccessKey);
    }

    const expiredFixture = makeS3Fixture("brief-e2e", {
      accessKeyId: fixtureAccessKeyId,
      secretAccessKey: fixtureSecretAccessKey,
      now: () => new Date(signedAt.getTime() + 300_000),
    });
    await expiredFixture.fetch(
      headerSignedRequest({ url: objectUrl, method: "PUT", body: bytes("private") }),
    );
    expect((await expiredFixture.fetch(new Request(presign({ url: objectUrl })))).status).toBe(403);

    const future = presign({
      url: objectUrl,
      date: new Date(fixtureNow.getTime() + 1_000),
    });
    expect((await fixture.fetch(new Request(future))).status).toBe(403);
  });

  it("preserves the signature invariant across reserved and unicode object/query values", async () => {
    const fixture = makeAuthenticatedFixture();
    const values = [
      "space value",
      "plus+value",
      "percent%value",
      "quote'value",
      "paren(value)",
      "énergie-東京",
      "semi;colon",
      "equals=value",
    ];

    for (let index = 0; index < 32; index += 1) {
      const value = `${values[index % values.length]}-${index}`;
      const objectUrl = new URL(
        `http://storage.test/brief-e2e/property/${awsUriEncode(value)}.pdf`,
      );
      const body = bytes(`object-${index}`);
      await fixture.fetch(headerSignedRequest({ url: objectUrl, method: "PUT", body }));
      objectUrl.searchParams.set(
        "response-content-disposition",
        `inline; filename="property-${index}.pdf"`,
      );
      objectUrl.searchParams.set("fixture-property", value);
      const signed = presign({ url: objectUrl.href });
      const accepted = await fixture.fetch(new Request(signed));
      expect(accepted.status).toBe(200);
      expect(new Uint8Array(await accepted.arrayBuffer())).toEqual(body);

      const tampered = new URL(signed);
      tampered.searchParams.set(
        "fixture-property",
        `${tampered.searchParams.get("fixture-property")}!`,
      );
      expect((await fixture.fetch(new Request(tampered))).status).toBe(403);
    }
  });

  it("decodes the AWS streaming body framing used by checksum-enabled SDK uploads", async () => {
    const encoded = bytes(
      "4;chunk-signature=a\r\n%PDF\r\n" +
        "8;chunk-signature=b\r\n-1.4data\r\n" +
        "0;chunk-signature=c\r\nx-amz-checksum-crc32:AAAA\r\n\r\n",
    );
    expect(text(decodeAwsChunked(encoded))).toBe("%PDF-1.4data");

    const fixture = makeAuthenticatedFixture();
    const objectUrl = "http://storage.test/brief-e2e/publisher-issues/i/documents/chunked.pdf";
    const put = await fixture.fetch(
      headerSignedRequest({
        url: objectUrl,
        method: "PUT",
        headers: {
          "content-encoding": "aws-chunked",
          "content-type": "application/pdf",
          "x-amz-decoded-content-length": "12",
        },
        body: encoded,
      }),
    );
    expect(put.status).toBe(200);
    expect(
      text(
        new Uint8Array(
          await (await fixture.fetch(new Request(presign({ url: objectUrl })))).arrayBuffer(),
        ),
      ),
    ).toBe("%PDF-1.4data");
  });

  it("rejects truncated framing and a false decoded-length claim", async () => {
    expect(() => decodeAwsChunked(bytes("4\r\nabc"))).toThrow("truncated aws-chunked body");

    const fixture = makeAuthenticatedFixture();
    await expect(
      fixture.fetch(
        headerSignedRequest({
          url: "http://storage.test/brief-e2e/document.pdf",
          method: "PUT",
          headers: { "x-amz-decoded-content-length": "99" },
          body: bytes("short"),
        }),
      ),
    ).rejects.toThrow("aws-chunked decoded length mismatch");
  });
});

describe.skipIf(typeof process.versions.bun !== "string")(
  "production export-object S3 adapter contract",
  () => {
    const bucket = "brief-export-adapter";
    const fixture = makeS3Fixture(bucket, {
      accessKeyId: "fixture-access-key",
      secretAccessKey: "fixture-secret-key",
      region: "eu-west-1",
    });
    let server: ReturnType<typeof Bun.serve>;

    beforeAll(() => {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixture.fetch });
    });

    afterAll(() => {
      server?.stop(true);
    });

    const store = () =>
      makeS3ExportObjectStore({
        endpoint: server.url.origin,
        bucket,
        accessKeyId: "fixture-access-key",
        secretAccessKey: "fixture-secret-key",
        region: "eu-west-1",
      });

    it("verifies versioning, creates conditionally with metadata, propagates abort, and confirms deletion", async () => {
      const adapter = store();
      await expect(
        adapter.verifyPhysicalDeletionSafety({ signal: new AbortController().signal }),
      ).resolves.toBeUndefined();

      fixture.setVersioningStatus("Enabled");
      await expect(
        adapter.verifyPhysicalDeletionSafety({ signal: new AbortController().signal }),
      ).rejects.toThrow("export_object_bucket_versioning_must_be_disabled");
      fixture.setVersioningStatus("Suspended");
      await expect(
        adapter.verifyPhysicalDeletionSafety({ signal: new AbortController().signal }),
      ).rejects.toThrow("export_object_bucket_versioning_must_be_disabled");
      fixture.setVersioningStatus(null);

      const objectKey = "exports/00000000-0000-4000-8000-000000000001/attempt-7.tar";
      const firstBody = bytes("first immutable export archive");
      const metadataHash = "a".repeat(64);
      await adapter.put(
        {
          objectKey,
          body: firstBody,
          contentType: "application/x-tar",
          sha256Hex: metadataHash,
          generation: 7,
        },
        { signal: new AbortController().signal },
      );
      await expect(
        adapter.head(objectKey, { signal: new AbortController().signal }),
      ).resolves.toEqual({
        byteSize: firstBody.byteLength,
        sha256Hex: metadataHash,
        generation: "7",
      });
      await expect(
        adapter.get(objectKey, { signal: new AbortController().signal }),
      ).resolves.toEqual(firstBody);

      await expect(
        adapter.put(
          {
            objectKey,
            body: bytes("forbidden overwrite"),
            contentType: "application/x-tar",
            sha256Hex: "b".repeat(64),
            generation: 7,
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toBeDefined();
      await expect(
        adapter.get(objectKey, { signal: new AbortController().signal }),
      ).resolves.toEqual(firstBody);

      const aborted = new AbortController();
      aborted.abort();
      await expect(
        adapter.verifyPhysicalDeletionSafety({ signal: aborted.signal }),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
      await expect(adapter.get(objectKey, { signal: aborted.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      await expect(adapter.head(objectKey, { signal: aborted.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      await expect(adapter.delete(objectKey, { signal: aborted.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      await expect(
        adapter.put(
          {
            objectKey: `${objectKey}-aborted`,
            body: bytes("must not be written"),
            contentType: "application/x-tar",
            sha256Hex: "c".repeat(64),
            generation: 8,
          },
          { signal: aborted.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });

      await adapter.delete(objectKey, { signal: new AbortController().signal });
      await expect(
        adapter.head(objectKey, { signal: new AbortController().signal }),
      ).resolves.toBeNull();
      expect(fixture.objectCount()).toBe(0);
    });
  },
);
