import redis from "../config/redis.js";
import prisma from "../config/prisma.js";

// --- Constants ---
const ROUND_DURATION_MS = 20 * 60 * 1000;
const MATCH_DURATION_MS = 20 * 60 * 1000;
const COOLDOWN_DURATION_S = 30;
const CHALLENGE_REQUEST_EXPIRY_S = 60;
const ROLE_THRESHOLD_SCORE = 500;
const ACTION_LOCK_MS = 1 * 60 * 1000;
const DISCONNECT_GRACE_PERIOD_MS = 15000; // 15 seconds

// --- Module-Scoped Variables ---
let round2IO = null;
let matchEndHandler = null;
let bountyEndHandler = null;
let lobbyUpdateInterval = null;
let dashboardUpdateInterval = null;
const requestTimeouts = new Map();
const disconnectTimeouts = new Map();

// --- Helper Functions ---
const getRedisKeys = (userId = '', questionId = '', matchId = '') => ({
    participants: "round2:participants",
    roundStarted: "round2:started",
    roundEndTime: "round2:endTime",
    elites: "round2:elites",
    challengers: "round2:challengers",
    role: (id = userId) => `round2:role:${id}`,
    cooldown: (id = userId) => `round2:cooldown:${id}`,
    bountySession: (uid = userId, qid = questionId) => `round2:bounty:${uid}:${qid}`,
    activeBounty: (id = userId) => `round2:activeBounty:${id}`,
    challengeRequest: (challengerId, eliteId) => `round2:request:${challengerId}:${eliteId}`,
    pendingRequests: (id = eliteId) => `round2:pending:${id}`,
    outgoingRequests: (id = challengerId) => `round2:outgoing:${id}`,
    matchInfo: (id = matchId) => `round2:match:${id}`,
    userMatch: (id = userId) => `round2:userMatch:${id}`,
    rejectCount: (id = userId) => `round2:rejects:${id}`,
    solvedBounties: () => "round2:solvedBounties",
    attemptedBounties: (id = userId) => `round2:attempted:${id}`,
});

const updatePlayerRole = async (userId) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { eventScore: true, round2Role: true }});
        if (!user) throw new Error(`User ${userId} not found in DB for role update.`);

        const newRole = user.eventScore > ROLE_THRESHOLD_SCORE ? "elite" : "challenger";
        const newDbRole = newRole.toUpperCase();

        if (user.round2Role !== newDbRole) {
            await prisma.user.update({
                where: { id: userId },
                data: { round2Role: newDbRole }
            });
        }

        const keys = getRedisKeys();
        const participantStr = await redis.hget(keys.participants, userId);
        if (participantStr) {
            const participant = JSON.parse(participantStr);
            const oldRole = participant.role;

            if (oldRole !== newRole) {
                participant.role = newRole;
                if (participant.status.includes(oldRole)) {
                    participant.status = participant.status.replace(oldRole, newRole);
                }

                const multi = redis.multi()
                    .hset(keys.participants, userId, JSON.stringify(participant))
                    .set(keys.role(userId), newRole);

                if (newRole === 'elite') {
                    multi.srem(keys.challengers, userId).sadd(keys.elites, userId);
                } else {
                    multi.srem(keys.elites, userId).sadd(keys.challengers, userId);
                }
                await multi.exec();

                if (round2IO) {
                    round2IO.to(`user:${userId}`).emit("round2:roleUpdate", { userId, newRole });
                }
                console.log(`Role for ${userId} updated from ${oldRole} to ${newRole}`);
            }
        }
        return { userId, newRole };
    } catch (err) {
        console.error(`Failed to update role for user ${userId}:`, err);
        return { userId, newRole: null };
    }
};

const broadcastLobbyUpdate = async () => {
  if (!round2IO) return;
  try {
    const keys = getRedisKeys();
    const [participantsData, roundStarted, endTimeStr, roundStatus] = await Promise.all([
      redis.hgetall(keys.participants),
      redis.get(keys.roundStarted),
      redis.get(keys.roundEndTime),
      prisma.round.findUnique({ where: { roundNumber: 2 }, select: { status: true } })
    ]);
    
    const participantsList = Object.values(participantsData || {}).map(p => JSON.parse(p));
    const isActive = !!roundStarted;
    const endTime = endTimeStr ? parseInt(endTimeStr) : null;
    const timeRemaining = endTime ? Math.max(0, endTime - Date.now()) : 0;
    const startTime = endTime ? endTime - ROUND_DURATION_MS : null;
    
    // Determine status
    let status = 'LOBBY';
    if (roundStatus?.status) {
      status = roundStatus.status;
    } else if (isActive) {
      status = 'IN_PROGRESS';
    }
    
    // Categorize participants
    const byStatus = {
      lobby: [],
      waiting: [],
      in_match: [],
      in_bounty: [],
      finished: [],
      disconnected: [],
      cooldown: []
    };

    for (const p of participantsList) {
      const statusKey = p.status ? p.status.toLowerCase() : 'lobby';
      
      if (statusKey.includes('idle')) {
        byStatus.waiting.push(p);
      } else if (statusKey.includes('match')) {
        byStatus.in_match.push(p);
      } else if (statusKey.includes('bounty')) {
        byStatus.in_bounty.push(p);
      } else if (statusKey.includes('cooldown')) {
        byStatus.cooldown.push(p);
      } else if (statusKey.includes('finished') || statusKey.includes('completed')) {
        byStatus.finished.push(p);
      } else if (statusKey.includes('disconnected')) {
        byStatus.disconnected.push(p);
      } else {
        byStatus.lobby.push(p);
      }
    }
    
    round2IO.to('round2_lobby').emit("round2:lobby", {
      success: true,
      timestamp: Date.now(),
      roundNumber: 2,
      round: {
        isActive,
        status,
        startTime,
        endTime,
        timeRemaining,
        duration: ROUND_DURATION_MS
      },
      participants: {
        total: participantsList.length,
        byStatus,
        all: participantsList
      },
      // Legacy fields for backward compatibility
      isRoundActive: isActive,
      participantCount: participantsList.length
    });
  } catch (err) {
    console.error("Error broadcasting R2 lobby state:", err);
  }
};

const broadcastDashboardUpdates = async () => {
    if (!round2IO) return;
    try {
        const keys = getRedisKeys();
        const isRoundActive = await redis.get(keys.roundStarted);
        if (!isRoundActive) return;

        const participantsData = await redis.hgetall(keys.participants);
        const participantsList = Object.values(participantsData).map(p => JSON.parse(p));
        const participantMap = new Map(participantsList.map(p => [p.id, p]));

        for (const participant of participantsList) {
            const userSocket = round2IO.to(`user:${participant.id}`);

            if (participant.role === 'elite' && participant.status === 'elite:idle') {
                const requestIds = await redis.smembers(keys.pendingRequests(participant.id));
                const requestPromises = requestIds.map(async (challengerId) => {
                    const challenger = participantMap.get(challengerId);
                    if (!challenger) return null;
                    const requestKey = keys.challengeRequest(challengerId, participant.id);
                    const ttl = await redis.ttl(requestKey);
                    if (ttl <= 0) {
                        await redis.multi()
                            .del(requestKey)
                            .srem(keys.pendingRequests(participant.id), challengerId)
                            .srem(keys.outgoingRequests(challengerId), participant.id)
                            .exec();
                        return null;
                    }
                    return { ...challenger, expiresAt: Date.now() + ttl * 1000 };
                });
                const incomingRequests = (await Promise.all(requestPromises)).filter(Boolean);
                userSocket.emit('round2:dashboardUpdate', { incomingRequests });
            }
            else if (participant.role === 'challenger' && participant.status === 'challenger:idle') {
                const outgoingRequestEliteIds = await redis.smembers(keys.outgoingRequests(participant.id));
                const validOutgoing = [];
                for (const eliteId of outgoingRequestEliteIds) {
                    if (await redis.exists(keys.challengeRequest(participant.id, eliteId))) {
                        validOutgoing.push(eliteId);
                    }
                }
                userSocket.emit('round2:dashboardUpdate', { pendingRequests: validOutgoing });
            }
        }
    } catch (err) {
        console.error("Error in broadcastDashboardUpdates:", err);
    }
};


export const round2Handler = (io, socket) => {
  if (!round2IO) {
      round2IO = io;
      if (!lobbyUpdateInterval) {
        lobbyUpdateInterval = setInterval(broadcastLobbyUpdate, 2000);
        console.log("✅ Round 2 Lobby State Broadcaster Started.");
      }
      if (!dashboardUpdateInterval) {
        dashboardUpdateInterval = setInterval(broadcastDashboardUpdates, 2000);
        console.log("✅ Round 2 Dashboard State Broadcaster Started.");
      }
  }

  const keys = getRedisKeys();
  const userId = socket.user?.email;
  if (userId) {
      socket.join(`user:${userId}`);
      socket.join('round2_lobby');
      if (disconnectTimeouts.has(userId)) {
          clearTimeout(disconnectTimeouts.get(userId));
          disconnectTimeouts.delete(userId);
          console.log(`[Socket.IO] User ${userId} reconnected, disconnect timeout cancelled.`);
      }
  }

  const handleMatchEnd = async (matchId, winnerId, reason) => {
    try {
      const matchKey = keys.matchInfo(matchId);
      const matchDataStr = await redis.get(matchKey);
      if (!matchDataStr) return;
      const matchData = JSON.parse(matchDataStr);
      const { challengerId, eliteId } = matchData;
      const loserId = winnerId === challengerId ? eliteId : challengerId;

      if (loserId) {
          const loserParticipantStr = await redis.hget(keys.participants, loserId);
          if (loserParticipantStr) {
              const loserParticipant = JSON.parse(loserParticipantStr);
              if (loserParticipant.role === 'elite') {
                  await prisma.user.update({ where: { id: loserId }, data: { eventScore: { decrement: 2 } }});
              }
          }
      }

      // --- FIX: Update roles FIRST, before emitting the event ---
      const [winnerUpdate, loserUpdate] = await Promise.all([updatePlayerRole(winnerId), updatePlayerRole(loserId)]);

      // --- FIX: Emit targeted events to each user with their new role ---
      io.to(`user:${winnerId}`).emit("round2:matchResult", { winnerId, loserId, reason, newRole: winnerUpdate.newRole });
      if (loserId) {
          io.to(`user:${loserId}`).emit("round2:matchResult", { winnerId, loserId, reason, newRole: loserUpdate.newRole });
      }

      for (const pId of [challengerId, eliteId]) {
          const pStr = await redis.hget(keys.participants, pId);
          if (pStr) {
              const p = JSON.parse(pStr);
              p.status = `${p.role}:idle`;
              await redis.hset(keys.participants, pId, JSON.stringify(p));
          }
          await redis.set(keys.cooldown(pId), "true", "EX", COOLDOWN_DURATION_S);
          io.to(`user:${pId}`).emit("round2:cooldown", { duration: COOLDOWN_DURATION_S });
      }

      await redis.del(keys.userMatch(challengerId), keys.userMatch(eliteId), matchKey);
      await broadcastDashboardUpdates();
    } catch (err) {
      console.error(`Error in handleMatchEnd for match ${matchId}:`, err);
    }
  };

  const handleBountyEnd = async (userId, questionId, isCorrect, submissionData) => {
    try {
      const sessionKey = keys.bountySession(userId, questionId);
      const session = await redis.hgetall(sessionKey);
      if (!session || !session.status || session.status === 'completed' || session.status === 'timeout') return;

      if (isCorrect) {
        // const isFirstSolver = await redis.sadd(keys.solvedBounties(), questionId) === 1;
        // submissionData.isFirstSolverBonus = isFirstSolver;
        await prisma.submission.create({ data: submissionData });
      }

      await redis.multi()
        .hset(sessionKey, "status", isCorrect ? "completed" : "attempted")
        .del(keys.activeBounty(userId))
        .sadd(keys.attemptedBounties(userId), questionId)
        .exec();

      // --- FIX: Update role FIRST and get the new role ---
      const { newRole } = await updatePlayerRole(userId);

      const pStr = await redis.hget(keys.participants, userId);
      if (pStr) {
          const p = JSON.parse(pStr);
          p.status = `${p.role}:idle`;
          await redis.hset(keys.participants, userId, JSON.stringify(p));
      }
      
      // --- FIX: Include the new role in the event payload ---
      io.to(`user:${userId}`).emit("round2:bountyEnded", { 
          questionId, 
          reason: isCorrect ? "completed" : "incorrect",
          newRole 
      });

      await broadcastDashboardUpdates();
    } catch (err) {
        console.error(`Error in handleBountyEnd for user ${userId}:`, err);
    }
  };

  matchEndHandler = handleMatchEnd;
  bountyEndHandler = handleBountyEnd;

  const handleLobbyJoin = async (payload, callback) => {
  try {
    const userId = socket.user?.email;
    if (!userId) {
      return callback?.({ 
        success: false, 
        message: "Authentication error.",
        roundNumber: 2,
        isActive: false,
        participantCount: 0
      });
    }

    // Join socket room FIRST
    socket.join("round2_lobby");
    console.debug(`[R2] Socket joined round2_lobby: ${userId}`);

    // Get round status info
    const [roundStarted, roundStatus, participantsData] = await Promise.all([
      redis.get(keys.roundStarted),
      prisma.round.findUnique({ where: { roundNumber: 2 }, select: { status: true } }),
      redis.hgetall(keys.participants)
    ]);

    const isActive = !!roundStarted;
    const participantsList = Object.values(participantsData || {}).map(p => JSON.parse(p));

    const participantStr = await redis.hget(keys.participants, userId);
    if (participantStr) {
      console.debug(`[R2] User ${userId} already in lobby`);
      await broadcastLobbyUpdate();
      return callback?.({ 
        success: true, 
        message: "Rejoined lobby.",
        roundNumber: 2,
        isActive,
        participantCount: participantsList.length
      });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return callback?.({ 
        success: false, 
        message: "User not found.",
        roundNumber: 2,
        isActive,
        participantCount: participantsList.length
      });
    }

    const participant = { id: user.id, username: user.username || user.id.split('@')[0], status: 'lobby' };
    await redis.hset(keys.participants, userId, JSON.stringify(participant));
    
    console.debug(`[R2] User ${userId} added to participants`);
    await broadcastLobbyUpdate();
    
    callback?.({ 
      success: true, 
      message: "Joined lobby successfully.",
      roundNumber: 2,
      isActive,
      participantCount: participantsList.length + 1
    });
  } catch (err) {
    console.error("[R2] Error in handleLobbyJoin:", err);
    callback?.({ 
      success: false, 
      message: "Server error during join.",
      roundNumber: 2,
      isActive: false,
      participantCount: 0
    });
  }
};

  const handleStart = async (payload, callback) => {
    try {
      const adminUser = await prisma.user.findUnique({ where: {id: socket.user?.email }});
      if (adminUser?.role !== 'ADMIN') {
        console.error("[R2] Start failed: Not authorized");
        return callback({ success: false, message: "Not authorized." });
      }

      await prisma.round.update({ where: { roundNumber: 2 }, data: { status: 'IN_PROGRESS' } });

      const endTime = Date.now() + ROUND_DURATION_MS;
      await redis.multi().set(keys.roundStarted, "true").set(keys.roundEndTime, endTime).exec();

      const participantsData = await redis.hgetall(keys.participants);
      const players = Object.values(participantsData).map(p => JSON.parse(p));
      const eliteCount = Math.ceil(players.length * 0.5);
      const multi = redis.multi();
      const dbUpdatePromises = [];

      for (let i = 0; i < players.length; i++) {
        const player = players[i];
        const role = i < eliteCount ? "elite" : "challenger";
        player.status = `${role}:idle`; player.role = role;
        multi.hset(keys.participants, player.id, JSON.stringify(player));
        multi.set(keys.role(player.id), role);
        if (role === "elite") multi.sadd(keys.elites, player.id); else multi.sadd(keys.challengers, player.id);
        dbUpdatePromises.push(prisma.user.update({ where: { id: player.id }, data: { round2Role: role.toUpperCase() } }));
        io.to(`user:${player.id}`).emit("round2:rolesAssigned", { role });
      }
      await Promise.all([multi.exec(), ...dbUpdatePromises]);

      await broadcastLobbyUpdate();

      // 🔑 Push canonical state to all participants after round start
      for (const player of players) {
        io.to(`user:${player.id}`).emit("round2:getState");
      }
      callback({ success: true });
    } catch (err) {
      console.error("[R2] Error in handleStart:", err);
      callback({ success: false, message: "Server error." });
    }
  };

  const handleGetState = async (payload, callback) => {
     try {
      const userId = socket.user?.email;
      if (!userId) {
        console.error("[R2] Get state failed: No userId");
        socket.emit("round2:state", {
          success: false,
          error: "Authentication error.",
          timestamp: Date.now(),
          roundNumber: 2,
          round: {
            isActive: false,
            status: 'LOBBY',
            startTime: null,
            endTime: null,
            timeRemaining: 0,
            duration: ROUND_DURATION_MS
          },
          participants: {
            total: 0,
            byStatus: {
              lobby: [],
              waiting: [],
              in_match: [],
              in_bounty: [],
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
      
      const [
        roundStarted,
        endTimeStr,
        participantsData,
        participantStr,
        userMatchId,
        activeBountyKey,
        elites,
        challengers,
        roundStatus
      ] = await Promise.all([
        redis.get(keys.roundStarted),
        redis.get(keys.roundEndTime),
        redis.hgetall(keys.participants),
        redis.hget(keys.participants, userId),
        redis.get(keys.userMatch(userId)),
        redis.get(keys.activeBounty(userId)),
        redis.smembers(keys.elites),
        redis.smembers(keys.challengers),
        prisma.round.findUnique({ where: { roundNumber: 2 }, select: { status: true } })
      ]);

      const participant = participantStr ? JSON.parse(participantStr) : null;
      const allParticipants = Object.values(participantsData || {}).map(p => JSON.parse(p));

      // Determine round status
      const isActive = !!roundStarted;
      let status = 'LOBBY';
      if (roundStatus?.status) {
        status = roundStatus.status; // LOCKED, LOBBY, IN_PROGRESS, or COMPLETED
      } else if (isActive) {
        status = 'IN_PROGRESS';
      }

      // Calculate time remaining
      const endTime = endTimeStr ? parseInt(endTimeStr) : null;
      const timeRemaining = endTime ? Math.max(0, endTime - Date.now()) : 0;

      // Categorize participants including in_bounty for Round 2
      const byStatusR2 = {
        lobby: [],
        waiting: [],
        in_match: [],
        in_bounty: [],
        finished: [],
        disconnected: [],
        cooldown: []
      };

      for (const p of allParticipants) {
        const statusKey = p.status ? p.status.toLowerCase() : 'lobby';
        
        if (statusKey.includes('idle')) {
          byStatusR2.waiting.push(p);
        } else if (statusKey.includes('match')) {
          byStatusR2.in_match.push(p);
        } else if (statusKey.includes('bounty')) {
          byStatusR2.in_bounty.push(p);
        } else if (statusKey.includes('cooldown')) {
          byStatusR2.cooldown.push(p);
        } else if (statusKey.includes('finished') || statusKey.includes('completed')) {
          byStatusR2.finished.push(p);
        } else if (statusKey.includes('disconnected')) {
          byStatusR2.disconnected.push(p);
        } else {
          byStatusR2.lobby.push(p);
        }
      }

      // Calculate startTime from endTime
      const startTime = endTime ? endTime - ROUND_DURATION_MS : null;

      // Build session object if user has active match or bounty
      let session = undefined;
      if (userMatchId) {
        const matchDataStr = await redis.get(keys.matchInfo(userMatchId));
        if (matchDataStr) {
          const matchData = JSON.parse(matchDataStr);
          const opponentId = matchData.challengerId === userId ? matchData.eliteId : matchData.challengerId;
          const opponentData = allParticipants.find(p => p.id === opponentId);
          
          session = {
            type: 'match',
            id: userMatchId,
            startTime: matchData.startTime || Date.now(),
            endTime: matchData.endTime || (Date.now() + MATCH_DURATION_MS),
            timeRemaining: matchData.endTime ? Math.max(0, matchData.endTime - Date.now()) : MATCH_DURATION_MS,
            opponent: opponentData ? {
              id: opponentData.id,
              username: opponentData.username,
              rank: opponentData.rank
            } : undefined,
            problem: matchData.question
          };
        }
      } else if (activeBountyKey) {
        const bountySession = await redis.hgetall(activeBountyKey);
        if (bountySession && bountySession.questionId) {
          const question = await prisma.problem.findUnique({ where: { id: bountySession.questionId } });
          session = {
            type: 'bounty',
            id: activeBountyKey,
            startTime: parseInt(bountySession.startTime) || Date.now(),
            endTime: parseInt(bountySession.endTime) || (Date.now() + MATCH_DURATION_MS),
            timeRemaining: bountySession.endTime ? Math.max(0, parseInt(bountySession.endTime) - Date.now()) : MATCH_DURATION_MS,
            problem: question
          };
        }
      }

      // Get incoming requests for elites
      let incomingRequests = [];
      if (participant?.role === 'elite') {
        const requestIds = await redis.smembers(keys.pendingRequests(userId));
        const requestPromises = requestIds.map(async (challengerId) => {
          const challenger = allParticipants.find(p => p.id === challengerId);
          if (!challenger) return null;
          const requestKey = keys.challengeRequest(challengerId, userId);
          const ttl = await redis.ttl(requestKey);
          if (ttl <= 0) return null;
          return {
            userId: challenger.id,
            username: challenger.username,
            rank: challenger.rank || 0,
            expiresAt: Date.now() + ttl * 1000
          };
        });
        incomingRequests = (await Promise.all(requestPromises)).filter(Boolean);
      }

      // Get pending requests for challengers
      let pendingRequests = [];
      if (participant?.role === 'challenger') {
        pendingRequests = await redis.smembers(keys.outgoingRequests(userId));
      }

      // Get bounty questions with status
      const allBountyQuestions = await prisma.problem.findMany({ where: { difficulty: 'R2_BOUNTY' } });
      const userSubmissions = await prisma.submission.findMany({ 
        where: { userId: userId, problem: { difficulty: 'R2_BOUNTY' }, status: 'ACCEPTED' } 
      });
      const solvedQuestionIds = new Set(userSubmissions.map(sub => sub.problemId));
      const globallySolvedIds = await redis.smembers(keys.solvedBounties());
      const globallySolvedSet = new Set(globallySolvedIds);
      const userAttemptedIds = await redis.smembers(keys.attemptedBounties(userId));
      const userAttemptedSet = new Set(userAttemptedIds);

      const bountyQuestions = allBountyQuestions.map(q => ({
        ...q,
        isSolved: solvedQuestionIds.has(q.id),
        isSolvedByAnyone: globallySolvedSet.has(q.id),
        isAttemptedByUser: userAttemptedSet.has(q.id)
      }));

      // Emit unified state structure
      socket.emit("round2:state", {
        success: true,
        timestamp: Date.now(),
        roundNumber: 2,
        round: {
          isActive,
          status,
          startTime,
          endTime,
          timeRemaining,
          duration: ROUND_DURATION_MS
        },
        participants: {
          total: allParticipants.length,
          byStatus: byStatusR2,
          all: allParticipants
        },
        currentUser: participant,
        session,
        roundSpecific: {
          role: participant?.role,
          incomingRequests,
          pendingRequests,
          bountyQuestions
        },
        message: 'State retrieved successfully'
      });
    
    } catch (err) {
      console.error("[R2] Error in handleGetState:", err);
      socket.emit("round2:state", {
        success: false,
        error: "Server error fetching state.",
        timestamp: Date.now(),
        roundNumber: 2,
        round: {
          isActive: false,
          status: 'LOBBY',
          startTime: null,
          endTime: null,
          timeRemaining: 0,
          duration: ROUND_DURATION_MS
        },
        participants: {
          total: 0,
          byStatus: {
            lobby: [],
            waiting: [],
            in_match: [],
            in_bounty: [],
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

  const handleGetDashboardState = async (payload, callback) => {
    try {
        const userId = socket.user?.email;
        if (!userId) {
          console.error("[R2] Get dashboard failed: No userId");
          return callback?.({ success: false, message: "Authentication error." });
        }

        const [
            participantsData,
            allBountyQuestions,
            participantStr,
            userSubmissions,
            endTimeStr,
            globallySolvedIds,
            userAttemptedIds
        ] = await Promise.all([
            redis.hgetall(keys.participants),
            prisma.problem.findMany({ where: { difficulty: 'R2_BOUNTY' } }),
            redis.hget(keys.participants, userId),
            prisma.submission.findMany({ where: { userId: userId, problem: { difficulty: 'R2_BOUNTY' }, status: 'ACCEPTED' } }),
            redis.get(keys.roundEndTime),
            redis.smembers(keys.solvedBounties()),
            redis.smembers(keys.attemptedBounties(userId))
        ]);

        if (!participantStr) return callback?.({ success: false, message: "You are not a participant in this round." });

        const solvedQuestionIds = new Set(userSubmissions.map(sub => sub.problemId));
        const globallySolvedSet = new Set(globallySolvedIds);
        const userAttemptedSet = new Set(userAttemptedIds);

        const bountyQuestionsWithStatus = allBountyQuestions.map(q => ({
            ...q,
            isSolved: solvedQuestionIds.has(q.id),
            isSolvedByAnyone: globallySolvedSet.has(q.id),
            isAttemptedByUser: userAttemptedSet.has(q.id)
        }));

        const participants = Object.values(participantsData).map(p => JSON.parse(p));
        const currentUser = JSON.parse(participantStr);
        let incomingRequests = [];
        if (currentUser.role === 'elite') {
            const requestIds = await redis.smembers(keys.pendingRequests(userId));
            const requestPromises = requestIds.map(async (challengerId) => {
                const participant = participants.find(p => p.id === challengerId);
                if (!participant) return null;
                const requestKey = keys.challengeRequest(challengerId, userId);
                const ttl = await redis.ttl(requestKey);
                if (ttl <= 0) return null;
                return { ...participant, expiresAt: Date.now() + ttl * 1000 };
            });
            incomingRequests = (await Promise.all(requestPromises)).filter(Boolean);
        }
        const roundEndTime = endTimeStr ? parseInt(endTimeStr) : null;
        callback?.({ success: true, dashboard: { allParticipants: participants, bountyQuestions: bountyQuestionsWithStatus, incomingRequests, roundEndTime } });
    } catch (err) {
        console.error("[R2] Error in handleGetDashboardState:", err);
        callback?.({ success: false, message: "Server error fetching dashboard state." });
    }
  };

  const handleBountyBeginQuestion = async (payload, callback) => {
    try {
      const { questionId } = payload;
      const userId = socket.user.email;

      const isAlreadyAttempted = await redis.sismember(keys.attemptedBounties(userId), questionId);
      if (isAlreadyAttempted) {
          console.error(`[R2] Bounty begin failed: Question ${questionId} already attempted by ${userId}`);
          return callback({ success: false, message: "You have already attempted this bounty question." });
      }

      if (await redis.get(keys.userMatch(userId)) || await redis.get(keys.activeBounty(userId))) {
        return callback({ success: false, message: "You are already in an active session." });
      }

      const roundEndTimeStr = await redis.get(keys.roundEndTime);
      if (!roundEndTimeStr) return callback({ success: false, message: "Round has not started." });
      const startTime = parseInt(roundEndTimeStr) - ROUND_DURATION_MS;
      if (Date.now() < startTime + ACTION_LOCK_MS) return callback({ success: false, message: "Bounties are locked for the first 5 minutes." });
      const question = await prisma.problem.findUnique({ where: { id: questionId } });
      if (!question || question.difficulty !== 'R2_BOUNTY') return callback({ success: false, message: "Bounty question not found." });

      const sessionStartTime = Date.now();
      const sessionEndTime = sessionStartTime + (20 * 60 * 1000);
      const sessionKey = keys.bountySession(userId, questionId);

      const pStr = await redis.hget(keys.participants, userId);
      const p = JSON.parse(pStr);
      p.status = 'in-bounty';

      await redis.multi()
        .hset(sessionKey, { status: "active", questionId, startTime: sessionStartTime, endTime: sessionEndTime })
        .set(keys.activeBounty(userId), sessionKey)
        .hset(keys.participants, userId, JSON.stringify(p))
        .exec();

      callback({ success: true, questionId, startTime: sessionStartTime, endTime: sessionEndTime });
      await broadcastDashboardUpdates();
    } catch (err) {
      console.error("[R2] Error in handleBountyBeginQuestion:", err);
      callback({ success: false, message: "Could not start bounty." });
    }
  };

  const handleChallengeRequest = async (payload, callback) => {
    try {
        const { eliteId } = payload;
        const challengerId = socket.user.email;
        if (await redis.get(keys.userMatch(challengerId)) || await redis.get(keys.activeBounty(challengerId))) {
            return callback({ success: false, message: "You are already in an active session." });
        }

        const [challengerP, eliteP] = await Promise.all([redis.hget(keys.participants, challengerId).then(p => p ? JSON.parse(p) : null), redis.hget(keys.participants, eliteId).then(p => p ? JSON.parse(p) : null)]);
        if (challengerP?.role !== "challenger" || eliteP?.role !== "elite") return callback?.({ success: false, message: "Invalid roles for challenge." });
        if (challengerP?.status !== "challenger:idle" || eliteP?.status !== "elite:idle") return callback?.({ success: false, message: "One or both players are not available." });
        const [challengerCooldown, eliteCooldown] = await Promise.all([redis.exists(keys.cooldown(challengerId)), redis.exists(keys.cooldown(eliteId))]);
        if (challengerCooldown || eliteCooldown) return callback?.({ success: false, message: "One or both players are in cooldown." });

        const requestKey = keys.challengeRequest(challengerId, eliteId);
        if (!(await redis.set(requestKey, "true", "EX", CHALLENGE_REQUEST_EXPIRY_S, "NX"))) return callback?.({ success: false, message: "Request already sent." });

        await redis.multi().sadd(keys.pendingRequests(eliteId), challengerId).sadd(keys.outgoingRequests(challengerId), eliteId).exec();

        const timeoutId = setTimeout(async () => {
            try {
                requestTimeouts.delete(requestKey);
                if (await redis.del(requestKey)) {
                    await redis.multi()
                        .srem(keys.pendingRequests(eliteId), challengerId)
                        .srem(keys.outgoingRequests(challengerId), eliteId)
                        .exec();
                    io.to(`user:${eliteId}`).emit("round2:requestExpired", { challengerId });
                    io.to(`user:${challengerId}`).emit("round2:challengeExpired", { eliteId, reason: "Request timed out." });
                }
            } catch (err) { console.error(`Error in request expiry for ${requestKey}:`, err); }
        }, CHALLENGE_REQUEST_EXPIRY_S * 1000);
        requestTimeouts.set(requestKey, timeoutId);

        io.to(`user:${eliteId}`).emit("round2:challengeIncoming", { challenger: challengerP, expiresAt: Date.now() + CHALLENGE_REQUEST_EXPIRY_S * 1000 });
        callback?.({ success: true, message: "Challenge request sent." });
        await broadcastDashboardUpdates();
    } catch (err) {
        console.error("[R2] Error in handleChallengeRequest:", err);
        callback({ success: false, message: "Server error" });
    }
  };

  const handleChallengeAccept = async (payload, callback) => {
    try {
        const { challengerId } = payload;
        const eliteId = socket.user.email;

        if (await redis.get(keys.userMatch(eliteId)) || await redis.get(keys.activeBounty(eliteId))) {
            return callback({ success: false, message: "You are already in an active session." });
        }

        const requestKey = keys.challengeRequest(challengerId, eliteId);
        if (requestTimeouts.has(requestKey)) { clearTimeout(requestTimeouts.get(requestKey)); requestTimeouts.delete(requestKey); }
        if (!(await redis.del(requestKey))) return callback?.({ success: false, message: "Request expired or invalid." });
        await redis.del(keys.rejectCount(eliteId));

        const allPendingChallengerIds = await redis.smembers(keys.pendingRequests(eliteId));
        const cleanupMulti = redis.multi();
        for (const otherChallengerId of allPendingChallengerIds) {
            const otherRequestKey = keys.challengeRequest(otherChallengerId, eliteId);
            if (requestTimeouts.has(otherRequestKey)) clearTimeout(requestTimeouts.delete(otherRequestKey));
            cleanupMulti.del(otherRequestKey);
            cleanupMulti.srem(keys.outgoingRequests(otherChallengerId), eliteId);
            io.to(`user:${otherChallengerId}`).emit("round2:challengeExpired", { eliteId, reason: "Elite accepted another match." });
        }
        cleanupMulti.del(keys.pendingRequests(eliteId));
        await cleanupMulti.exec();

        // const question = await prisma.problem.find({ where: { difficulty: 'R2_CHALLENGE' }});

        const questions = await prisma.problem.findMany({
  where: { difficulty: 'R2_CHALLENGE' }
});

const question = questions[Math.floor(Math.random() * questions.length)];
        if (!question) throw new Error("No R2_CHALLENGE question found in database.");

        const matchId = `match:${challengerId}:${eliteId}:${Date.now()}`;
        const endTime = Date.now() + MATCH_DURATION_MS;
        await redis.set(keys.matchInfo(matchId), JSON.stringify({ challengerId, eliteId, question, startTime: Date.now(), endTime }), "EX", MATCH_DURATION_MS + 60);

        for (const pId of [challengerId, eliteId]) {
            const pStr = await redis.hget(keys.participants, pId);
            const p = JSON.parse(pStr);
            p.status = 'in-match';
            await redis.hset(keys.participants, pId, JSON.stringify(p));
            await redis.set(keys.userMatch(pId), matchId);
        }

        const challengerSockets = await io.in(`user:${challengerId}`).allSockets();
        challengerSockets.forEach(sid => io.sockets.sockets.get(sid)?.join(matchId));
        socket.join(matchId);

        io.to(matchId).emit("round2:matchStarted", { matchId, question, endTime, players: { challengerId, eliteId } });
        callback?.({ success: true, matchId });
        await broadcastDashboardUpdates();
    } catch (err) {
        console.error("[R2] Error in handleChallengeAccept:", err);
        callback?.({ success: false, message: "Server error." });
    }
  };

  const handleChallengeReject = async (payload, callback) => {
    try {
        const { challengerId } = payload;
        const eliteId = socket.user.email;
        const requestKey = keys.challengeRequest(challengerId, eliteId);
        if (requestTimeouts.has(requestKey)) { clearTimeout(requestTimeouts.get(requestKey)); requestTimeouts.delete(requestKey); }
        if (!(await redis.del(requestKey))) return;
        await redis.multi().srem(keys.pendingRequests(eliteId), challengerId).srem(keys.outgoingRequests(challengerId), eliteId).exec();

        const rejectCount = await redis.incr(keys.rejectCount(eliteId));
        if (rejectCount >= 3) {
            await prisma.user.update({ where: { id: eliteId }, data: { eventScore: { decrement: 20 } } });
            await redis.del(keys.rejectCount(eliteId));
            io.to(`user:${eliteId}`).emit('round2:info', { message: "You lost 20 points for rejecting 3 challenges." });
        }

        io.to(`user:${challengerId}`).emit("round2:challengeRejected", { eliteId });
        callback?.({ success: true, message: "Challenge rejected." });
        await broadcastDashboardUpdates();
    } catch (err) {
        console.error("[R2] Error in handleChallengeReject:", err);
        callback?.({ success: false, message: "Server error." });
    }
  };

  const handleGetCodePageState = async (payload, callback) => {
      try {
        const { contextId, sessionType } = payload;
        const userId = socket.user.email;
        if (sessionType === 'match') {
            const matchDataStr = await redis.get(keys.matchInfo(contextId));
            if (!matchDataStr) return callback({ success: false, message: "Match not found." });
            const matchData = JSON.parse(matchDataStr);
            const opponentId = matchData.challengerId === userId ? matchData.eliteId : matchData.challengerId;
            const opponentDataStr = await redis.hget(keys.participants, opponentId);
            const opponentData = opponentDataStr ? JSON.parse(opponentDataStr) : { username: 'Unknown' };
            const question = await prisma.problem.findUnique({ where: { id: matchData.question.id }});
            callback({ success: true, sessionData: { type: 'match', opponent: { id: opponentId, username: opponentData.username }, question: question, endTime: matchData.endTime }});
        } else if (sessionType === 'bounty') {
            const questionId = contextId;
            const sessionKey = keys.bountySession(userId, questionId);
            const bountySession = await redis.hgetall(sessionKey);
            if (!bountySession.status) return callback({ success: false, message: "Bounty session not found." });
            const question = await prisma.problem.findUnique({ where: { id: questionId } });
            callback({ success: true, sessionData: { type: 'bounty', question: question, endTime: parseInt(bountySession.endTime) }});
        } else {
            callback({ success: false, message: "Invalid session type." });
        }
      } catch(err) {
          console.error("[R2] Error in getCodePageState:", err);
          callback({ success: false, message: "Server error getting session." });
      }
  };

  const handleDisconnect = async () => {
    try {
      const userId = socket.user?.email;
      if (!userId) return;

      const matchId = await redis.get(keys.userMatch(userId));
      if (matchId && !disconnectTimeouts.has(userId)) {
          console.log(`[Socket.IO] User ${userId} disconnected during match ${matchId}. Starting ${DISCONNECT_GRACE_PERIOD_MS / 1000}s timer.`);

          const timeoutId = setTimeout(async () => {
              console.log(`[Socket.IO] User ${userId} did not reconnect in time. Ending match ${matchId}.`);
              const currentMatchDataStr = await redis.get(keys.matchInfo(matchId));
              if (currentMatchDataStr) {
                  const matchData = JSON.parse(currentMatchDataStr);
                  const winnerId = matchData.challengerId === userId ? matchData.eliteId : matchData.challengerId;
                  await handleMatchEnd(matchId, winnerId, "disconnect");
              }
              disconnectTimeouts.delete(userId);
          }, DISCONNECT_GRACE_PERIOD_MS);

          disconnectTimeouts.set(userId, timeoutId);
      }
    } catch (err) {
      console.error(`[Socket.IO] Error on disconnect for ${socket.user?.email}:`, err);
    }
  };

  const resetRound2Instance = async () => {
  try {
    console.warn("🔄 [ADMIN] Resetting Round 2 state");

    // 1️⃣ Stop in-memory intervals
    if (lobbyUpdateInterval) clearInterval(lobbyUpdateInterval);
    if (dashboardUpdateInterval) clearInterval(dashboardUpdateInterval);
    lobbyUpdateInterval = null;
    dashboardUpdateInterval = null;

    // 2️⃣ Clear in-memory timeouts
    for (const timeout of requestTimeouts.values()) {
      clearTimeout(timeout);
    }
    requestTimeouts.clear();

    for (const timeout of disconnectTimeouts.values()) {
      clearTimeout(timeout);
    }
    disconnectTimeouts.clear();

    // 3️⃣ Collect ALL round-2 Redis keys
    const patterns = [
      "round2:participants",
      "round2:started",
      "round2:endTime",
      "round2:elites",
      "round2:challengers",
      "round2:role:*",
      "round2:cooldown:*",
      "round2:bounty:*",
      "round2:activeBounty:*",
      "round2:request:*",
      "round2:pending:*",
      "round2:outgoing:*",
      "round2:match:*",
      "round2:userMatch:*",
      "round2:rejects:*",
      "round2:solvedBounties",
      "round2:attempted:*",
    ];

    // 4️⃣ Delete Redis keys safely
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(keys);
      }
    }

    // 5️⃣ Reset DB round status
    await prisma.round.update({
      where: { roundNumber: 2 },
      data: { status: "LOBBY" },
    });

    console.log("✅ [ADMIN] Round 2 reset complete");
    return true;
  } catch (err) {
    console.error("❌ [ADMIN] Failed to reset Round 2", err);
    return false;
  }
};

const handleRound2Reset = async (payload, callback) => {
  try {
    // 🔐 Admin check
    const admin = await prisma.user.findUnique({
      where: { id: socket.user?.email },
      select: { role: true },
    });

    if (admin?.role !== "ADMIN") {
      return callback?.({
        success: false,
        error: "Unauthorized",
      });
    }

    // 🔄 Reset round 2
    const success = await resetRound2Instance();

    if (!success) {
      return callback?.({
        success: false,
        error: "Reset failed",
      });
    }

    // 📢 Notify all clients
    io.emit("round2:reset");

    return callback?.({ success: true });

  } catch (err) {
    console.error("[Round2 Reset Error]", err);
    return callback?.({
      success: false,
      error: "Server error",
    });
  }
};



  socket.on("round2:join", handleLobbyJoin);
  socket.on("round2:ready", handleStart);
  socket.on("round2:getState", handleGetState);
  socket.on("disconnect", handleDisconnect);
  socket.on("round2:getDashboardState", handleGetDashboardState);
  socket.on("round2:getCodePageState", handleGetCodePageState);
  socket.on("round2:bountyBeginQuestion", handleBountyBeginQuestion);
  socket.on("round2:challengeRequest", handleChallengeRequest);
  socket.on("round2:challengeAccept", handleChallengeAccept);
  socket.on("round2:challengeReject", handleChallengeReject);
  socket.on("round2:reset", handleRound2Reset);

};

// Admin functions
export const round2AdminAddUser = async (io, userId, forceAdd = false) => {
  try {
    if (!userId) {
      io.emit("admin:error", { error: "Invalid user email" });
      return;
    }

    const keys = getRedisKeys(userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, eventScore: true, round2Role: true }
    });

    if (!user) {
      io.emit("admin:error", { error: "User not found" });
      return;
    }

    const roundDB = await prisma.round.findUnique({
      where: { roundNumber: 2 }
    });

    if (!roundDB) {
      io.emit("admin:error", { error: "Round 2 not found" });
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

    const existing = await redis.hget(keys.participants, userId);
    if (existing) {
      io.to(`user:${userId}`).emit("round2:adminAdded");
      return;
    }

    const role = user.eventScore > ROLE_THRESHOLD_SCORE ? "elite" : "challenger";
    const participant = {
      id: userId,
      username: user.username,
      eventScore: user.eventScore,
      role: role,
      status: "lobby"
    };

    await redis.hset(keys.participants, userId, JSON.stringify(participant));
    await redis.set(keys.role(userId), role);

    io.to(`user:${userId}`).emit("round2:adminAdded");
    io.emit("admin:success", { action: "add", userId, round: 2 });

  } catch (err) {
    console.error("[Admin Add User R2]", err);
    io.emit("admin:error", { error: "Failed to add user" });
  }
};

export const round2AdminRemoveUser = async (io, userId) => {
  try {
    const keys = getRedisKeys(userId);
    const participantStr = await redis.hget(keys.participants, userId);
    
    if (!participantStr) {
      io.emit("admin:error", { error: "User not in round" });
      return;
    }

    const participant = JSON.parse(participantStr);

    // If user is in match, end it
    const matchId = await redis.get(keys.userMatch(userId));
    if (matchId) {
      const matchInfo = await redis.get(keys.matchInfo(matchId));
      if (matchInfo) {
        const match = JSON.parse(matchInfo);
        const opponentId = match.challengerId === userId ? match.eliteId : match.challengerId;
        
        io.to(`match:${matchId}`).emit("round2:matchEnd", {
          winner: opponentId,
          reason: "opponent_removed_by_admin"
        });
        
        await redis.del(keys.matchInfo(matchId));
        await redis.del(keys.userMatch(userId));
        await redis.del(keys.userMatch(opponentId));
      }
    }

    // Clean up user data
    await redis.hdel(keys.participants, userId);
    await redis.del(keys.role(userId));
    await redis.del(keys.cooldown(userId));
    await redis.del(keys.activeBounty(userId));
    await redis.del(keys.rejectCount(userId));

    // 🔑 Force canonical state update to removed user
    io.to(`user:${userId}`).emit("round2:state", {
      success: true,
      roundNumber: 2,
      round: {
        number: 2,
        status: "LOBBY",
        isActive: false,
        endTime: null,
        timeRemaining: 0,
      },
      currentUser: {
        id: userId,
        role: null,
        status: null,
        activeSession: false,
      },
      participants: {
        all: [],
        byStatus: {
          lobby: [],
          waiting: [],
          in_match: [],
          cooldown: [],
          finished: [],
          disconnected: [],
        },
      },
    });

    // Refresh lobby state for admin panels
    io.emit("round2:getState");
    io.to(`user:${userId}`).emit("round2:adminRemoved");
    io.emit("admin:success", { action: "remove", userId, round: 2 });

  } catch (err) {
    console.error("[Admin Remove User R2]", err);
    io.emit("admin:error", { error: "Failed to remove user" });
  }
};

export const endRound2 = async (io, forceEnd = false) => {
  const keys = getRedisKeys();

  console.log("--- ENDING ROUND 2 ---");

  try {
    // Stop intervals
    if (lobbyUpdateInterval) {
      clearInterval(lobbyUpdateInterval);
      lobbyUpdateInterval = null;
      console.log("✅ Lobby update interval cleared");
    }
    if (dashboardUpdateInterval) {
      clearInterval(dashboardUpdateInterval);
      dashboardUpdateInterval = null;
      console.log("✅ Dashboard update interval cleared");
    }

    // Clear all request timeouts
    for (const [key, timeoutId] of requestTimeouts.entries()) {
      clearTimeout(timeoutId);
      requestTimeouts.delete(key);
    }
    console.log("✅ All request timeouts cleared");

    // Clear disconnect timeouts
    for (const [userId, timeoutId] of disconnectTimeouts.entries()) {
      clearTimeout(timeoutId);
      disconnectTimeouts.delete(userId);
    }
    console.log("✅ All disconnect timeouts cleared");

    // End all active matches
    const matchKeys = await redis.keys("round2:match:*");
    for (const matchKey of matchKeys) {
      const matchDataStr = await redis.get(matchKey);
      if (matchDataStr) {
        const matchData = JSON.parse(matchDataStr);
        const matchId = matchKey.replace("round2:match:", "");
        
        // Notify players that match ended due to round end
        io.to(`match:${matchId}`).emit("round2:matchEnd", {
          winner: null,
          reason: forceEnd ? "admin_force_end" : "round_ended"
        });
        
        console.log(`✅ Ended match ${matchId}`);
      }
    }

    // Reset all participants to lobby status
    const participantsData = await redis.hgetall(keys.participants);
    for (const userId in participantsData) {
      const participant = JSON.parse(participantsData[userId]);
      participant.status = "lobby";
      await redis.hset(keys.participants, userId, JSON.stringify(participant));
      
      // Clear user-specific data
      await redis.del(
        keys.cooldown(userId),
        keys.activeBounty(userId),
        keys.userMatch(userId),
        keys.rejectCount(userId)
      );
      
      io.to(`user:${userId}`).emit("round2:ended");
    }
    console.log("✅ All participants reset to lobby");

    // Update round status in Redis and database
    await redis.set(keys.roundStarted, "false");
    await redis.del(keys.roundEndTime);
    await prisma.round.update({
      where: { roundNumber: 2 },
      data: { status: "COMPLETED" }
    });
    console.log("✅ Round 2 status updated to COMPLETED");

    // Broadcast round ended to all clients
    io.emit("round2:ended");

    // Broadcast final lobby update
    await broadcastLobbyUpdate();

    console.log("✅ Round 2 ended successfully");
  } catch (error) {
    console.error("❌ Error ending Round 2:", error);
    throw error;
  }
};

export const getRound2Handlers = () => ({
  matchEndHandler,
  bountyEndHandler,
});