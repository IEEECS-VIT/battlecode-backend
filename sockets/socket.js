import { Server } from "socket.io";
import { createServer } from "http";
import express from "express";
import redis from "../config/redis.js";
import { verifySocketToken } from "../middleware/authMiddleware.js";

const app = express();
const httpServer = createServer(app);

const getMatchKey = (matchId) => `match:${matchId}`;
const getActiveMatchesKey = () => "active_matches";

async function createMatch(matchId, matchData) {
  await redis.setex(getMatchKey(matchId), 86400, JSON.stringify(matchData));
  await redis.sadd(getActiveMatchesKey(), matchId);
}

async function getMatch(matchId) {
  const data = await redis.get(getMatchKey(matchId));
  return data ? JSON.parse(data) : null;
}

async function updateMatch(matchId, matchData) {
  await redis.setex(getMatchKey(matchId), 86400, JSON.stringify(matchData));
}

export default function initializeSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.replace("Bearer ", "");
      if (!token) throw new Error("No token provided");

      const user = await verifySocketToken(token);
      socket.user = user;
      next();
    } catch (error) {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.user.id}`);

    // 1. Create Match
    socket.on("createMatch", async (settings, callback) => {
      try {
        const matchId = generateMatchId();
        const matchData = {
          id: matchId,
          playerAId: socket.user.id,
          status: "WAITING",
          settings: {
            timeLimit: settings.timeLimit || 30,
            noOfQuestions: settings.noOfQuestions,
            difficulty: settings.difficulty || "MEDIUM",
          },
          createdAt: new Date().toISOString(),
        };

        await createMatch(matchId, matchData);
        socket.join(matchId);

        callback({
          success: true,
          matchId,
          playerId: socket.user.id,
        });

        io.to(matchId).emit("matchCreated", matchData);
      } catch (error) {
        callback({ error: "Failed to create match" });
      }
    });

    // 2. Join Match
    socket.on("joinMatch", async ({ matchId }, callback) => {
      try {
        const match = await getMatch(matchId);
        if (!match) throw new Error("Match not found");
        if (match.playerBId) throw new Error("Match is full");

        match.playerBId = socket.user.id;
        match.status = "READY";
        await updateMatch(matchId, match);

        socket.join(matchId);

        callback({
          success: true,
          matchId,
          playerId: socket.user.id,
        });

        io.to(matchId).emit("matchReady", {
          matchId,
          playerAId: match.playerAId,
          playerBId: match.playerBId,
          settings: match.settings,
        });
      } catch (error) {
        callback({ error: error.message });
      }
    });

    // 3. Start Match 
    socket.on("startMatch", async ({ matchId }) => {
      const match = await getMatch(matchId);
      if (!match || match.status !== "READY") return;

      match.status = "IN_PROGRESS";
      match.startedAt = new Date().toISOString();
      await updateMatch(matchId, match);

      io.to(matchId).emit("matchStarted", {
        matchId,
        startTime: match.startedAt,
        timeLimit: match.settings.timeLimit
      });
    });

    function generateMatchId() {
      return Math.random().toString(36).substring(2, 8).toUpperCase();
    }
  });
}
