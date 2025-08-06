import { createServer } from "http";
import express from "express";
import { verifySocketToken } from "../middleware/authMiddleware.js";
import { round0Handler } from "./round0.handler.js";
import { round1Handler } from "./round1.handler.js";
import { round2Handler } from "./round2.handler.js";
import { round3Handler } from "./round3.handler.js";
import { adminHandler } from "./admin.handler.js";
import { globalHandler } from "./global.handler.js";


const app = express();
const httpServer = createServer(app);

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
      console.log(`User authenticated: ${user.id}`);
      next();
    } catch (error) {
      console.error("Authentication error:", error);
      next(new Error("Authentication failed"));
    }
  });

  const onConnection = (socket) => {
    console.log(`User connected: ${socket.user.id} (Socket ID: ${socket.id})`);

    round0Handler(io, socket);
    round1Handler(io, socket);
    round2Handler(io, socket);
    round3Handler(io, socket);
    adminHandler(io,socket);
    globalHandler(io,socket);

    socket.on("disconnect", () => {
      console.log(
        `User disconnected: ${socket.user.id} (Socket ID: ${socket.id})`
      );
    });
  };

  io.on("connection", onConnection);
}
