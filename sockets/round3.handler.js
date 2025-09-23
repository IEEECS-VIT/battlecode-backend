import redis from "../config/redis.js";
import prisma from "../config/prisma.js";

/**
 * ROUND 3 SOCKET HANDLER
 * * CLIENT → SERVER EVENTS:
 * - round3:join - Join round lobby
 * - round3:ready - Start round (admin only)
 * - round3:lockQuestion - Lock a solved question to view others' code
 * - round3:getState - Get current game state
 * - round3:reset - Reset round (admin only)
 * - disconnect - Handle user disconnect
 * * SERVER → CLIENT EVENTS:
 * - lobby:round3 - Lobby participant updates
 * - round3:start - Round started with questions and timer
 * - round3:viewSubmissions - Sent to a user with others' code for a locked question
 * - round3:hackSuccessful - (Optional) Sent to hacker and victim
 * - round3:ended - Round has ended
 * * REDIS KEYS:
 * - round3:lobby - Hash of participants {userId: participantData}
 * - round3:state - Current state of the round ('LOBBY', 'IN_PROGRESS', 'COMPLETED')
 * - round3:timer:global - The round's start time (timestamp)
 * - round3:problems - The array of 6 round questions
 */

const ROUND_DURATION = 90 * 60; // 90 minutes in seconds
const HACKING_PHASE_START_SECONDS = 30 * 60; // Hacking starts when 30 mins are left
const ROUND_NUMBER = 3;

// In-memory state for quick access
let globalRoundState = {
  isActive: false,
  startTime: null,
  isHackingPhase: false,
  timerInterval: null,
  problems: [],
};

const getRedisKeys = (userId = null) => ({
  lobby: `round${ROUND_NUMBER}:lobby`,
  state: `round${ROUND_NUMBER}:state`,
  timer: `round${ROUND_NUMBER}:timer:global`,
  problems: `round${ROUND_NUMBER}:problems`,
});

// Resets the in-memory state
const initializeGlobalState = () => {
  globalRoundState.isActive = false;
  globalRoundState.startTime = null;
  globalRoundState.isHackingPhase = false;
  globalRoundState.problems = [];

  if (globalRoundState.timerInterval) {
    clearInterval(globalRoundState.timerInterval);
    globalRoundState.timerInterval = null;
  }
};

// Clears Redis and resets the round
const resetRoundState = async () => {
  try {
    initializeGlobalState();
    const keys = getRedisKeys();
    await redis.del(keys.lobby, keys.state, keys.timer, keys.problems);
    console.log(`[ROUND 3] All Redis keys for Round 3 have been cleared.`);
    return true;
  } catch (error) {
    console.error('[ROUND 3] Error resetting round state:', error);
    return false;
  }
};

initializeGlobalState();

export const round3Handler = (io, socket) => {
  
  // ## UTILITY FUNCTIONS

  const validateUser = () => {
    const userId = socket.user?.id;
    if (!userId) {
      return { error: 'Unauthorized - No user ID' };
    }
    return { userId };
  };

  const broadcastLobbyUpdate = async () => {
    try {
      const keys = getRedisKeys();
      const allParticipantsRaw = await redis.hgetall(keys.lobby);
      const lobbyParticipants = Object.values(allParticipantsRaw).map(p => JSON.parse(p));

      io.to(`round${ROUND_NUMBER}`).emit('lobby:round3', {
        participants: lobbyParticipants,
        totalParticipants: lobbyParticipants.length,
        isActive: globalRoundState.isActive,
      });
    } catch (error) {
      console.error('[ROUND 3] Error broadcasting lobby update:', error);
    }
  };

  const startGlobalTimer = (io) => {
    if (globalRoundState.timerInterval) {
      clearInterval(globalRoundState.timerInterval);
    }

    globalRoundState.timerInterval = setInterval(async () => {
      try {
        const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
        const timeRemaining = ROUND_DURATION - elapsed;

        // Check if hacking phase should start
        if (timeRemaining <= HACKING_PHASE_START_SECONDS && !globalRoundState.isHackingPhase) {
          globalRoundState.isHackingPhase = true;
          console.log('[ROUND 3] Hacking phase has started!');
          // Optionally, emit an event to clients
          io.to(`round${ROUND_NUMBER}`).emit('round3:hackingPhaseStart', {
             message: 'Hacking phase has begun!',
             timeRemaining
          });
        }
        
        if (timeRemaining <= 0) {
          clearInterval(globalRoundState.timerInterval);
          globalRoundState.isActive = false;

          await prisma.round.update({
            where: { roundNumber: ROUND_NUMBER },
            data: { status: 'COMPLETED' },
          });

          await redis.set(getRedisKeys().state, 'COMPLETED');

          io.to(`round${ROUND_NUMBER}`).emit('round3:ended', {
            message: 'Round 3 has ended!',
          });
          console.log('[ROUND 3] Round has officially ended.');

        } else {
          // Regular timer update
          io.to(`round${ROUND_NUMBER}`).emit('round3:timer', { timeRemaining });
        }
      } catch (error) {
        console.error('[ROUND 3] Error in global timer:', error);
      }
    }, 1000);
  };
  
  // Syncs the in-memory state with Redis on server start/reconnect
  const syncGlobalStateWithRedis = async () => {
    try {
      const keys = getRedisKeys();
      const roundStatus = await redis.get(keys.state);

      if (roundStatus === 'IN_PROGRESS') {
        const startTimeRaw = await redis.get(keys.timer);
        const problemsRaw = await redis.get(keys.problems);
        
        if (startTimeRaw && problemsRaw) {
          const startTime = parseInt(startTimeRaw);
          const elapsed = Math.floor((Date.now() - startTime) / 1000);

          if (elapsed < ROUND_DURATION) {
            globalRoundState.isActive = true;
            globalRoundState.startTime = startTime;
            globalRoundState.problems = JSON.parse(problemsRaw);
            globalRoundState.isHackingPhase = (ROUND_DURATION - elapsed) <= HACKING_PHASE_START_SECONDS;
            startGlobalTimer(io);
            console.log('[ROUND 3] Synced active round state from Redis.');
          } else {
             // Round ended while server was down
             await prisma.round.update({ where: { roundNumber: ROUND_NUMBER }, data: { status: 'COMPLETED' }});
             await redis.set(keys.state, 'COMPLETED');
             initializeGlobalState();
          }
        }
      } else {
        initializeGlobalState();
      }
    } catch (error) {
      console.error('[ROUND 3] Error syncing global state with Redis:', error);
    }
  };


  // ## CLIENT → SERVER EVENT HANDLERS

  const handleJoinLobby = async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });
    
    try {
      const roundDB = await prisma.round.findUnique({ where: { roundNumber: ROUND_NUMBER }});
      if (roundDB?.status !== 'LOBBY') {
        return callback?.({ success: false, error: `Round is not in lobby state. Current: ${roundDB?.status}` });
      }

      const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, role: true }
      });

      if (!user) return callback?.({ success: false, error: 'User not found.' });

      const participantData = {
          userId: user.id,
          username: user.username,
          status: 'LOBBY',
      };
      
      await redis.hset(getRedisKeys().lobby, userId, JSON.stringify(participantData));
      socket.join(`round${ROUND_NUMBER}`);

      await broadcastLobbyUpdate();
      console.log(`[ROUND 3] User ${user.username} (${userId}) joined the lobby.`);
      callback?.({ success: true, message: 'Successfully joined lobby.' });
    } catch (err) {
      console.error('[ROUND 3] Join error:', err);
      callback?.({ success: false, error: 'Server error while joining lobby.' });
    }
  };

  const handleAdminReady = async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });

    try {
      const admin = await prisma.user.findUnique({ where: { id: userId }});
      if (admin?.role !== 'ADMIN') {
        return callback?.({ success: false, error: 'Unauthorized: Not an admin.' });
      }
      if (globalRoundState.isActive) {
        return callback?.({ success: false, error: 'Round is already active.' });
      }
      
      // Fetch 6 problems for Round 3
      const problems = await prisma.problem.findMany({
        where: { difficulty: 'R3' },
        take: 6,
      });

      if (problems.length < 6) {
        return callback?.({ success: false, error: `Insufficient problems found for Round 3. Found only ${problems.length}.`});
      }

      const startTime = Date.now();
      
      // Use a pipeline for atomic Redis operations
      const redisPipeline = redis.pipeline();
      const keys = getRedisKeys();
      redisPipeline.set(keys.state, 'IN_PROGRESS');
      redisPipeline.set(keys.timer, startTime);
      redisPipeline.set(keys.problems, JSON.stringify(problems));
      await redisPipeline.exec();
      
      // Update DB
      await prisma.round.update({
        where: { roundNumber: ROUND_NUMBER },
        data: { status: 'IN_PROGRESS' },
      });

      // Update in-memory state
      globalRoundState.isActive = true;
      globalRoundState.startTime = startTime;
      globalRoundState.problems = problems;
      
      startGlobalTimer(io);

      io.to(`round${ROUND_NUMBER}`).emit('round3:start', {
        questions: problems,
        startTime,
        duration: ROUND_DURATION,
      });

      console.log(`[ROUND 3] Round started by admin ${admin.username}.`);
      callback?.({ success: true, message: 'Round 3 has started.' });

    } catch (err) {
      console.error('[ROUND 3] Error starting round:', err);
      callback?.({ success: false, error: 'Failed to start the round.' });
    }
  };

  const handleLockQuestion = async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });
    
    const { questionId } = payload;
    if (!questionId) return callback?.({ success: false, error: 'Question ID is required.' });

    try {
      // 1. Check if hacking phase is active
      if (!globalRoundState.isHackingPhase) {
        return callback?.({ success: false, error: 'Hacking phase is not active yet.' });
      }
      
      // 2. Check if the user has an accepted solution for this question
      const successfulSubmission = await prisma.submission.findFirst({
        where: {
          userId,
          problemId: questionId,
          status: 'ACCEPTED',
          roundId: ROUND_NUMBER,
        },
      });
      if (!successfulSubmission) {
        return callback?.({ success: false, error: 'You must have an accepted solution to lock this question.' });
      }

      // 3. Check if the user has already locked this question
      const existingLock = await prisma.lockedSolution.findUnique({
        where: { userId_questionId: { userId, questionId } },
      });
      if (existingLock) {
        return callback?.({ success: false, error: 'You have already locked this question.' });
      }

      // 4. Create the lock in the database
      await prisma.lockedSolution.create({
        data: { userId, questionId },
      });
      
      // 5. Fetch all *other* users' latest accepted submissions for this question
      // This query gets the latest accepted submission for each user for the specific problem
      const otherSubmissions = await prisma.submission.findMany({
        where: {
            problemId: questionId,
            status: 'ACCEPTED',
            NOT: { userId: userId }
        },
        orderBy: {
            createdAt: 'desc'
        },
        distinct: ['userId'], // Get only the most recent one per user
        select: {
            userId: true,
            code: true,
            language: true,
            user: { select: { username: true }}
        }
      });

      // 6. Send the submissions to the user who locked the question
      socket.emit('round3:viewSubmissions', {
        questionId,
        submissions: otherSubmissions,
      });

      console.log(`[ROUND 3] User ${userId} locked question ${questionId}.`);
      callback?.({ success: true, message: `Question locked. Found ${otherSubmissions.length} submissions to view.` });

    } catch (err) {
      console.error(`[ROUND 3] Error locking question ${questionId} for user ${userId}:`, err);
      callback?.({ success: false, error: 'Server error while locking question.' });
    }
  };

  const handleGetState = async (callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });

    try {
        const elapsed = globalRoundState.startTime ? Math.floor((Date.now() - globalRoundState.startTime) / 1000) : 0;
        const timeRemaining = Math.max(0, ROUND_DURATION - elapsed);

        // Get user's locked questions
        const locked = await prisma.lockedSolution.findMany({
            where: { userId },
            select: { questionId: true }
        });
        const lockedQuestionIds = locked.map(l => l.questionId);

        socket.join(`round${ROUND_NUMBER}`);
        
        callback?.({
            success: true,
            isActive: globalRoundState.isActive,
            isHackingPhase: globalRoundState.isHackingPhase,
            timeRemaining,
            questions: globalRoundState.problems,
            lockedQuestionIds
        });
    } catch (err) {
        console.error('[ROUND 3] Error getting state:', err);
        callback?.({ success: false, error: 'Failed to retrieve state.' });
    }
  };
  
  const handleReset = async (callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });
    
    try {
      const admin = await prisma.user.findUnique({ where: { id: userId }});
      if (admin?.role !== 'ADMIN') {
        return callback?.({ success: false, error: 'Unauthorized.' });
      }

      // Reset database status
      await prisma.round.update({
          where: { roundNumber: ROUND_NUMBER },
          data: { status: 'LOBBY' }
      });
      // Clear locked solutions and hack attempts for this round
      await prisma.lockedSolution.deleteMany({ where: { problem: { roundId: ROUND_NUMBER } } });
      await prisma.hackAttempt.deleteMany({ where: { problem: { roundId: ROUND_NUMBER } } });

      const success = await resetRoundState();
      
      if (success) {
        io.to(`round${ROUND_NUMBER}`).emit('round3:reset', { message: 'Round has been reset by an admin.' });
        console.log(`[ROUND 3] Round was reset by admin ${admin.username}.`);
        callback?.({ success: true, message: 'Round reset successfully.' });
      } else {
        callback?.({ success: false, error: 'Failed to reset round in Redis.' });
      }
    } catch (err) {
      console.error('[ROUND 3] Reset error:', err);
      callback?.({ success: false, error: 'Server error during reset.' });
    }
  };
  
  const handleDisconnect = async () => {
    const { userId, error } = validateUser();
    if (error) return;

    try {
        const keys = getRedisKeys();
        const participantRaw = await redis.hget(keys.lobby, userId);
        if(participantRaw) {
            await redis.hdel(keys.lobby, userId);
            await broadcastLobbyUpdate();
            console.log(`[ROUND 3] User ${userId} disconnected and was removed from the lobby.`);
        }
    } catch(err) {
        console.error(`[ROUND 3] Error during disconnect for user ${userId}:`, err);
    }
  };
  
  // ## EVENT LISTENERS

  socket.on('round3:join', handleJoinLobby);
  socket.on('round3:ready', handleAdminReady);
  socket.on('round3:lockQuestion', handleLockQuestion);
  socket.on('round3:getState', handleGetState);
  socket.on('round3:reset', handleReset);
  socket.on('disconnect', handleDisconnect);

  // Sync state when a new client connects
  syncGlobalStateWithRedis().catch(error => {
    console.error('[ROUND 3] Initial sync failed:', error);
  });
};

// ## EXPORTED FUNCTIONS

// Emits hack success/failure to the relevant users
export const emitHackResult = (io, result) => {
    const { hackerId, targetId, questionId, status } = result;
    const eventName = status === 'SUCCESSFUL' ? 'round3:hackSuccessful' : 'round3:hackFailed';
    const payload = {
        questionId,
        hackerId,
        targetId,
        message: `Your hack attempt against user ${targetId} on question ${questionId} was ${status.toLowerCase()}.`
    };
    
    // Notify the hacker
    io.to(hackerId).emit(eventName, payload);

    // Notify the victim
    const victimPayload = {
      ...payload,
      message: `Your solution for question ${questionId} was successfully hacked by ${hackerId}!`
    };
    if(status === 'SUCCESSFUL') {
      io.to(targetId).emit('round3:hacked', victimPayload);
    }
};