import prisma from "../config/prisma.js";
import { getCurrentRound } from "./global.handler.js";
import { round1AdminAddUser,round1AdminRemoveUser } from "./round1.handler.js";

export const adminHandler = (io, socket) => {
  // Check if user is admin
  const isAdmin = socket.user.role === 'ADMIN';
  
  if (!isAdmin) {
    console.log(`Non-admin user ${socket.user.email} tried to access admin functions`);
  }

  // Handle round status update
  const handleUpdateRoundStatus = async (payload, callback) => {
    if (socket.user.role !== 'ADMIN') {
      return callback?.({ success: false, error: 'Unauthorized' });
    }

    try {
      const { roundNumber, status } = payload;
      
      if (!roundNumber || !status) {
        if (callback) {
          callback({ success: false, error: "Round number and status are required" });
        }
        return;
      }

      // Validate status
      const validStatuses = ['LOCKED', 'LOBBY', 'IN_PROGRESS', 'COMPLETED'];
      if (!validStatuses.includes(status)) {
        if (callback) {
          callback({ success: false, error: "Invalid status" });
        }
        return;
      }

      // Update round status
      await prisma.round.update({
        where: { roundNumber: parseInt(roundNumber) },
        data: { status }
      });

      console.log(`Admin ${socket.user.id} updated round ${roundNumber} status to ${status}`);

      // Broadcast updated round info to all clients
      const currentRound = await getCurrentRound();
      io.emit("server:currentRound", currentRound);

      if (callback) {
        callback({ success: true, message: `Round ${roundNumber} status updated to ${status}` });
      }
    } catch (error) {
      console.error("Error updating round status:", error);
      if (callback) {
        callback({ success: false, error: "Failed to update round status" });
      }
    }
  };

    socket.on('admin:adduser', async ({ user, round }) => {
    if (socket.user.role !== 'ADMIN') return;

    const userId = user?.email;
    if (!userId) {
      console.warn('[ADMIN] adduser called without user email');
      return;
      }
    const roundNumber = round;

    switch (roundNumber) {
      case 1:
        return round1AdminAddUser(io, userId);
      default:
        console.warn(`[ADMIN] Invalid round ${roundNumber} for adduser`);
        return;
    }
  });

  socket.on('admin:removeuser', async ({ user, round }) => {
    if (socket.user.role !== 'ADMIN') return;

    const userId = user?.email;
    if (!userId) {
      console.warn('[ADMIN] adduser called without user email');
      return;
    }
    const roundNumber = round;

    switch (roundNumber) {
      case 1:
        return round1AdminRemoveUser(io, userId);
      default:
        console.warn(`[ADMIN] Invalid round ${roundNumber} for removeuser`);
        return;

    }
  });

    // Legacy message handler
  const handleClientMessage = (payload, callback) => {
    console.log(
      `Message from admin ${socket.id} (User: ${socket.user.id}): "${payload.message}"`
    );

    socket.emit("server:messageReceived", {
      confirmation: `We received your message: "${payload.message}"`,
    });

    if (callback) {
      callback({ success: true, status: "Message handled by server." });
    }
  };

  // Socket event listeners (admin only)
  socket.on("admin:updateRoundStatus", handleUpdateRoundStatus);
  socket.on("client:sendMessage", handleClientMessage);

  if (isAdmin) {
    console.log(`Admin ${socket.user.id} connected to admin socket`);
  }

};

  