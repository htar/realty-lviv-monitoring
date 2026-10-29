import pino from "pino";

// Readable colored logs in a terminal, plain JSON otherwise (Docker, files).
export function createLogger(level: string) {
  const pretty = process.stdout.isTTY && process.env.LOG_FORMAT !== "json";
  return pino({
    level,
    transport: pretty
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } }
      : undefined
  });
}
