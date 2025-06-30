// Fixed socket.js
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
  try {
    await redis.setex(getMatchKey(matchId), 86400, JSON.stringify(matchData));
    await redis.sadd(getActiveMatchesKey(), matchId);
    console.log(`Match created: ${matchId}`);
  } catch (error) {
    console.error(`Error creating match ${matchId}:`, error);
    throw error;
  }
}

async function getMatch(matchId) {
  try {
    const data = await redis.get(getMatchKey(matchId));
    const match = data ? JSON.parse(data) : null;
    console.log(`Match retrieved: ${matchId}`, match ? "found" : "not found");
    return match;
  } catch (error) {
    console.error(`Error getting match ${matchId}:`, error);
    throw error;
  }
}

async function updateMatch(matchId, matchData) {
  try {
    await redis.setex(getMatchKey(matchId), 86400, JSON.stringify(matchData));
    console.log(`Match updated: ${matchId}`);
  } catch (error) {
    console.error(`Error updating match ${matchId}:`, error);
    throw error;
  }
}

export default function initializeSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error("Authentication token required"));
      }

      const user = await verifySocketToken(token);
      if (!user) {
        return next(new Error("Invalid token"));
      }

      socket.user = user;
      console.log(`User authenticated: ${user.id}`);
      next();
    } catch (error) {
      console.error("Authentication error:", error);
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.user.id} (Socket: ${socket.id})`);

    // Join room handler
    socket.on("joinRoom", ({ matchId }) => {
      socket.join(matchId);
      console.log(`User ${socket.user.id} joined room: ${matchId}`);
    });

    // Get match data
    socket.on("getMatch", async ({ matchId }, callback) => {
      console.log(
        `Getting match data for: ${matchId} by user: ${socket.user.id}`
      );

      try {
        if (!matchId) {
          return callback({ error: "Match ID is required" });
        }

        const match = await getMatch(matchId);
        if (!match) {
          console.log(`Match not found: ${matchId}`);
          return callback({ error: "Match not found" });
        }

        console.log(`Sending match data for: ${matchId}`, {
          status: match.status,
          playerA: match.playerAId,
          playerB: match.playerBId,
        });

        callback({ match });
      } catch (error) {
        console.error("Get match error:", error);
        callback({ error: "Failed to get match data" });
      }
    });

    // Create Match
    socket.on("createMatch", async (settings, callback) => {
      console.log(`Creating match for user: ${socket.user.id}`, settings);

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
            topics: settings.topics || [],
          },
          createdAt: new Date().toISOString(),
        };

        await createMatch(matchId, matchData);
        socket.join(matchId);

        console.log(`Match created successfully: ${matchId}`);

        callback({
          success: true,
          matchId,
          playerId: socket.user.id,
          match: matchData,
        });

        io.to(matchId).emit("matchCreated", matchData);
      } catch (error) {
        console.error("Match creation error:", error);
        callback({
          error: "Failed to create match",
          details: error.message,
        });
      }
    });

    // Join Match
    socket.on("joinMatch", async ({ matchId }, callback) => {
      console.log(
        `User ${socket.user.id} attempting to join match: ${matchId}`
      );

      try {
        if (!matchId) {
          throw new Error("Match ID is required");
        }

        const match = await getMatch(matchId);
        if (!match) {
          throw new Error("Match not found");
        }

        if (match.playerBId) {
          throw new Error("Match is full");
        }

        if (match.playerAId === socket.user.id) {
          throw new Error("Cannot join your own match");
        }

        match.playerBId = socket.user.id;
        match.status = "READY";
        await updateMatch(matchId, match);

        socket.join(matchId);

        console.log(
          `User ${socket.user.id} joined match ${matchId} successfully`
        );

        callback({
          success: true,
          matchId,
          playerId: socket.user.id,
          match,
        });

        io.to(matchId).emit("matchReady", match);
      } catch (error) {
        console.error("Join match error:", error);
        callback({ error: error.message });
      }
    });

    // Start Match
    socket.on("startMatch", async ({ matchId }) => {
      console.log(`Starting match: ${matchId} by user: ${socket.user.id}`);

      try {
        if (!matchId) {
          console.error("Start match: Match ID is required");
          return;
        }

        const match = await getMatch(matchId);
        if (!match) {
          console.error(`Start match: Match not found: ${matchId}`);
          return;
        }

        if (match.status !== "READY") {
          console.error(
            `Start match: Match not ready: ${matchId}, status: ${match.status}`
          );
          return;
        }

        if (match.playerAId !== socket.user.id) {
          console.error(
            `Start match: Only player A can start the match. User: ${socket.user.id}, PlayerA: ${match.playerAId}`
          );
          return;
        }

        match.status = "IN_PROGRESS";
        match.startedAt = new Date().toISOString();
        await updateMatch(matchId, match);

        console.log(`Match started successfully: ${matchId}`);

        io.to(matchId).emit("matchStarted", {
          matchId,
          startTime: match.startedAt,
          timeLimit: match.settings.timeLimit,
        });
      } catch (error) {
        console.error("Start match error:", error);
      }
    });

    socket.on("disconnect", () => {
      console.log(
        `User disconnected: ${socket.user.id} (Socket: ${socket.id})`
      );
    });

    function generateMatchId() {
      return Math.random().toString(36).substring(2, 8).toUpperCase();
    }
  });
}
