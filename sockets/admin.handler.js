import prisma from "../config/prisma.js";
import redis from "../config/redis.js";
import { getCurrentRound } from "./global.handler.js";
import { round0AdminAddUser, round0AdminRemoveUser, endRound0 } from "./round0.handler.js";
import { round1AdminAddUser, round1AdminRemoveUser, endRound1 } from "./round1.handler.js";
import { round2AdminAddUser, round2AdminRemoveUser, endRound2 } from "./round2.handler.js";
import { round3AdminAddUser, round3AdminRemoveUser,endRound3 } from "./round3.handler.js";

export const adminHandler = (io, socket) => {
  // Check if user is admin
  const isAdmin = socket.user.role === 'ADMIN';
  
  if (!isAdmin) {
    console.log(`Non-admin user ${socket.user.email} tried to access admin functions`);
  }

  const validateUser = () => {
    const userId = socket.user?.email;
    if (!userId) return { error: 'Unauthorized' };
    return { userId, email: userId };
  };

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

      // If status is changing to LOBBY, ensure admin joins the round room
      if (status === 'LOBBY') {
        const roomName = roundNumber === 2 ? 'round2_lobby' : `round${roundNumber}`;
        socket.join(roomName);
        console.log(`Admin ${socket.user.id} joined room ${roomName} for lobby state`);
      }

      // If status is ending (COMPLETED), leave the round room
      if (status === 'COMPLETED') {
        const roomName = roundNumber === 2 ? 'round2_lobby' : `round${roundNumber}`;
        socket.leave(roomName);
        console.log(`Admin ${socket.user.id} left room ${roomName} - round completed`);
      }

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
  
  socket.on("admin:qualifyRound3", (payload, callback) => {
    if (socket.user.role !== 'ADMIN') {
      return callback?.({ success: false, error: 'Unauthorized' });
    }

    handleQualifyRound3(io, payload, callback);
  });

  socket.on('admin:adduser', async ({ user, round }, callback) => {
    if (socket.user.role !== 'ADMIN') {
      console.warn(`[ADMIN] Unauthorized adduser attempt by ${socket.user.email}`);
      return callback?.({ success: false, error: 'Unauthorized' });
    }

    const userId = user?.email;
    if (!userId) {
      console.warn('[ADMIN] adduser called without user email');
      return callback?.({ success: false, error: 'User email is required' });
    }
    const roundNumber = round;

    try {
      console.log(`[ADMIN] Adding user ${userId} to round ${roundNumber}`);
      
      switch (roundNumber) {
        case 0:
          await round0AdminAddUser(io, userId, true); // Pass true to bypass round status check
          return callback?.({ success: true, message: `User added to round ${roundNumber}` });
        case 1:
          await round1AdminAddUser(io, userId, true); // Pass true to bypass round status check
          return callback?.({ success: true, message: `User added to round ${roundNumber}` });
        case 2:
          await round2AdminAddUser(io, userId, true); // Pass true to bypass round status check
          return callback?.({ success: true, message: `User added to round ${roundNumber}` });
        case 3:
          await round3AdminAddUser(io, userId, true); // Pass true to bypass round status check
          return callback?.({ success: true, message: `User added to round ${roundNumber}` });
        default:
          console.warn(`[ADMIN] Invalid round ${roundNumber} for adduser`);
          return callback?.({ success: false, error: `Invalid round number: ${roundNumber}` });
      }
    } catch (error) {
      console.error(`[ADMIN] Error adding user to round ${roundNumber}:`, error);
      return callback?.({ success: false, error: error.message || 'Failed to add user' });
    }
  });

  socket.on('admin:removeuser', async ({ user, round }, callback) => {
    if (socket.user.role !== 'ADMIN') {
      console.warn(`[ADMIN] Unauthorized removeuser attempt by ${socket.user.email}`);
      return callback?.({ success: false, error: 'Unauthorized' });
    }

    const userId = user?.email;
    if (!userId) {
      console.warn('[ADMIN] removeuser called without user email');
      return callback?.({ success: false, error: 'User email is required' });
    }
    const roundNumber = round;

    try {
      console.log(`[ADMIN] Removing user ${userId} from round ${roundNumber}`);
      
      switch (roundNumber) {
        case 0:
          await round0AdminRemoveUser(io, userId);
          return callback?.({ success: true, message: `User removed from round ${roundNumber}` });
        case 1:
          await round1AdminRemoveUser(io, userId);
          return callback?.({ success: true, message: `User removed from round ${roundNumber}` });
        case 2:
          await round2AdminRemoveUser(io, userId);
          return callback?.({ success: true, message: `User removed from round ${roundNumber}` });
        case 3:
          await round3AdminRemoveUser(io, userId);
          return callback?.({ success: true, message: `User removed from round ${roundNumber}` });
        default:
          console.warn(`[ADMIN] Invalid round ${roundNumber} for removeuser`);
          return callback?.({ success: false, error: `Invalid round number: ${roundNumber}` });
      }
    } catch (error) {
      console.error(`[ADMIN] Error removing user from round ${roundNumber}:`, error);
      return callback?.({ success: false, error: error.message || 'Failed to remove user' });
    }
  });

  socket.on('admin:endRound', async ({ roundNumber }, callback) => {
    if (socket.user.role !== 'ADMIN') {
      return callback?.({ success: false, error: 'Unauthorized' });
    }

    if (roundNumber === undefined || roundNumber === null) {
      console.warn('[ADMIN] endRound called without roundNumber');
      return callback?.({ success: false, error: 'Round number is required' });
    }

    try {
      switch (roundNumber) {
        case 0:
          await endRound0(io);
          break;

        case 1:
          await endRound1(io);
          break;
      
          case 2:
          await endRound2(io, true);
          break;

          case 3:
          await endRound3(io, true);
          break;

          default:
          console.warn(`[ADMIN] Invalid round ${roundNumber} for endRound`);
          return callback?.({ success: false, error: `Invalid round number: ${roundNumber}` });
      }

        const currentRound = await getCurrentRound();
        io.emit("server:currentRound", currentRound);

        return callback?.({ success: true, message: `Round ${roundNumber} ended successfully` });
    } catch (error) {
      console.error(`[ADMIN] Error ending round ${roundNumber}:`, error);
      return callback?.({ success: false, error: error.message || 'Failed to end round' });
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

  // Handle Redis reset
  socket.on('admin:reset', async (payload) => {
    const { userId, error } = validateUser();
    if (error) {
      socket.emit('user not found');
      return;
    }

    const userData = await prisma.user.findUnique({ where: { id: userId, role: 'ADMIN' } });
    if (!userData) {
      socket.emit('unauthorized');
      return;
    }

    try {
      console.warn(`--- ADMIN (${userId}): Resetting entire Redis database ---`);
      
 
      await redis.flushdb();
      
      console.log(' Redis database has been reset successfully');
      
      
      socket.emit('admin:reset:success');
    } catch (error) {
      console.error('[Redis Reset Error]', error);
      socket.emit('failed to reset redis');
      return;
    }
  });

  // Socket event listeners (admin only)
  socket.on("admin:updateRoundStatus", handleUpdateRoundStatus);
  socket.on("client:sendMessage", handleClientMessage);

  if (isAdmin) {
    console.log(`Admin ${socket.user.id} connected to admin socket`);
  }

};

export const handleQualifyRound3 = async (io, payload, callback) => {
  try {
    const { count } = payload;

    if (!count || count <= 0) {
      return callback?.({ success: false, error: "Invalid count" });
    }

    // 1. Fetch users by leaderboard
    const users = await prisma.user.findMany({
      where: {
        role: 'PLAYER',
      },
      orderBy: { eventScore: "desc" },
      select: { id: true }
    });

    const qualifiedIds = users.slice(0, count).map(u => u.id);
    const disqualifiedIds = users.slice(count).map(u => u.id);

    // 2. Update DB
    await prisma.$transaction([
      prisma.user.updateMany({
        where: { id: { in: qualifiedIds } },
        data: { qualifiedForR3: true }
      }),
      prisma.user.updateMany({
        where: { id: { in: disqualifiedIds } },
        data: { qualifiedForR3: false }
      })
    ]);

    // 3. Notify admin + users
    io.emit("admin:qualificationUpdated", {
      qualifiedCount: qualifiedIds.length
    });

    callback?.({ success: true });
  } catch (err) {
    console.error("[ADMIN] Qualify R3 error:", err);
    callback?.({ success: false, error: "Server error" });
  }
};


  