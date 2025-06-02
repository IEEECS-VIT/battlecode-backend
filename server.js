const express = require("express");
const app = express();
const PORT= process.env.PORT || 5050;
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();
const prisma = require("./config/prisma");


app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());

//route
app.use('/api',require('./routes/allroutes'));

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

app.get("/", (req, res) => {
  res.send("BattleCode Backend");
});

app.get("/test-prisma", async (req, res) => {
  try {
    // Example query to test Prisma connection
    const users = await prisma.user.findMany();
    res.json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});