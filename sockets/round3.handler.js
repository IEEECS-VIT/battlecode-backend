import redis from "../config/redis.js";
import prisma from "../config/prisma.js";
import { HackStatus, SubmissionStatus } from '@prisma/client';

/**
 * ROUND 3 SOCKET HANDLER
 * Manages the real-time state and events for Round 3 of the competition.
 */

const ROUND_DURATION = 0.5 * 60; // 30 second in seconds
const HACKING_PHASE_START_SECONDS = 0.5 * 60; // Hacking starts with 30 seconds left
const ROUND_NUMBER = 3;

// In-memory state for quick server access
let globalRoundState = {
  isActive: false,
  startTime: null,
  isHackingPhase: false,
  timerInterval: null,
  problems: [],
};

const getRedisKeys = () => ({
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
    await redis.del(keys.lobby,keys.state, keys.timer, keys.problems);
    console.log(`[ROUND 3] All Redis keys for Round 3 have been cleared.`);
    return true;
  } catch (error) {
    console.error('[ROUND 3] Error resetting round state:', error);
    return false;
  }
};

// Initialize state on server start
initializeGlobalState();

export const round3Handler = (io, socket) => {
  
  // ## UTILITY FUNCTIONS

  const validateUser = () => {
    // Assumes your auth middleware adds a `user` object with an `email` or `id` to the socket
    const userId = socket.user?.email 
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

        if (timeRemaining <= HACKING_PHASE_START_SECONDS && !globalRoundState.isHackingPhase) {
          globalRoundState.isHackingPhase = true;
          console.log('[ROUND 3] Hacking phase has started!');
          io.to(`round${ROUND_NUMBER}`).emit('round3:hackingPhaseStart', {
            message: 'Hacking phase has begun!',
            timeRemaining
          });
        }
        
        if (timeRemaining <= 0) {
          clearInterval(globalRoundState.timerInterval);
          globalRoundState.isActive = false;
          await prisma.round.update({ where: { roundNumber: ROUND_NUMBER }, data: { status: 'COMPLETED' } });
          await redis.set(getRedisKeys().state, 'COMPLETED');
          io.to(`round${ROUND_NUMBER}`).emit('round3:ended', { message: 'Round 3 has ended!' });
          console.log('[ROUND 3] Round has officially ended.');
        } else {
          io.to(`round${ROUND_NUMBER}`).emit('round3:timer', { timeRemaining });
        }
      } catch (error) {
        console.error('[ROUND 3] Error in global timer:', error);
      }
    }, 1000);
  };
  
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
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, role: true } });
      if (!user) return callback?.({ success: false, error: 'User not found.' });
      const participantData = { userId: user.id, username: user.username, status: 'LOBBY' };
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

  // **** FIXED FUNCTION ****
  const handleAdminReady = async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });

    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return callback?.({ success: false, error: 'User not found.' });
      }
      
      // Bypassing admin check for testing as per the frontend's "Testing Mode"
      
      if (user?.role !== 'ADMIN') {
        return callback?.({ success: false, error: 'Unauthorized: Not an admin.' });
      }
    
      
      if (globalRoundState.isActive) {
        return callback?.({ success: false, error: 'Round is already active.' });
      }

      console.log('[ROUND 3] Clearing all locked solutions before match start...');
      await prisma.lockedSolution.deleteMany({});
      console.log('[ROUND 3] Locked solutions cleared.');

      const problems = await prisma.problem.findMany({
        where: { difficulty: 'R3' },
        take: 6,
      });
      if (problems.length < 6) {
        return callback?.({ success: false, error: `Insufficient problems found. Found only ${problems.length}.` });
      }

      const startTime = Date.now();
      const redisPipeline = redis.pipeline();
      const keys = getRedisKeys();
      redisPipeline.set(keys.state, 'IN_PROGRESS');
      redisPipeline.set(keys.timer, startTime);
      redisPipeline.set(keys.problems, JSON.stringify(problems));
      await redisPipeline.exec();
      
      await prisma.round.update({
        where: { roundNumber: ROUND_NUMBER },
        data: { status: 'IN_PROGRESS' },
      });

      globalRoundState.isActive = true;
      globalRoundState.startTime = startTime;
      globalRoundState.problems = problems;
      startGlobalTimer(io);

      io.to(`round${ROUND_NUMBER}`).emit('round3:start', {
        questions: problems,
        startTime,
        duration: ROUND_DURATION,
      });

      console.log(`[ROUND 3] Round started by user ${user.username}.`);
      callback?.({ success: true, message: 'Round 3 has started.' });

    } catch (err) {
      console.error('[ROUND 3] CRITICAL ERROR in handleAdminReady:', err);
      callback?.({ success: false, error: 'Failed to start the round due to a server error.' });
    }
  };

  const handleLockQuestion = async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });
    const { questionId } = payload;
    if (!questionId) return callback?.({ success: false, error: 'Question ID is required.' });

    try {
      if (!globalRoundState.isHackingPhase) {
        return callback?.({ success: false, error: 'Hacking phase is not active yet.' });
      }
      const successfulSubmission = await prisma.submission.findFirst({
        where: { userId, problemId: questionId, roundId: ROUND_NUMBER },
      });
      if (!successfulSubmission) {
        return callback?.({ success: false, error: 'You must have an accepted solution to lock this question.' });
      }
      const existingLock = await prisma.lockedSolution.findUnique({
        where: { userId_questionId: { userId, questionId } },
      });
      if (!existingLock) {
        await prisma.lockedSolution.create({ data: { userId, questionId } });
      }
      const otherSubmissions = await prisma.submission.findMany({
        where: { problemId: questionId, status: SubmissionStatus.ACCEPTED, NOT: { userId: userId } },
        orderBy: { createdAt: 'desc' },
        distinct: ['userId'],
        select: { userId: true, code: true, language: true, user: { select: { username: true } } }
      });
      socket.emit('round3:viewSubmissions', { questionId, submissions: otherSubmissions });
      console.log(`[ROUND 3] User ${userId} locked question ${questionId}.`);
      callback?.({ success: true, message: `Question locked. Found ${otherSubmissions.length} submissions to view.` });
    } catch (err) {
      console.error(`[ROUND 3] Error locking question ${questionId} for user ${userId}:`, err);
      callback?.({ success: false, error: 'Server error while locking question.' });
    }
  };

  const handleHackAttempt = async (payload, callback) => {
    const { userId: hackerId, error } = validateUser();
    if (error) return callback?.({ success: false, error });

    const { questionId, customTestCase: customInput, targetUserId } = payload;
    if (!questionId || !customInput || !targetUserId) {
      return callback?.({ success: false, error: 'Missing required payload for hack attempt.' });
    }

    try {
        if (!globalRoundState.isHackingPhase) {
            return callback?.({ success: false, message: 'Hacking phase is not active.' });
        }
        const hackerLock = await prisma.lockedSolution.findUnique({
            where: { userId_questionId: { userId: hackerId, questionId: questionId } },
        });
        if (!hackerLock) {
            return callback?.({ success: false, message: 'You must lock a question before hacking it.' });
        }

        const existingAttempt = await prisma.hackAttempt.findFirst({
            where: {
                hackerId: hackerId,
                targetId: targetUserId,
                questionId: questionId,
            }
        });

        if (existingAttempt) {
            return callback?.({ success: false, message: 'Already attempted hack.' });
        }

        await prisma.hackAttempt.create({
            data: {
                hackerId: hackerId,
                targetId: targetUserId,
                questionId: questionId,
                customInput: customInput,
            },
        });
        
        return callback?.({ success: true, message: 'Hack submitted.' });

    } catch (err) {
        console.error(`[ROUND 3] Error submitting hack by ${hackerId}:`, err);
        callback?.({ success: false, error: 'A server error occurred while submitting the hack.' });
    }
  };

  const handleGetState = async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });
    try {
      const elapsed = globalRoundState.startTime ? Math.floor((Date.now() - globalRoundState.startTime) / 1000) : 0;
      const timeRemaining = Math.max(0, ROUND_DURATION - elapsed);
      const locked = await prisma.lockedSolution.findMany({ where: { userId }, select: { questionId: true } });
      const lockedQuestionIds = locked.map(l => l.questionId);
      socket.join(`round${ROUND_NUMBER}`);
      callback?.({ success: true, isActive: globalRoundState.isActive, isHackingPhase: globalRoundState.isHackingPhase, timeRemaining, questions: globalRoundState.problems, lockedQuestionIds });
    } catch (err) {
      console.error('[ROUND 3] Error getting state:', err);
      callback?.({ success: false, error: 'Failed to retrieve state.' });
    }
  };
  
  const handleReset = async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });
    try {
      const admin = await prisma.user.findUnique({ where: { id: userId }});
      if (admin?.role !== 'ADMIN') {
        return callback?.({ success: false, error: 'Unauthorized.' });
      }
      await prisma.round.update({ where: { roundNumber: ROUND_NUMBER }, data: { status: 'LOBBY' } });
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
        if(await redis.hget(keys.lobby, userId)) {
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
  socket.on('round3:hackAttempt', handleHackAttempt);
  socket.on('round3:getState', handleGetState);
  socket.on('round3:reset', handleReset);
  socket.on('disconnect', handleDisconnect);

  // Sync state when a new client connects
  syncGlobalStateWithRedis().catch(error => {
    console.error('[ROUND 3] Initial sync failed:', error);
  });
};

// ## EXPORTED FUNCTIONS

export const emitHackResult = (io, result) => {
    const { hackerId, targetId, questionId, status } = result;
    const eventName = status === 'SUCCESSFUL' ? 'round3:hackSuccessful' : 'round3:hackFailed';
    const payload = { questionId, hackerId, targetId, message: `Your hack attempt against user ${targetId} was ${status.toLowerCase()}.` };
    io.to(hackerId).emit(eventName, payload);
    if(status === 'SUCCESSFUL') {
        const victimPayload = { ...payload, message: `Your solution for question ${questionId} was successfully hacked by ${hackerId}!` };
        io.to(targetId).emit('round3:hacked', victimPayload);
    }
};