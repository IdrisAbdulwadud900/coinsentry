import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(20),
  DB_PATH: z.string().min(1).default("./data/coinsentry.db"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
