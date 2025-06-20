import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import routes from "./routes/index.js";
import prisma from "./battlecode-backend/config/prisma.js";
import redis from "./battlecode-backend/config/redis.js";
import initializeSocket from "./battlecode-backend/sockets/socket.js";

const app = express();
const httpServer = createServer(app);

// Socket.io setup
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Initialize socket
initializeSocket(io);

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api", routes);


app.get("/", (req, res) => {
  res.send("BattleCode Backend");
});

const PORT = 5000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
