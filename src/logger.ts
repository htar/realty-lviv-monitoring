import pino from "pino";
import pretty from "pino-pretty";

// Readable colored logs in a terminal, plain JSON otherwise (Docker, files).
// Pretty output goes through process.stdout so Windows consoles decode Cyrillic correctly.
export function createLogger(level: string) {
  if (!process.stdout.isTTY || process.env.LOG_FORMAT === "json") return pino({ level });
  return pino({ level }, pretty({
    colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname", sync: true,
    destination: process.stdout as unknown as number
  }));
}
