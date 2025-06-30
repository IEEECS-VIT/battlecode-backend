import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import routes from "./routes/index.js";
import prisma from "./config/prisma.js";
import redis from "./config/redis.js";
import cors from "cors";
import initializeSocket from "./sockets/socket.js";

const app = express();
const httpServer = createServer(app);
app.use(cors());

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
