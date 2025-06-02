import express from "express";
import prisma from "./config/prisma.js";
import redisClient from "./config/redis.js"; // Add this line

const app = express();
const router= require('./routes/allroutes');

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

app.listen(5000, () => {
  console.log("Server is running on port 5000");
});