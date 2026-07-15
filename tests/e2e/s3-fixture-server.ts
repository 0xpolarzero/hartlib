import { makeS3Fixture } from "../../apps/worker/src/e2e/s3-fixture";

const host = "127.0.0.1";
const port = Number(process.env.BRIEF_E2E_OBJECT_STORE_PORT ?? "43113");
const bucket = process.env.BRIEF_E2E_OBJECT_STORE_BUCKET ?? "brief-e2e";
const fixture = makeS3Fixture([bucket, `${bucket}-exports`], {
  accessKeyId: process.env.BRIEF_E2E_OBJECT_STORE_ACCESS_KEY_ID ?? "brief-e2e-access-key",
  secretAccessKey: process.env.BRIEF_E2E_OBJECT_STORE_SECRET_ACCESS_KEY ?? "brief-e2e-secret-key",
  region: process.env.BRIEF_E2E_OBJECT_STORE_REGION ?? "auto",
});

const server = Bun.serve({
  hostname: host,
  port,
  fetch: fixture.fetch,
});

const stop = (): void => {
  void server.stop(true);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

console.log(`E2E S3 fixture listening on http://${host}:${port}`);
