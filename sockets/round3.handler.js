import redis from "../config/redis.js";
import prisma from "../config/prisma.js";
import { getCurrentRound } from "./global.handler.js";
import { HackStatus, SubmissionStatus } from '@prisma/client';

/**
 * ROUND 3 SOCKET HANDLER
 * Manages the real-time state and events for Round 3 of the competition.
 */

const MINUTE = 60;
// Round 3 (seconds-based)
const ROUND_DURATION = 90 * MINUTE;                  // 5400s = 1.5 hrs
const HACKING_PHASE_START_AFTER_SECONDS = 30 * MINUTE; // 1800s = 30 mins

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
    await redis.del(keys.lobby, keys.state, keys.timer, keys.problems);
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
      const lobbyParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
        userId: uid,
        ...JSON.parse(value)
      }));

      // Get round status from database
      const round3DB = await prisma.round.findUnique({
        where: { roundNumber: ROUND_NUMBER }
      });

      // Calculate timeRemaining
      let timeRemaining = 0;
      if (globalRoundState.isActive && globalRoundState.startTime) {
        const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
        timeRemaining = Math.max(ROUND_DURATION - elapsed, 0);
      }

      // Group participants by status
      const byStatus = {
        lobby: lobbyParticipants.filter(p => (p.status || 'lobby').toLowerCase() === 'lobby'),
        waiting: lobbyParticipants.filter(p => (p.status || '').toLowerCase() === 'waiting'),
        in_match: lobbyParticipants.filter(p => (p.status || '').toLowerCase() === 'in_match'),
        cooldown: lobbyParticipants.filter(p => (p.status || '').toLowerCase() === 'cooldown'),
        finished: lobbyParticipants.filter(p => (p.status || '').toLowerCase() === 'finished'),
        disconnected: lobbyParticipants.filter(p => (p.status || '').toLowerCase() === 'disconnected')
      };

      io.to(`round${ROUND_NUMBER}`).emit('lobby:round3', {
        success: true,
        timestamp: Date.now(),
        roundNumber: ROUND_NUMBER,

        round: {
          isActive: globalRoundState.isActive,
          status: round3DB?.status || 'LOBBY',
          startTime: globalRoundState.startTime,
          endTime: globalRoundState.startTime ? globalRoundState.startTime + (ROUND_DURATION * 1000) : null,
          timeRemaining,
          duration: ROUND_DURATION
        },

        participants: {
          total: lobbyParticipants.length,
          byStatus,
          all: lobbyParticipants
        },

        roundSpecific: {
          isHackingPhase: globalRoundState.isHackingPhase
        }
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

        if (
          elapsed >= HACKING_PHASE_START_AFTER_SECONDS &&
          !globalRoundState.isHackingPhase
        ) {
          globalRoundState.isHackingPhase = true;

          console.log('[ROUND 3] Hacking phase has started!');
          io.to(`round${ROUND_NUMBER}`).emit('round3:hackingPhaseStart', {
            message: 'Hacking phase has begun!',
            elapsed,
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
            globalRoundState.isHackingPhase = elapsed >= HACKING_PHASE_START_AFTER_SECONDS;
            startGlobalTimer(io);
            console.log('[ROUND 3] Synced active round state from Redis.');
          } else {
            await prisma.round.update({ where: { roundNumber: ROUND_NUMBER }, data: { status: 'COMPLETED' } });
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
      const roundDB = await prisma.round.findUnique({ where: { roundNumber: ROUND_NUMBER } });
      if (roundDB?.status !== 'LOBBY') {
        return callback?.({ success: false, error: `Round is not in lobby state. Current: ${roundDB?.status}` });
      }
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          qualifiedForR3: true
        }
      });

      if (!user?.qualifiedForR3) {
        return callback?.({
          success: false,
          error: "You are not qualified for Round 3"
        });
      }
      if (!user) return callback?.({ success: false, error: 'User not found.' });
      const participantData = { userId: user.id, username: user.username, status: 'lobby' }; // lowercase for Redis
      const exists = await redis.hget(getRedisKeys().lobby, userId);
      if (exists) {
        return callback?.({ success: true, message: 'Already in lobby' });
      }
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
      const keys = getRedisKeys();

      // Update all participants to 'in_match' status
      const allParticipantsRaw = await redis.hgetall(keys.lobby);
      const updatePromises = [];

      for (const [uid, dataStr] of Object.entries(allParticipantsRaw)) {
        const participantData = JSON.parse(dataStr);
        participantData.status = 'in_match'; // Update status to in_match
        updatePromises.push(redis.hset(keys.lobby, uid, JSON.stringify(participantData)));
      }

      await Promise.all(updatePromises);

      const redisPipeline = redis.pipeline();
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

      // Broadcast updated lobby state with participants now in 'in_match'
      await broadcastLobbyUpdate();

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
      const acceptedSubmission = await prisma.submission.findFirst({
        where: {
          userId,
          problemId: questionId,
          roundId: ROUND_NUMBER,
          status: SubmissionStatus.ACCEPTED
        },
      });
      if (!acceptedSubmission) {
        return callback?.({ success: false, error: 'You must have an accepted solution to lock this question.' });
      }
      const existingLock = await prisma.lockedSolution.findUnique({
        where: { userId_questionId: { userId, questionId } },
      });

      // Always update the user's submission status from ACCEPTED to LOCKED
      await prisma.submission.updateMany({
        where: {
          userId,
          problemId: questionId,
          roundId: ROUND_NUMBER,
          status: SubmissionStatus.ACCEPTED
        },
        data: { status: SubmissionStatus.LOCKED }
      });

      if (!existingLock) {
        await prisma.lockedSolution.create({ data: { userId, questionId } });
      }

      // Fetch other users' LOCKED submissions (not ACCEPTED)
      const otherSubmissions = await prisma.submission.findMany({
        where: {
          problemId: questionId,
          status: SubmissionStatus.LOCKED,
          NOT: { userId: userId }
        },
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

  const handleGetLockedSubmissions = async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });

    const { questionId } = payload;
    if (!questionId) return callback?.({ success: false, error: 'Question ID is required.' });

    try {
      // Verify user has locked this question
      const userLock = await prisma.lockedSolution.findUnique({
        where: { userId_questionId: { userId, questionId } },
      });

      if (!userLock) {
        return callback?.({ success: false, error: 'You have not locked this question.' });
      }

      // Fetch ALL LOCKED submissions from other users
      const otherSubmissions = await prisma.submission.findMany({
        where: {
          problemId: questionId,
          roundId: ROUND_NUMBER,
          status: SubmissionStatus.LOCKED,
          NOT: { userId: userId }
        },
        orderBy: { createdAt: 'desc' },
        distinct: ['userId'],
        select: {
          userId: true,
          code: true,
          language: true,
          user: { select: { username: true } }
        }
      });

      callback?.({
        success: true,
        questionId,
        submissions: otherSubmissions
      });

    } catch (err) {
      console.error(`[ROUND 3] Error fetching locked submissions for question ${questionId}:`, err);
      callback?.({ success: false, error: 'Server error while fetching submissions.' });
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

  const handleGetState = async (payload) => {
    try {
      const validation = validateUser();
      if (validation.error) {
        socket.emit('round3:state', {
          success: false,
          error: validation.error,
          timestamp: Date.now(),
          roundNumber: ROUND_NUMBER,
          round: {
            isActive: false,
            status: 'LOBBY',
            startTime: null,
            endTime: null,
            timeRemaining: 0,
            duration: ROUND_DURATION
          },
          participants: {
            total: 0,
            byStatus: {
              lobby: [],
              waiting: [],
              in_match: [],
              cooldown: [],
              finished: [],
              disconnected: []
            },
            all: []
          },
          currentUser: null
        });
        return;
      }
      const { userId } = validation;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { qualifiedForR3: true }
      });

      if (!user?.qualifiedForR3) {
        socket.emit('round3:state', {
          success: false,
          error: 'You are not qualified for Round 3'
        });
        return;
      }

      // Join socket rooms
      socket.join(`round${ROUND_NUMBER}`);
      socket.join(`user:${userId}`);

      // Check database status first
      const round3DB = await prisma.round.findUnique({
        where: { roundNumber: ROUND_NUMBER }
      });

      if (!round3DB) {
        socket.emit('round3:state', {
          success: false,
          error: 'Round 3 not found in database',
          timestamp: Date.now(),
          roundNumber: ROUND_NUMBER,
          round: {
            isActive: false,
            status: 'LOBBY',
            startTime: null,
            endTime: null,
            timeRemaining: 0,
            duration: ROUND_DURATION
          },
          participants: {
            total: 0,
            byStatus: {
              lobby: [],
              waiting: [],
              in_match: [],
              cooldown: [],
              finished: [],
              disconnected: []
            },
            all: []
          },
          currentUser: null
        });
        return;
      }

      const keys = getRedisKeys();

      // Always get lobby participants
      const allParticipantsRaw = await redis.hgetall(keys.lobby);
      const allParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
        userId: uid,
        ...JSON.parse(value)
      }));

      // Find current user's participant data
      const participant = allParticipants.find(p => p.userId === userId) || null;

      // Calculate timeRemaining
      let timeRemaining = 0;
      if (globalRoundState.isActive && globalRoundState.startTime) {
        const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
        timeRemaining = Math.max(ROUND_DURATION - elapsed, 0);
      }

      // Group participants by status
      const byStatus = {
        lobby: allParticipants.filter(p => (p.status || 'lobby').toLowerCase() === 'lobby'),
        waiting: allParticipants.filter(p => (p.status || '').toLowerCase() === 'waiting'),
        in_match: allParticipants.filter(p => (p.status || '').toLowerCase() === 'in_match'),
        cooldown: allParticipants.filter(p => (p.status || '').toLowerCase() === 'cooldown'),
        finished: allParticipants.filter(p => (p.status || '').toLowerCase() === 'finished'),
        disconnected: allParticipants.filter(p => (p.status || '').toLowerCase() === 'disconnected')
      };

      // Sync in-memory state with database if needed
      if (!globalRoundState.isActive && round3DB.status === 'IN_PROGRESS') {
        console.log('[ROUND 3] Database shows IN_PROGRESS but in-memory state shows inactive. Syncing...');
        await syncGlobalStateWithRedis();

        // Recalculate timeRemaining after sync
        if (globalRoundState.isActive && globalRoundState.startTime) {
          const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
          timeRemaining = Math.max(ROUND_DURATION - elapsed, 0);
        }
      }

      // Get user's locked questions
      const locked = await prisma.lockedSolution.findMany({
        where: { userId },
        select: { questionId: true }
      });
      const lockedQuestionIds = locked.map(l => l.questionId);

      // Base unified state response
      const unifiedState = {
        success: true,
        timestamp: Date.now(),
        roundNumber: ROUND_NUMBER,

        round: {
          isActive: globalRoundState.isActive,
          status: round3DB.status,
          startTime: globalRoundState.startTime,
          endTime: globalRoundState.startTime ? globalRoundState.startTime + (ROUND_DURATION * 1000) : null,
          timeRemaining,
          duration: ROUND_DURATION
        },

        participants: {
          total: allParticipants.length,
          byStatus,
          all: allParticipants
        },

        currentUser: participant,

        roundSpecific: {
          lockedQuestionIds,
          questions: globalRoundState.problems,
          isHackingPhase: globalRoundState.isHackingPhase
        },

        message: round3DB.status === 'LOBBY'
          ? 'Round not started yet'
          : round3DB.status === 'COMPLETED'
            ? 'Round ended'
            : globalRoundState.isHackingPhase
              ? 'Hacking phase active'
              : 'Round in progress'
      };

      socket.emit('round3:state', unifiedState);

    } catch (err) {
      console.error('[ROUND 3] Error getting state:', err);
      socket.emit('round3:state', {
        success: false,
        error: 'Failed to retrieve state.',
        timestamp: Date.now(),
        roundNumber: ROUND_NUMBER,
        round: {
          isActive: false,
          status: 'LOBBY',
          startTime: null,
          endTime: null,
          timeRemaining: 0,
          duration: ROUND_DURATION
        },
        participants: {
          total: 0,
          byStatus: {
            lobby: [],
            waiting: [],
            in_match: [],
            cooldown: [],
            finished: [],
            disconnected: []
          },
          all: []
        },
        currentUser: null
      });
    }
  };

  const handleReset = async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });
    try {
      const admin = await prisma.user.findUnique({ where: { id: userId } });
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
      if (await redis.hget(keys.lobby, userId)) {
        await redis.hdel(keys.lobby, userId);
        await broadcastLobbyUpdate();
        console.log(`[ROUND 3] User ${userId} disconnected and was removed from the lobby.`);
      }
    } catch (err) {
      console.error(`[ROUND 3] Error during disconnect for user ${userId}:`, err);
    }
  };

  // ## EVENT LISTENERS

  socket.on('round3:join', handleJoinLobby);
  socket.on('round3:ready', handleAdminReady);
  socket.on('round3:lockQuestion', handleLockQuestion);
  socket.on('round3:getLockedSubmissions', handleGetLockedSubmissions);
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
  if (status === 'SUCCESSFUL') {
    const victimPayload = { ...payload, message: `Your solution for question ${questionId} was successfully hacked by ${hackerId}!` };
    io.to(targetId).emit('round3:hacked', victimPayload);
  }
};

// Admin functions
export const round3AdminAddUser = async (io, userId, forceAdd = false) => {
  try {
    if (!userId) {
      io.emit("admin:error", { error: "Invalid user email" });
      return;
    }

    const keys = getRedisKeys();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        qualifiedForR3: true
      }
    });

    if (!user?.qualifiedForR3) {
      io.to(`user:${userId}`).emit("round3:notQualified");
      io.emit("admin:error", { error: "User is not qualified for Round 3" });
      return;
    }

    if (!user) {
      io.emit("admin:error", { error: "User not found" });
      return;
    }

    const roundDB = await prisma.round.findUnique({
      where: { roundNumber: ROUND_NUMBER }
    });

    if (!roundDB) {
      io.emit("admin:error", { error: `Round ${ROUND_NUMBER} not found` });
      return;
    }

    if (roundDB.status === "COMPLETED") {
      io.emit("admin:error", { error: "Round already ended" });
      return;
    }

    // Only check IN_PROGRESS status if not forcing the add
    if (!forceAdd && roundDB.status === "IN_PROGRESS") {
      io.emit("admin:error", { error: "Round is in progress" });
      return;
    }

    const existing = await redis.hget(keys.lobby, userId);
    if (existing) {
      io.to(`user:${userId}`).emit(`round${ROUND_NUMBER}:adminAdded`);
      return;
    }

    const participant = {
      userId,
      username: user.username,
      email: userId,
      eventScore: user.eventScore,
      status: roundDB.status === 'IN_PROGRESS' ? 'waiting' : 'lobby',
      joinedAt: new Date().toISOString()
    };

    await redis.hset(keys.lobby, userId, JSON.stringify(participant));
    await broadcastLobbyUpdate();
    io.to(`user:${userId}`).emit("round3:state", {
      success: true,
      roundNumber: 3,
      round: {
        number: 3,
        status: roundDB.status,
        isActive: roundDB.status === "IN_PROGRESS",
      },
      currentUser: {
        id: userId,
        role: null,
        status: participant.status,
        activeSession: false,
      },
    });

    io.to(`user:${userId}`).emit(`round${ROUND_NUMBER}:adminAdded`);
    io.emit("admin:success", { action: "add", userId, round: ROUND_NUMBER });

  } catch (err) {
    console.error(`[Admin Add User R${ROUND_NUMBER}]`, err);
    io.emit("admin:error", { error: "Failed to add user" });
  }
};

export const round3AdminRemoveUser = async (io, userId) => {
  try {
    const keys = getRedisKeys();
    const participantStr = await redis.hget(keys.lobby, userId);

    if (!participantStr) {
      io.emit("admin:error", { error: "User not in round" });
      return;
    }

    // Clean up user data
    await redis.hdel(keys.lobby, userId);

    // Delete user-specific submissions and hack data if needed
    const userStateKey = `round${ROUND_NUMBER}:user:${userId}:state`;
    await redis.del(userStateKey);

    io.to(`user:${userId}`).emit(`round${ROUND_NUMBER}:adminRemoved`);

    // Get updated participants and broadcast to all
    const allParticipantsStr = await redis.hgetall(keys.lobby);
    const allParticipants = Object.values(allParticipantsStr).map(p => JSON.parse(p));
    const isRoundActive = allParticipants.length > 0;

    io.emit('lobby:round3', {
      participants: allParticipants
    });

    io.emit("admin:success", { action: "remove", userId, round: ROUND_NUMBER });

  } catch (err) {
    console.error(`[Admin Remove User R${ROUND_NUMBER}]`, err);
    io.emit("admin:error", { error: "Failed to remove user" });
  }
};

export const endRound3 = async (io) => {
  console.log('--- ENDING ROUND 3 ---');

  const keys = getRedisKeys();

  try {
    // 1️⃣ Stop timer safely
    if (globalRoundState.timerInterval) {
      clearInterval(globalRoundState.timerInterval);
      globalRoundState.timerInterval = null;
    }

    // 2️⃣ Mark round as completed in DB
    await prisma.round.update({
      where: { roundNumber: ROUND_NUMBER },
      data: { status: 'COMPLETED' },
    });

    // 3️⃣ Update Redis round state
    await redis.set(keys.state, 'COMPLETED');

    // 4️⃣ Update participants in lobby (optional but good hygiene)
    const allParticipantsRaw = await redis.hgetall(keys.lobby);
    for (const userId in allParticipantsRaw) {
      const participant = JSON.parse(allParticipantsRaw[userId]);
      participant.status = 'finished'; // lowercase for Redis
      participant.finishedAt = new Date().toISOString();
      await redis.hset(keys.lobby, userId, JSON.stringify(participant));
    }

    // 5️⃣ Notify players
    io.to(`round${ROUND_NUMBER}`).emit('round3:ended', {
      message: 'Round 3 has ended!',
    });

    // 6️⃣ Reset in-memory state (DO NOT wipe hack data here)
    initializeGlobalState();

    // 7️⃣ 🔥 Notify admin dashboard (THIS IS CRITICAL)
    const currentRound = await getCurrentRound();
    io.emit('server:currentRound', currentRound);

    console.log('[ROUND 3] Round ended successfully.');
  } catch (error) {
    console.error('[ROUND 3] Error ending round:', error);
    throw error;
  }
};

export const handleRound3Violation = async (io, userId) => {


  try {
    const keys = getRedisKeys();

    console.warn(`[ROUND 3 VIOLATION] User ${userId} violated rules`);

    // 1️⃣ Update participant status in lobby
    const participantRaw = await redis.hget(keys.lobby, userId);
    if (participantRaw) {
      const participant = JSON.parse(participantRaw);
      participant.status = 'finished';
      participant.violation = true;
      participant.finishedAt = new Date().toISOString();
      await redis.hset(keys.lobby, userId, JSON.stringify(participant));
    }


    // 4️⃣ Notify the user
    io.to(`user:${userId}`).emit('round3:violation', {
      success: false,
      message: 'You have been disqualified from Round 3 due to rule violations.'
    });
    socket.leave(`round${ROUND_NUMBER}`);

    // 5️⃣ Broadcast lobby update
    await broadcastLobbyUpdate();

    console.log(`[ROUND 3] User ${userId} disqualified successfully`);

  } catch (err) {
    console.error('[ROUND 3] Error handling violation:', err);
  }
};

