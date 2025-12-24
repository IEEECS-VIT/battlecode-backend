import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import routes from "./routes/index.js";
import cors from "cors";
import initializeSocket from "./sockets/index.js";

const app = express();
const httpServer = createServer(app);
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://battlecode-frontend-cc.vercel.app/"
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  credentials: true
}));

// Socket.io setup
const io = new Server(httpServer, {
  cors: {
    origin: "https://battlecode-frontend-cc.vercel.app/",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  },
});

// Initialize socket
initializeSocket(io);

// Make io instance available to routes
app.set('io', io);

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api", routes);

app.get("/", (req, res) => {
  res.send("BattleCode Backend");
});

const PORT = process.env.PORT || 8000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});