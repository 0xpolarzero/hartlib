export const shouldDisableRequestIdleTimeout = (request: Request): boolean => {
  if (request.method !== "GET") return false;

  const pathname = new URL(request.url).pathname;
  const segments = pathname.split("/");
  return (
    segments.length === 5 &&
    segments[1] === "v1" &&
    segments[2] === "ai-runs" &&
    segments[3] !== "" &&
    segments[4] === "stream"
  );
};
