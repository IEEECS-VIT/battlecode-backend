import redis from "../config/redis.js";
import prisma from "../config/prisma.js";
import { broadcastLeaderboard, broadcastCurrentRound } from "./global.handler.js";

// Time units
const SECOND = 1000;
const MINUTE = 60 * SECOND;

// Game constants (all durations in ms)
const ROUND_DURATION_MS = 60 * MINUTE;        // 1 hour
const ROUND_NUMBER = 1;
const MATCHMAKING_INTERVAL_MS = 3 * MINUTE;
const COOLDOWN_DURATION_MS = 30 * SECOND;
const JANITOR_INTERVAL_MS = 5 * SECOND;
const LOBBY_UPDATE_INTERVAL_MS = 5 * SECOND;
const MATCH_DURATION_MS = {
  R1_HARD: 25 * MINUTE,
  R1_MEDIUM: 20 * MINUTE,
  R1_EASY: 15 * MINUTE,
};

// Global round management variables
let globalTimer = null;
let globalTimerInterval = null;
let matchmakingInterval = null;
let matchmakingCycleInterval = null;
let lobbyBroadcastInterval = null;


const getRedisKeys = () => ({
  participants: `round${ROUND_NUMBER}:participants`,
  readyQueue: `round${ROUND_NUMBER}:readyQueue`,
  matches: `round${ROUND_NUMBER}:matches`,
  status: `round${ROUND_NUMBER}:status`,
  startTime: `round${ROUND_NUMBER}:status:startTime`,
  endTime: `round${ROUND_NUMBER}:status:endTime`,
});

const remainingMs = (endTime) => (endTime ? Math.max(0, endTime - Date.now()) : 0);

const resolveRoundTimes = (startTimeStr, endTimeStr, status) => {
  const startTime = startTimeStr ? parseInt(startTimeStr) : null;
  const endTime = endTimeStr
    ? parseInt(endTimeStr)
    : (startTime ? startTime + ROUND_DURATION_MS : null);
  return {
    startTime,
    endTime,
    timeRemaining: status === "running" ? remainingMs(endTime) : 0,
  };
};

const resolveMatchEndTime = (match) =>
  match.endTime ?? (match.startTime && match.duration ? match.startTime + match.duration : null);

const getEnrichedParticipantsList = async () => {
  const keys = getRedisKeys();
  const [allParticipantsData, allMatchesData] = await Promise.all([
    redis.hgetall(keys.participants),
    redis.hgetall(keys.matches)
  ]);

  if (!allParticipantsData || Object.keys(allParticipantsData).length === 0) {
    return [];
  }

  const participantIds = Object.keys(allParticipantsData);
  const usersFromDb = await prisma.user.findMany({
    where: { id: { in: participantIds } },
    select: { id: true, eventScore: true, username: true },
    orderBy: [{ eventScore: 'desc' }, { username: 'asc' }]
  });

  const scoreMap = new Map(usersFromDb.map(u => [u.id, u.eventScore]));
  const rankMap = new Map(usersFromDb.map((u, i) => [u.id, i + 1]));
  const usernameMap = new Map(usersFromDb.map(u => [u.id, u.username]));

  const opponentMap = new Map();
  Object.values(allMatchesData || {}).forEach(matchStr => {
    try { // NEW: Try/Catch prevents crashes from corrupted JSON
      const match = JSON.parse(matchStr);
      if (match?.players?.length === 2) {
        opponentMap.set(match.players[0], match.players[1]);
        opponentMap.set(match.players[1], match.players[0]);
      }
    } catch (e) {} 
  });

  const participantsList = Object.values(allParticipantsData).map(pStr => {
    try { // NEW: Safety check for participant data
      const p = JSON.parse(pStr);
      p.eventScore = scoreMap.get(p.id) ?? p.eventScore ?? 0;
      p.rank = rankMap.get(p.id) ?? 999;
      p.username = usernameMap.get(p.id) ?? p.username;

      const opponentId = opponentMap.get(p.id);
      if (opponentId) {
        p.opponentUsername = usernameMap.get(opponentId) || opponentId;
      }
      return p;
    } catch (e) { return null; }
  }).filter(Boolean).sort((a, b) => a.rank - b.rank);

  return participantsList;
};

// Maps userId -> { matchId, opponentId } for every player currently in_match,
// so the 1v1 pairing can be attached to participant list payloads (admin dashboard etc).
const getMatchPairingMap = async () => {
  const keys = getRedisKeys();
  const matches = await redis.hgetall(keys.matches);
  const pairing = new Map();

  for (const matchId in matches) {
    const match = JSON.parse(matches[matchId]);
    const [player1Id, player2Id] = match.players;
    if (player1Id) pairing.set(player1Id, { matchId, opponentId: player2Id ?? null });
    if (player2Id) pairing.set(player2Id, { matchId, opponentId: player1Id ?? null });
  }

  return pairing;
};

// Shared participant formatter used by both broadcastLobbyUpdate and
// transformToUnifiedState, so both stay in sync and 1v1 matches surface
// their pairing (matchId/opponentId/opponentUsername) consistently.
const formatParticipant = (p, pairingMap, usernameById) => {
  const formatted = {
    userId: p.id,
    username: p.username,
    email: p.id,
    status: p.status,
    rank: p.rank,
    eventScore: p.eventScore,
    socketId: p.socketId,
    cooldownEndTime: p.cooldownEndTime
  };

  const pairing = pairingMap.get(p.id);
  if (p.status === 'in_match' && pairing) {
    formatted.matchId = pairing.matchId;
    formatted.opponentId = pairing.opponentId;
    formatted.opponentUsername = usernameById.get(pairing.opponentId) ?? null;
  }

  return formatted;
};

const transformToUnifiedState = async (userId, allParticipants, socket = null) => {
  const keys = getRedisKeys();
  const currentUser = allParticipants.find(p => p.id === userId) || null;
  const [currentStatus, startTimeStr, endTimeStr] = await Promise.all([
    redis.get(keys.status),
    redis.get(keys.startTime),
    redis.get(keys.endTime),
  ]);
  const { startTime: roundStartTime, endTime: roundEndTime, timeRemaining: globalTimeRemaining } =
    resolveRoundTimes(startTimeStr, endTimeStr, currentStatus);

  const pairingMap = await getMatchPairingMap();
  const usernameById = new Map(allParticipants.map(p => [p.id, p.username]));

  // Group participants by status
  const byStatus = {
    lobby: [],
    waiting: [],
    in_match: [],
    cooldown: [],
    finished: [],
    disconnected: []
  };

  allParticipants.forEach(p => {
    const status = p.status.replace('-', '_');
    if (byStatus[status]) {
      byStatus[status].push(formatParticipant(p, pairingMap, usernameById));
    }
  });

  // Base state
  const unifiedState = {
    success: true,
    timestamp: Date.now(),
    roundNumber: ROUND_NUMBER,

    round: {
      isActive: currentStatus === "running",
      status: currentStatus === "running" ? "IN_PROGRESS" :
        currentStatus === "ended" ? "COMPLETED" : "LOBBY",
      startTime: roundStartTime,
      endTime: roundEndTime,
      timeRemaining: globalTimeRemaining,
      duration: ROUND_DURATION_MS
    },

    participants: {
      total: allParticipants.length,
      byStatus,
      all: allParticipants.map(p => formatParticipant(p, pairingMap, usernameById))
    },

    currentUser: currentUser ? {
      userId: currentUser.id,
      username: currentUser.username,
      email: currentUser.id,
      status: currentUser.status,
      rank: currentUser.rank,
      eventScore: currentUser.eventScore,
      socketId: currentUser.socketId,
      cooldownEndTime: currentUser.cooldownEndTime
    } : null,

    roundSpecific: {
      nextMatchmakingCycle: null,
      globalTimeRemaining
    }
  };

  // Add matchmaking cycle info
  if (currentStatus === "running" && roundStartTime) {
    const elapsed = Date.now() - roundStartTime;
    const timeIntoCycle = elapsed % MATCHMAKING_INTERVAL_MS;
    unifiedState.roundSpecific.nextMatchmakingCycle =
      MATCHMAKING_INTERVAL_MS - timeIntoCycle;
  }

  // Add session data if in match
  if (currentUser?.status === 'in_match' && socket) {
    const matches = await redis.hgetall(keys.matches);
    for (const matchId in matches) {
      const match = JSON.parse(matches[matchId]);
      if (match.players.includes(userId)) {
        socket.join(`match:${matchId}`);

        const question = await prisma.problem.findUnique({
          where: { id: match.problemId }
        });
        const opponentId = match.players.find(pId => pId !== userId);
        const opponent = opponentId ? allParticipants.find(p => p.id === opponentId) : null;

        const matchEndTime = resolveMatchEndTime(match);
        unifiedState.session = {
          type: 'match',
          id: matchId,
          startTime: match.startTime,
          endTime: matchEndTime,
          timeRemaining: remainingMs(matchEndTime),
          opponent: opponent ? {
            id: opponent.id,
            username: opponent.username,
            rank: opponent.rank
          } : { id: opponentId, username: 'Unknown', rank: 'N/A' },
          problem: question
        };
        break;
      }
    }
  }

  return unifiedState;
};


const broadcastLobbyUpdate = async (io) => {
  try {
    const participantsList = await getEnrichedParticipantsList();
    const keys = getRedisKeys();
    const [currentStatus, startTimeStr, endTimeStr] = await Promise.all([
      redis.get(keys.status),
      redis.get(keys.startTime),
      redis.get(keys.endTime),
    ]);
    const { startTime: roundStartTime, endTime: roundEndTime, timeRemaining: globalTimeRemaining } =
      resolveRoundTimes(startTimeStr, endTimeStr, currentStatus);

    const pairingMap = await getMatchPairingMap();
    const usernameById = new Map(participantsList.map(p => [p.id, p.username]));

    // Group participants by status
    const byStatus = {
      lobby: [],
      waiting: [],
      in_match: [],
      cooldown: [],
      finished: [],
      disconnected: []
    };

    participantsList.forEach(p => {
      const status = (p.status || 'lobby').replace('-', '_');
      if (byStatus[status]) {
        byStatus[status].push(formatParticipant(p, pairingMap, usernameById));
      }
    });

    const lobbyUpdate = {
      success: true,
      timestamp: Date.now(),
      roundNumber: ROUND_NUMBER,
      round: {
        isActive: currentStatus === "running",
        status: currentStatus === "running" ? "IN_PROGRESS" :
          currentStatus === "ended" ? "COMPLETED" : "LOBBY",
        startTime: roundStartTime,
        endTime: roundEndTime,
        timeRemaining: globalTimeRemaining,
        duration: ROUND_DURATION_MS
      },
      participants: {
        total: participantsList.length,
        byStatus,
        all: participantsList.map(p => formatParticipant(p, pairingMap, usernameById))
      }
    };

    io.emit('lobby:round1', lobbyUpdate);
    io.emit('round1:participantsUpdate', lobbyUpdate);
  } catch (error) {
    console.error('[Broadcast Error]', error);
  }
};


let isJanitorStarted = false;
const startJanitor = (io) => {
  if (isJanitorStarted) return;
  isJanitorStarted = true;


  setInterval(async () => {
    try {
      const keys = getRedisKeys();

      const allParticipantsData = await redis.hgetall(keys.participants);
      let hasCooldownUpdates = false;
      for (const userId in allParticipantsData) {
        const participant = JSON.parse(allParticipantsData[userId]);
        if (participant.status === 'cooldown' && Date.now() > participant.cooldownEndTime) {
          console.log(`[Janitor] Cooldown expired for ${userId}. Re-queuing.`);
          participant.status = 'waiting';
          delete participant.cooldownEndTime;
          await redis.hset(keys.participants, userId, JSON.stringify(participant));
          io.to(`user:${userId}`).emit('round1:cooldownEnd');
          hasCooldownUpdates = true;
        }
      }
      if (hasCooldownUpdates) await broadcastLobbyUpdate(io);

    } catch (error) {
      console.error('[Janitor Error]', error);
    }
  }, JANITOR_INTERVAL_MS);
  console.log('[System] Persistent timer janitor started.');
};

export const handleMatchEnd = async (io, matchId, winnerId, force_end = false) => {
  const keys = getRedisKeys();
  const matchStr = await redis.hget(keys.matches, matchId);
  if (!matchStr) return;

  await redis.hdel(keys.matches, matchId);
  const match = JSON.parse(matchStr);

  console.log(`[Match End] Match ${matchId} ended. Winner: ${winnerId || 'Timeout'}.`);

  await prisma.match.update({ where: { id: matchId }, data: { status: 'COMPLETED', winnerId } }).catch(err => console.log(`Prisma update failed for match ${matchId}, might be a bot match.`));

  const playersFromDb = await prisma.user.findMany({
    where: { id: { in: match.players } },
    select: { id: true, eventScore: true }
  });
  const scoreMap = new Map(playersFromDb.map(p => [p.id, p.eventScore]));

  for (const playerId of match.players) {
    const playerStr = await redis.hget(keys.participants, playerId);
    if (!playerStr) continue;

    const player = JSON.parse(playerStr);
    player.status = 'cooldown';
    player.cooldownEndTime = Date.now() + COOLDOWN_DURATION_MS;
    player.eventScore = scoreMap.get(playerId) ?? player.eventScore;

    await redis.hset(keys.participants, playerId, JSON.stringify(player));

    io.to(`user:${playerId}`).emit('round1:matchEnd', { type: force_end ? 'admin_end' : (winnerId ? (playerId === winnerId ? 'win' : 'lose') : 'timeout') });
    io.to(`user:${playerId}`).emit('round1:cooldown', { cooldownEndTime: player.cooldownEndTime });
  }
  await broadcastLeaderboard(io);
};


export const round1RecoveryHandler = async (io, socket, userId) => {
  try {
    socket.join(`user:${userId}`);

    const keys = getRedisKeys();
    const participantStr = await redis.hget(keys.participants, userId);
    if (!participantStr) return;

    let participant = JSON.parse(participantStr);

    // Fix socketId
    if (participant.socketId !== socket.id) {
      participant.socketId = socket.id;
      await redis.hset(keys.participants, userId, JSON.stringify(participant));
    }

    // Cooldown expiry
    if (
      participant.status === 'cooldown' &&
      Date.now() > participant.cooldownEndTime
    ) {
      participant.status = 'waiting';
      delete participant.cooldownEndTime;
      await redis.hset(keys.participants, userId, JSON.stringify(participant));

      socket.emit('round1:cooldownEnd');
      await broadcastLobbyUpdate(io);
    }

    // In_match recovery
    if (participant.status === 'in_match') {
      const matches = await redis.hgetall(keys.matches);

      for (const matchId in matches) {
        const match = JSON.parse(matches[matchId]);
        if (!match.players.includes(userId)) continue;

        socket.join(`match:${matchId}`);

        const question = await prisma.problem.findUnique({
          where: { id: match.problemId }
        });

        const opponentId = match.players.find(id => id !== userId);
        const opponentStr = await redis.hget(keys.participants, opponentId);
        const opponent = opponentStr ? JSON.parse(opponentStr) : null;

        const matchEndTime = resolveMatchEndTime(match);
        socket.emit('round1:matchFound', {
          type: 'match',
          id: matchId,
          startTime: match.startTime,
          endTime: matchEndTime,
          timeRemaining: remainingMs(matchEndTime),
          opponent: {
            id: opponentId,
            username: opponent?.username ?? 'Unknown',
            rank: opponent?.rank ?? 'N/A'
          },
          problem: question
        });

        break;
      }
    }
  } catch (err) {
    console.error('[Round1 Recovery Error]', err);
  }
};


export const handleMatchForfeit = async (io, forfeitingUserId) => {
  const keys = getRedisKeys();

  try {
    // 1️⃣ Find active match involving the user
    const matches = await redis.hgetall(keys.matches);
    let matchId = null;
    let match = null;

    for (const id in matches) {
      const parsed = JSON.parse(matches[id]);
      if (parsed.players.includes(forfeitingUserId)) {
        matchId = id;
        match = parsed;
        break;
      }
    }

    if (!matchId || !match) {
      console.warn(`[Forfeit] No active match found for ${forfeitingUserId}`);
      return;
    }

    // 2️⃣ Identify opponent
    const opponentId = match.players.find(p => p !== forfeitingUserId);
    if (!opponentId) {
      console.warn(`[Forfeit] Opponent missing in match ${matchId}`);
      return;
    }

    console.log(
      `[Forfeit] User ${forfeitingUserId} forfeits match ${matchId}. Winner: ${opponentId}`
    );

    // 3️⃣ Persist match result
    try {
      await prisma.match.update({
        where: { id: matchId },
        data: {
          status: 'COMPLETED',
          winnerId: opponentId,
        },
      });
    } catch (err) {
      console.warn(`[Forfeit] Prisma update failed for match ${matchId}`, err);
    }

    // 4️⃣ Cleanup Redis match state
    await redis.hdel(keys.matches, matchId);

    // 5️⃣ Move both players to cooldown
    for (const playerId of match.players) {
      const participantStr = await redis.hget(keys.participants, playerId);
      if (!participantStr) continue;

      const participant = JSON.parse(participantStr);
      participant.status = 'cooldown';
      participant.cooldownEndTime = Date.now() + COOLDOWN_DURATION_MS;

      await redis.hset(keys.participants, playerId, JSON.stringify(participant));

      io.to(`user:${playerId}`).emit('round1:cooldown', {
        cooldownEndTime: participant.cooldownEndTime,
      });
    }

    // 6️⃣ Notify match room
    io.to(`match:${matchId}`).emit('round1:matchEnd', {
      type: 'forfeit',
      winnerId: opponentId,
      loserId: forfeitingUserId,
    });

    io.to(`user:${opponentId}`).emit('round1:matchEnd', {
      type: 'win',
      reason: 'ADMIN_FORFEIT',
    });

    io.to(`user:${forfeitingUserId}`).emit('round1:matchEnd', {
      type: 'lose',
      reason: 'ADMIN_FORFEIT',
    });
    await broadcastLeaderboard(io);

    // 7️⃣ Update lobby
    await broadcastLobbyUpdate(io);
  } catch (err) {
    console.error('[handleMatchForfeit] Fatal error', err);
  }
};

//ADMIN HANDLERS FOR ROUND 1

export const round1AdminAddUser = async (io, userId, forceAdd = false) => {
  try {
    if (!userId) throw new Error("Invalid user email provided.");

    const keys = getRedisKeys();

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, eventScore: true }
    });

    // FIX: Actually throw an error so the frontend knows it failed!
    if (!user) throw new Error(`User ${userId} not found in database! Double-check for typos.`);

    const roundStatus = await redis.get(keys.status);
    if (roundStatus === "ended") throw new Error("Round already ended.");
    if (!forceAdd && roundStatus === "running") throw new Error("Round is in progress.");

    const existing = await redis.hget(keys.participants, userId);
    if (existing) {
      io.to(`user:${userId}`).emit("round1:adminAdded");
      return; 
    }

    const participant = {
      id: userId,
      socketId: null,
      username: user.username,
      rank: null,
      eventScore: user.eventScore,
      status: roundStatus === "running" ? "waiting" : "lobby"
    };

    await redis.hset(keys.participants, userId, JSON.stringify(participant));
    await broadcastLobbyUpdate(io);

    io.to(`user:${userId}`).emit("round1:adminAdded");
    io.emit("admin:success", { action: "add", userId });

  } catch (err) {
    console.error("[Admin Add User R1]", err);
    // CRITICAL FIX: Re-throw the error so admin.handler.js catches it!
    throw err; 
  }
};

export const round1AdminRemoveUser = async (io, userId) => {
  try {
    const keys = getRedisKeys();

    const participantStr = await redis.hget(keys.participants, userId);
    if (!participantStr) {
      io.emit("admin:error", { error: "User not in round" });
      return;
    }

    const participant = JSON.parse(participantStr);

    // 🔴 If user is in match → forfeit
    if (participant.status === "in_match") {
      await handleMatchForfeit(io, userId);
    }

    await redis.hdel(keys.participants, userId);

    await broadcastLobbyUpdate(io);

    io.to(`user:${userId}`).emit("round1:adminRemoved");
    io.emit("admin:success", { action: "remove", userId });

  } catch (err) {
    console.error("[Admin Remove User R1]", err);
    io.emit("admin:error", { error: "Failed to remove user" });
  }
};

export const endRound1 = async (io) => {
  const keys = getRedisKeys();

  console.log("--- ENDING ROUND 1 ---");

  // stop timers
  if (matchmakingInterval) clearInterval(matchmakingInterval);
  if (globalTimer) clearTimeout(globalTimer);
  if (globalTimerInterval) clearInterval(globalTimerInterval);
  if (matchmakingCycleInterval) clearInterval(matchmakingCycleInterval);

  matchmakingInterval =
    globalTimer =
    globalTimerInterval =
    matchmakingCycleInterval =
    null;

  // end all matches
  const matches = await redis.hgetall(keys.matches);
  for (const matchId in matches) {
    await handleMatchEnd(io, matchId, null, true);
  }

  // reset participants
  const participants = await redis.hgetall(keys.participants);
  for (const id in participants) {
    const p = JSON.parse(participants[id]);
    p.status = "lobby";
    delete p.cooldownEndTime;
    await redis.hset(keys.participants, id, JSON.stringify(p));
  }

  const endedAt = Date.now();
  await redis.set(keys.status, "ended");
  await redis.set(keys.endTime, endedAt);
  await prisma.round.update({
    where: { roundNumber: 1 },
    data: { status: "COMPLETED" },
  });
  await broadcastCurrentRound(io);
  io.emit('round1:ended', { endTime: endedAt });

  await broadcastLobbyUpdate(io);
};

export const round1Handler = (io, socket) => {
  startJanitor(io);

  if (!lobbyBroadcastInterval) {
    lobbyBroadcastInterval = setInterval(() => broadcastLobbyUpdate(io), LOBBY_UPDATE_INTERVAL_MS);
  }

  const validateUser = () => {
    const userId = socket.user?.email;
    if (!userId) return { error: 'Unauthorized' };
    return { userId, email: userId };
  };


  const startMatchmakingCycleBroadcast = (roundStartTime) => {
    if (matchmakingCycleInterval) clearInterval(matchmakingCycleInterval);
    matchmakingCycleInterval = setInterval(() => {
      const elapsed = Date.now() - roundStartTime;
      const timeIntoCycle = elapsed % MATCHMAKING_INTERVAL_MS;
      const nextCycle = MATCHMAKING_INTERVAL_MS - timeIntoCycle;
      io.emit('round1:matchmakingCycle', { nextCycle });
    }, 1000);
  };

  const getUnattemptedQuestionByDifficulty = async (difficulty, player1Id, player2Id) => {
    const submissions = await prisma.submission.findMany({
      where: { userId: { in: [player1Id, player2Id] } },
      distinct: ['problemId'],
      select: { problemId: true }
    });

    const attemptedProblemIds = submissions.map(s => s.problemId);

    const unattemptedProblems = await prisma.problem.findMany({
      where: {
        roundId: 1,
        difficulty: { in: ['R1_HARD', 'R1_MEDIUM', 'R1_EASY'] },
        id: { notIn: attemptedProblemIds }
      }
    });

    if (unattemptedProblems.length > 0) {
      return unattemptedProblems[Math.floor(Math.random() * unattemptedProblems.length)];
    }

    return null;
  };


  const createMatch = async (player1, player2, difficulty) => {
    const question = await getUnattemptedQuestionByDifficulty(difficulty, player1.id, player2.id);

    if (!question) {
      console.error(`No unattempted question for ${difficulty} available. Cannot create match.`);
      // ✅ FIX: Put players back in the 'waiting' queue if a match can't be made.
      const keys = getRedisKeys();
      await redis.hset(keys.participants, player1.id, JSON.stringify({ ...player1, status: 'waiting' }));
      await redis.hset(keys.participants, player2.id, JSON.stringify({ ...player2, status: 'waiting' }));
      return;
    }


    const timerDuration = MATCH_DURATION_MS[difficulty] || MATCH_DURATION_MS.R1_EASY;

    try {
      const newMatch = await prisma.match.create({ data: { playerAId: player1.id, playerBId: player2.id, problemId: question.id, status: 'ONGOING' } });
      const matchId = newMatch.id;
      const startTime = Date.now();
      const endTime = startTime + timerDuration;
      const keys = getRedisKeys();
      const matchDetails = { id: matchId, players: [player1.id, player2.id], problemId: question.id, startTime, endTime, duration: timerDuration, difficulty };


      await redis.multi()
        .hset(keys.matches, matchId, JSON.stringify(matchDetails))
        .hset(keys.participants, player1.id, JSON.stringify({ ...player1, status: 'in_match' }))
        .hset(keys.participants, player2.id, JSON.stringify({ ...player2, status: 'in_match' }))
        .exec();


      const matchRoom = `match:${matchId}`;

      // Create unified session payload for both players
      const sessionPayload1 = {
        type: 'match',
        id: matchId,
        startTime,
        endTime,
        timeRemaining: timerDuration,
        opponent: {
          id: player2.id,
          username: player2.username,
          rank: player2.rank
        },
        problem: question
      };

      const sessionPayload2 = {
        type: 'match',
        id: matchId,
        startTime,
        endTime,
        timeRemaining: timerDuration,
        opponent: {
          id: player1.id,
          username: player1.username,
          rank: player1.rank
        },
        problem: question
      };

      io.to(`user:${player1.id}`).emit('round1:matchFound', sessionPayload1);
      io.to(`user:${player2.id}`).emit('round1:matchFound', sessionPayload2);

      const [socket1] = await io.in(`user:${player1.id}`).allSockets();
      const [socket2] = await io.in(`user:${player2.id}`).allSockets();
      if (socket1) io.sockets.sockets.get(socket1)?.join(matchRoom);
      if (socket2) io.sockets.sockets.get(socket2)?.join(matchRoom);

      const timerInterval = setInterval(async () => {
        const currentMatchStr = await redis.hget(getRedisKeys().matches, matchId);
        if (!currentMatchStr) return clearInterval(timerInterval);
        const currentMatch = JSON.parse(currentMatchStr);

        const matchEndTime = resolveMatchEndTime(currentMatch);
        const timeRemaining = remainingMs(matchEndTime);

        io.to(matchRoom).emit('round1:timerUpdate', { timeRemaining, endTime: matchEndTime });

        if (timeRemaining <= 0) {
          clearInterval(timerInterval);
          handleMatchEnd(io, matchId, null);
        }
      }, 1000);

      console.log(`[Match Created] ${matchId} between ${player1.id} and ${player2.id}`);
    } catch (error) {
      console.error("[Create Match Error]", error);
    }
  };

  const shuffleArray = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  };

  const runMatchmakingCycle = async () => {
    const keys = getRedisKeys();
    const allParticipants = await getEnrichedParticipantsList();

    let waitingPlayers = allParticipants.filter(p => p.status === 'waiting');

    if (waitingPlayers.length < 2) return;

    console.log(`[Matchmaking] Random cycle with ${waitingPlayers.length} players`);

    try {
      const third = Math.ceil(waitingPlayers.length / 3);
      let g1 = waitingPlayers.slice(0, third);
      let g2 = waitingPlayers.slice(third, 2 * third);
      let g3 = waitingPlayers.slice(2 * third);

      if (g1.length % 2 !== 0 && g2.length > 0) g2.unshift(g1.pop());
      if (g2.length % 2 !== 0 && g3.length > 0) g3.unshift(g2.pop());

      const groups = [g1, g2, g3];
      const difficulties = ['R1_HARD', 'R1_MEDIUM', 'R1_EASY'];

      const matchPromises = [];
      groups.forEach((group, index) => {
        for (let i = 0; i < Math.floor(group.length / 2); i++) {
          const player1 = group[i * 2];
          const player2 = group[i * 2 + 1];

          matchPromises.push(createMatch(player1, player2, difficulties[index]));
        }
      });

      await Promise.all(matchPromises);
      await broadcastLobbyUpdate(io);
    } catch (error) {
      console.error("[Matchmaking Error]", error);
    }
  };
  const resetRound1Instance = async () => {
    try {
      console.warn("--- ADMIN: Resetting Round 1 State ---");

      // 1️⃣ Stop timers
      if (matchmakingInterval) clearInterval(matchmakingInterval);
      if (globalTimer) clearTimeout(globalTimer);
      if (globalTimerInterval) clearInterval(globalTimerInterval);
      if (matchmakingCycleInterval) clearInterval(matchmakingCycleInterval);

      matchmakingInterval =
        globalTimer =
        globalTimerInterval =
        matchmakingCycleInterval =
        null;

      // 2️⃣ Delete Redis keys explicitly
      const patterns = [
        "round1:participants",
        "round1:readyQueue",
        "round1:matches",
        "round1:status",
        "round1:status:*",
      ];

      for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        if (keys.length) await redis.del(keys);
      }

      // 3️⃣ Reset DB state
      const problemIds = await prisma.problem.findMany({
        where: { roundId: 1 },
        select: { id: true }
      });

      await prisma.match.deleteMany({
        where: {
          problemId: {
            in: problemIds.map(p => p.id)
          }
        }
      });

      await prisma.round.update({
        where: { roundNumber: 1 },
        data: { status: "LOBBY" },
      });
      await broadcastCurrentRound(io);

      if (lobbyBroadcastInterval) {
        clearInterval(lobbyBroadcastInterval);
        lobbyBroadcastInterval = null;
      }

      console.log("✅ Round 1 state fully reset");
      return true;
    } catch (error) {
      console.error("[Reset Error]", error);
      return false;
    }
  };

  socket.on('round1:join', async (payload, callback) => {
    const { userId, email, error } = validateUser();
    if (error) return callback?.({ success: false, error });


    socket.join(`user:${userId}`);
    const keys = getRedisKeys();


    try {
      if (await redis.hget(keys.participants, userId)) {
        const allParticipants = await getEnrichedParticipantsList();
        const unifiedState = await transformToUnifiedState(userId, allParticipants, socket);
        unifiedState.message = 'Already joined.';
        return callback?.(unifiedState);
      }
      if (await redis.get(keys.status) === 'ended') return callback?.({ success: false, error: 'Round has already ended.' });

      const userData = await prisma.user.findUnique({ where: { id: email } });
      if (!userData) return callback?.({ success: false, error: 'User not found.' });

      const userRank = (await prisma.user.count({ where: { eventScore: { gt: userData.eventScore || 0 } } })) + 1;
      await broadcastLeaderboard(io);

      const newParticipant = {
        id: userId,
        socketId: socket.id,
        username: userData.username,
        rank: userRank,
        eventScore: userData.eventScore,
        status: 'lobby'
      };
      await redis.hset(keys.participants, userId, JSON.stringify(newParticipant));


      await broadcastLobbyUpdate(io);

      const allParticipants = await getEnrichedParticipantsList();
      const unifiedState = await transformToUnifiedState(userId, allParticipants, socket);
      unifiedState.message = 'Successfully joined lobby.';
      callback?.(unifiedState);
    } catch (err) {
      console.error('[Join Error]', err);
      callback?.({ success: false, error: 'Server error during join.' });
    }
  });


  socket.on('round1:ready', async (payload, callback) => {
    const { userId, error } = validateUser();
    if (error) return callback?.({ success: false, error });


    const userData = await prisma.user.findUnique({ where: { id: userId, role: 'ADMIN' } });
    if (!userData) return callback?.({ success: false, error: 'Unauthorized.' });

    const keys = getRedisKeys();
    if (await redis.get(keys.status) === 'running') return callback?.({ success: false, error: 'Round already running.' });


    console.log(`--- ADMIN (${userId}): Round 1 starting! ---`);
    const roundStartTime = Date.now();
    const roundEndTime = roundStartTime + ROUND_DURATION_MS;
    await redis.set(keys.status, "running");
    await redis.set(keys.startTime, roundStartTime);
    await redis.set(keys.endTime, roundEndTime);
    await prisma.round.update({ where: { roundNumber: ROUND_NUMBER }, data: { status: 'IN_PROGRESS' } });
    await broadcastCurrentRound(io);

    const participants = await redis.hgetall(keys.participants);
    const multi = redis.multi();
    Object.values(participants).forEach(pStr => {
      const p = JSON.parse(pStr);
      if (p.status === 'lobby') {
        p.status = 'waiting';
        multi.hset(keys.participants, p.id, JSON.stringify(p));
      }
    });
    await multi.exec();


    globalTimer = setTimeout(() => endRound1(io), ROUND_DURATION_MS);
    if (globalTimerInterval) clearInterval(globalTimerInterval);
    globalTimerInterval = setInterval(() => {
      const remaining = remainingMs(roundEndTime);
      io.emit('round1:globalTimer', { timeRemaining: remaining, endTime: roundEndTime });
      if (remaining <= 0) clearInterval(globalTimerInterval);
    }, 1000);


    matchmakingInterval = setInterval(runMatchmakingCycle, MATCHMAKING_INTERVAL_MS);
    startMatchmakingCycleBroadcast(roundStartTime);
    runMatchmakingCycle();

    const startPayload = {
      success: true,
      timestamp: Date.now(),
      roundNumber: ROUND_NUMBER,
      round: {
        isActive: true,
        status: 'IN_PROGRESS',
        startTime: roundStartTime,
        endTime: roundEndTime,
        timeRemaining: ROUND_DURATION_MS,
        duration: ROUND_DURATION_MS
      }
    };

    io.emit('round1:started', startPayload);
    await broadcastLobbyUpdate(io);
    callback?.({ success: true, message: 'Round 1 started.' });
  });


  socket.on('disconnect', async () => {
    const { userId, error } = validateUser();
    if (error) return;

    const participantStr = await redis.hget(getRedisKeys().participants, userId);
    if (!participantStr) return;

    const participant = JSON.parse(participantStr);
    console.log(`[Disconnect] User ${userId} disconnected with status: ${participant.status}. State is preserved in Redis.`);
  });


  socket.on('round1:getState', async (payload) => {
    const { userId, error } = validateUser();
    if (error) return;

    socket.join(`user:${userId}`);

    try {
      const keys = getRedisKeys();
      const allParticipants = await getEnrichedParticipantsList();
      let participant = allParticipants.find(p => p.id === userId) || null;

      if (!participant) {
        const unifiedState = await transformToUnifiedState(userId, allParticipants, socket);
        socket.emit("round1:state", unifiedState);
        return;
      }


      if (participant.status === 'cooldown' && Date.now() > participant.cooldownEndTime) {
        console.log(`[GetState] Cooldown for ${userId} expired. Updating status.`);
        participant.status = 'waiting';
        delete participant.cooldownEndTime;

        const redisParticipantStr = await redis.hget(keys.participants, userId);
        if (redisParticipantStr) {
          const redisParticipant = JSON.parse(redisParticipantStr);
          redisParticipant.status = 'waiting';
          delete redisParticipant.cooldownEndTime;
          await redis.hset(keys.participants, userId, JSON.stringify(redisParticipant));

          socket.emit('round1:cooldownEnd');
          await broadcastLobbyUpdate(io);
        }
      }

      if (participant.socketId !== socket.id) {
        const redisParticipantStr = await redis.hget(keys.participants, userId);
        if (redisParticipantStr) {
          const redisParticipant = JSON.parse(redisParticipantStr);
          redisParticipant.socketId = socket.id;
          await redis.hset(keys.participants, userId, JSON.stringify(redisParticipant));
          participant.socketId = socket.id;
        }
      }

      // Generate unified state with session data if in match
      const unifiedState = await transformToUnifiedState(userId, allParticipants, socket);
      socket.emit("round1:state", unifiedState);
    } catch (err) {
      console.error('[GetState Error]', err);
      socket.emit("round1:state", { success: false, error: 'Failed to fetch state.' });
    }
  });



  //     socket.on('round1:reset', async (payload) => {
  //         const { userId, error } = validateUser();
  //         if (error){
  //             socket.emit('user not found'); 
  //             return;
  //         } 

  //         const userData = await prisma.user.findUnique({ where: { id: userId, role: 'ADMIN' } });
  //         if (!userData){
  //             socket.emit('unauthorized'); 
  //             return;
  //         } 
  // ;

  //         if (await resetRound1Instance()) {
  //             io.emit('round1:reset');
  //             socket.emit('round1:reset:success');
  //         } else {
  //             socket.emit('failed to reset round');
  //             return;
  //         }
  //     });
};


export const handleRound1Violation = async (io, userId) => {

  try {
    const keys = getRedisKeys();

    // 1️⃣ Find active match
    const matches = await redis.hgetall(keys.matches);

    let matchId = null;
    let match = null;

    for (const id in matches) {
      const parsed = JSON.parse(matches[id]);
      if (parsed.players.includes(userId)) {
        matchId = id;
        match = parsed;
        break;
      }
    }

    if (!matchId || !match) {
      console.warn(`[Violation] No active match for ${userId}`);
      return;
    }

    // 2️⃣ Identify opponent
    const opponentId = match.players.find(p => p !== userId);
    if (!opponentId) return;

    console.warn(
      `[Violation] User ${userId} exceeded violation limit. Forfeiting match ${matchId}`
    );

    const matchStr = await redis.hget(keys.matches, matchId);
    if (!matchStr) return;


    // 3️⃣ End match using EXISTING logic
    await handleMatchEnd(io, matchId, opponentId);

    io.to(`user:${userId}`).emit("round1:violationForfeit");
    io.to(`user:${opponentId}`).emit("round1:opponentViolated");

  } catch (err) {
    console.error("[Violation Handler Error]", err);
  }
};
