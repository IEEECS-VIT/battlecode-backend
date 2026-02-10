import 'dotenv/config';
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import routes from "./routes/index.js";
import cors from "cors";
import initializeSocket from "./sockets/index.js";
import getJudge0Client from "./config/judge0.js"; // adjust path if needed

// (async () => {
//   try {
//     const judge0 = await getJudge0Client();
//     const res = await judge0.get("/v1/languages");
//     console.log("✅ Judge0 connected. Languages:", res.data.length);
//   } catch (err) {
//     console.error("❌ Judge0 connection failed");
//     console.error(err.response?.data || err.message);
//   }
// })();


const app = express();
const httpServer = createServer(app);
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://battlecode-frontend-cc.vercel.app",
    "https://battlecode-backend.ieeecsvit.com",
    "https://battlecode.ieeecsvit.com"
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  credentials: true
}));

// Socket.io setup
const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://battlecode-frontend-cc.vercel.app",
      "https://battlecode-backend.ieeecsvit.com",
      "https://battlecode.ieeecsvit.com"
    ],
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

// Socket.IO health check endpoint
app.get("/socket.io/health", (req, res) => {
  res.json({
    status: "ok",
    socketio: "running",
    path: "/socket.io/",
    transport: ["polling", "websocket"]
  });
});

const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0'; // Bind to all interfaces

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Socket.IO endpoint: http://${HOST}:${PORT}/socket.io/`);
});
