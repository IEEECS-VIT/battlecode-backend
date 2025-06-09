import prisma from '../config/prisma.js';
import redisClient from '../config/redis.js';

function generateRoomID() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function initializeSocket(io) {
  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    socket.on("createRoom", async (settings) => {
      try {
        const roomId = generateRoomID();
        const {playerAId,playerBId = null,timer = 300} = settings;

        const matchData = {
          id: roomId,
          playerAId,
          duration: timer,
          ...(playerBId ? { playerBId } : {})}

        await prisma.match.create({
          data: {id: roomId, duration: timer, playerAId: playerAId , playerBId: "12"},});

        await redisClient.hset(`match:${roomId}`, {playerAId,playerBId,timer});

        socket.emit("roomCreated", { roomId, settings });
        socket.join(roomId);

      } catch (err) {
        console.error("Error creating room:", err);
        socket.emit("error", "Failed to create room.");
      }
    });

    socket.on("joinRoom", async ({ roomId, playerId }) => {
      try {
        const roomData = await redisClient.hgetall(`match:${roomId}`);

        if (!roomData.playerAId) 
        {
          return socket.emit("error", "Room not found.");
        }

        if (!roomData.playerBId) 
        {
          await redisClient.hset(`match:${roomId}`, { playerBId: playerId });
          await prisma.match.update({
            where: { id: roomId },
            data: { playerBId: playerId }});
        }

        socket.join(roomId);
        console.log(`User ${playerId} joined room ${roomId}`);
      } catch (err) {
        console.error("Error joining room:", err);
        socket.emit("error", "Failed to join room.");
      }
    });

    socket.on("disconnect", () => {
      console.log("User has disconnected:", socket.id);
    });
  });
}

export default initializeSocket;