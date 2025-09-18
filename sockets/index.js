import { createServer } from "http";
import express from "express";
import { verifySocketToken } from "../middleware/authMiddleware.js";
import { round0Handler } from "./round0.handler.js";  
import { round1Handler } from "./round1.handler.js";
import { round2Handler } from "./round2.handler.js";
import { round3Handler } from "./round3.handler.js";
import { adminHandler } from "./admin.handler.js";
import { globalHandler, broadcastLeaderboard, getLeaderboard } from "./global.handler.js";

const app = express();
const httpServer = createServer(app);

// Store the previous leaderboard to detect changes
let previousLeaderboardHash = null;

// Function to check for leaderboard changes and broadcast if needed
const checkAndBroadcastLeaderboard = async (io) => {
  try {
    const currentLeaderboard = await getLeaderboard();
    
    // Don't proceed if leaderboard is empty (likely database error)
    if (!currentLeaderboard || currentLeaderboard.length === 0) {
      console.log("Skipping leaderboard broadcast - empty leaderboard received");
      return;
    }
    
    const currentHash = JSON.stringify(currentLeaderboard);
    
    // Only broadcast if there are changes
    if (currentHash !== previousLeaderboardHash) {
      console.log("Leaderboard changes detected, broadcasting update...");
      await broadcastLeaderboard(io);
      previousLeaderboardHash = currentHash;
    } else {
      console.log("No leaderboard changes detected");
    }
  } catch (error) {
    console.error("Error checking leaderboard changes:", error.message);
    // Don't throw error to prevent interval from stopping
  }
};

export default function initializeSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        console.error("Authentication error: Token not provided.");
        return next(new Error("Authentication token required"));
      }

      const user = await verifySocketToken(token);
      if (!user) {
        console.error("Authentication error: Invalid token.");
        return next(new Error("Invalid token"));
      }

      socket.user = user;
      console.log(`User authenticated: ${user.email}`);
      next();
    } catch (error) {
      console.error("Authentication error:", error);
      next(new Error("Authentication failed"));
    }
  });

  const onConnection = (socket) => {
    console.log(`User connected: ${socket.user.email} (Socket ID: ${socket.id})`);

    round0Handler(io, socket);
    round1Handler(io, socket);
    round2Handler(io, socket);
    round3Handler(io, socket);
    adminHandler(io,socket);
    globalHandler(io,socket);

    socket.on("disconnect", () => {
      console.log(
        `User disconnected: ${socket.user.email} (Socket ID: ${socket.id})`
      );
    });
  };

  io.on("connection", onConnection);

  // Set up automatic leaderboard broadcasting every 10 minutes (reduced frequency to reduce DB load)
  const leaderboardInterval = setInterval(() => {
    checkAndBroadcastLeaderboard(io);
  }, 10 * 60 * 1000); // 10 minutes in milliseconds

  console.log("Socket server initialized with automatic leaderboard broadcasting every 10 minutes");

  // Clean up interval when server shuts down
  process.on('SIGINT', () => {
    clearInterval(leaderboardInterval);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    clearInterval(leaderboardInterval);
    process.exit(0);
  });
}
