import prisma from "../config/prisma.js";
import redis from "../config/redis.js";
import { getCurrentRound } from "./global.handler.js";
import { round0AdminAddUser, round0AdminRemoveUser, endRound0 } from "./round0.handler.js";
import { round1AdminAddUser, round1AdminRemoveUser, endRound1 } from "./round1.handler.js";
import { round2AdminAddUser, round2AdminRemoveUser } from "./round2.handler.js";
import { round3AdminAddUser, round3AdminRemoveUser } from "./round3.handler.js";

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
          await round0AdminAddUser(io, userId);
          return callback?.({ success: true, message: `User added to round ${roundNumber}` });
        case 1:
          await round1AdminAddUser(io, userId);
          return callback?.({ success: true, message: `User added to round ${roundNumber}` });
        case 2:
          await round2AdminAddUser(io, userId);
          return callback?.({ success: true, message: `User added to round ${roundNumber}` });
        case 3:
          await round3AdminAddUser(io, userId);
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
          return callback?.({ success: true, message: `Round ${roundNumber} ended successfully` });

        case 1:
          await endRound1(io);
          return callback?.({ success: true, message: `Round ${roundNumber} ended successfully` });
        // TODO: Add handlers for other rounds (round 2, round 3, etc.)
        // case 2:
        //   await endRound2(io, true);
        //   return callback?.({ success: true, message: `Round ${roundNumber} ended successfully` });
        // case 3:
        //   await endRound3(io, true);
        //   return callback?.({ success: true, message: `Round ${roundNumber} ended successfully` });
        default:
          console.warn(`[ADMIN] Invalid round ${roundNumber} for endRound`);
          return callback?.({ success: false, error: `Invalid round number: ${roundNumber}` });
      }
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

  