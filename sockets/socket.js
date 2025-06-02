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

    socket.on("createRoom", (settings) => {
      const roomId = generateRoomID();
      socket.emit("roomCreated", { roomId, settings });
    });
  });
}

export default initializeSocket;
