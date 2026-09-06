import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import type { Logger } from "pino";
import type { TokenRepo } from "../data/tokenRepo.js";
import type { SnapshotRepo } from "../data/snapshotRepo.js";
import type { AlertRepo } from "../data/alertRepo.js";
import type { Poller } from "../engine/poller.js";
import type { ClassifierConfig } from "../engine/classifier.js";
import type { TokenStatus } from "../types/domain.js";
import { requireTelegramAuth } from "./auth.js";

export interface BuildServerDeps {
  tokenRepo: TokenRepo;
  snapshotRepo: SnapshotRepo;
  alertRepo: AlertRepo;
  poller: Poller;
  logger: Logger;
  botToken: string;
  allowedUserId: string;
  classifierConfig: ClassifierConfig;
}

const VALID_STATUSES: TokenStatus[] = ["active", "dead", "reviving", "alerted", "unindexed"];

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

function clampOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function buildServer(deps: BuildServerDeps): FastifyInstance {
  const { tokenRepo, snapshotRepo, alertRepo, poller, logger, botToken, allowedUserId, classifierConfig } = deps;

  const app = Fastify({ logger: false });

  app.setErrorHandler((err, request, reply) => {
    logger.error({ err: String(err), path: request.url }, "Unhandled API error");
    reply.code(500).send({ error: "Internal server error" });
  });

  app.register(
    async (api) => {
      api.addHook("preHandler", requireTelegramAuth(botToken, allowedUserId));

      api.get("/status", async () => {
        const counts = tokenRepo.countByStatus();
        const graduation = tokenRepo.countByGraduation();
        return {
          counts,
          revivingCandidates: tokenRepo.countRevivingCandidates(),
          graduated: graduation.graduated,
          ungraduated: graduation.ungraduated,
          lastPollAt: poller.getLastRunAt() ?? null,
        };
      });

      api.get("/tokens", async (request: FastifyRequest) => {
        const query = request.query as Record<string, string | undefined>;
        const status = query.status && VALID_STATUSES.includes(query.status as TokenStatus) ? (query.status as TokenStatus) : undefined;
        const sort = query.sort === "symbol" ? "symbol" : "status_changed_at";
        const limit = clampLimit(query.limit, 25, 100);
        const offset = clampOffset(query.offset);
        const revivingOnly = query.reviving === "true";
        const graduated = query.graduated === "true" ? true : query.graduated === "false" ? false : undefined;

        const { rows, total } = tokenRepo.search({
          status,
          revivingOnly,
          graduated,
          search: query.search || undefined,
          sort,
          limit,
          offset,
        });

        return { items: rows, total, limit, offset };
      });

      api.get("/tokens/:address", async (request: FastifyRequest, reply: FastifyReply) => {
        const { address } = request.params as { address: string };
        const token = tokenRepo.findByAddress(address);
        if (!token) {
          reply.code(404).send({ error: "Token not found" });
          return;
        }
        const snapshots = snapshotRepo.recentSince(address, Date.now() - 24 * 60 * 60 * 1000, 100);
        return { ...token, snapshots };
      });

      api.get("/alerts", async (request: FastifyRequest) => {
        const query = request.query as Record<string, string | undefined>;
        const limit = clampLimit(query.limit, 25, 100);
        const offset = clampOffset(query.offset);
        return {
          items: alertRepo.list(limit, offset),
          total: alertRepo.count(),
          limit,
          offset,
        };
      });

      api.get("/settings", async () => {
        return {
          deadMinAgeHours: classifierConfig.deadMinAgeHours,
          deadVolume24hUsd: classifierConfig.deadVolume24hUsd,
          deadMinBuys1h: classifierConfig.deadMinBuys1h,
          deadConfirmPolls: classifierConfig.deadConfirmPolls,
          revivalVolumeMultiple: classifierConfig.revivalVolumeMultiple,
          revivalMinVolume1hUsd: classifierConfig.revivalMinVolume1hUsd,
          revivalMinBuys1h: classifierConfig.revivalMinBuys1h,
          revivalLiquidityFloorPct: classifierConfig.revivalLiquidityFloorPct,
          revivalConfirmPolls: classifierConfig.revivalConfirmPolls,
          demoteConfirmPolls: classifierConfig.demoteConfirmPolls,
          alertCooldownHours: classifierConfig.alertCooldownHours,
        };
      });
    },
    { prefix: "/api" }
  );

  return app;
}
