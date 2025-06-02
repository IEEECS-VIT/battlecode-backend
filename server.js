import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import routes from "./routes/index.js";
import prisma from "./config/prisma.js";
import redisClient from "./config/redis.js";
import initializeSocket from "./sockets/socket.js";

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

// Redis cache example
app.get("/api/cache-example", async (req, res) => {
  const cacheKey = "example_data";
  try {
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res.json({ source: "cache", data: JSON.parse(cachedData) });
    }
    const dbData = await prisma.user.findMany();
    await redisClient.setex(cacheKey, 3600, JSON.stringify(dbData));
    return res.json({ source: "database", data: dbData });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/", (req, res) => {
  res.send("BattleCode Backend");
});

const PORT = 5000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
