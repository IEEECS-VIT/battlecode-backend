import express from "express";
import prisma from "./config/prisma.js";
import redisClient from "./config/redis.js"; // Add this line

const app = express();
const router= require('../battlecode project/routes/allroutes');

//implementing sockets for room creation
const { createServer } = require("http");
const { Server } = require("socket.io");
const httpServer = createServer(app);  //creates httpserver
const io = new Server(httpServer, {cors: {origin: "*",methods: ["GET", "POST"]}});  

const initializeSocket = require("./sockets/socket");
initializeSocket(io); 

app.use(express.urlencoded({ extended: true }));

//route
app.use('/api',router)
app.get("/cache-example", async (req, res) => {
  const cacheKey = "example_data";

  try {
    const cachedData = await redisClient.get(cacheKey);

    if (cachedData) {
      return res.json({ source: "cache", data: JSON.parse(cachedData) });
    }

    const dbData = await prisma.user.findMany();

    console.log(prisma);

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

httpServer.listen(8080, () => {
  console.log("Server is running on port 8080");
});






