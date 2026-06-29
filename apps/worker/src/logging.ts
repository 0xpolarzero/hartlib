import { Logger } from "effect";

export const JsonLoggerLayer = Logger.layer([Logger.consoleJson]);

export const serviceLogFields = {
  service: "worker",
} as const;
