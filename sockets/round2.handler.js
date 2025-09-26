import redis from "../config/redis.js";
import prisma from "../config/prisma.js";

// --- Constants ---
const ROUND_DURATION_MS = 90 * 60 * 1000;
const MATCH_DURATION_MS = 20 * 60 * 1000;
const COOLDOWN_DURATION_S = 2 * 60;
const LOBBY_UPDATE_INTERVAL_MS = 3000;
const ACTION_LOCK_MS = 5 * 60 * 1000; // 5 minutes

// --- Module-Scoped Variables ---
let round2IO = null;
let matchEndHandler = null;
let bountyEndHandler = null;
let lobbyUpdateInterval = null;

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
    solvedBounties: () => "round2:solvedBounties"
});

// --- Broadcasters ---
const broadcastRoundState = async () => {
  if (!round2IO) return;
  try {
    const keys = getRedisKeys();
    const [participantsData, isRoundActive, endTimeStr] = await Promise.all([
      redis.hgetall(keys.participants),
      redis.get(keys.roundStarted),
      redis.get(keys.roundEndTime)
    ]);
    
    const participantsList = Object.values(participantsData).map(p => JSON.parse(p));
    const timeRemaining = endTimeStr ? Math.max(0, parseInt(endTimeStr) - Date.now()) : 0;

    round2IO.to('round2_lobby').emit("round2:lobbyUpdate", {
      participants: participantsList,
      isRoundActive: !!isRoundActive,
    });
    
    if(isRoundActive){
        round2IO.to('round2_lobby').emit('round2:timerUpdate', { timeRemaining });
    }

  } catch (err) {
    console.error("Error broadcasting R2 round state:", err);
  }
};

export const round2Handler = (io, socket) => {
  if (!round2IO) round2IO = io;
  const keys = getRedisKeys();
  
  if (!lobbyUpdateInterval) {
    lobbyUpdateInterval = setInterval(broadcastRoundState, 1000);
    console.log("✅ Round 2 Global State Updater Started.");
  }

  console.log('New socket connection for Round 2:', socket.user?.email);

  // --- Core Logic Handlers ---
  const handleMatchEnd = async (matchId, winnerId, reason) => {
    try {
      const matchKey = keys.matchInfo(matchId);
      const matchDataStr = await redis.get(matchKey);
      if (!matchDataStr) return;
      const matchData = JSON.parse(matchDataStr);
      const { challengerId, eliteId } = matchData;
      const loserId = winnerId === challengerId ? eliteId : challengerId;

      io.to(matchId).emit("round2:matchResult", { matchId, winnerId, loserId, reason });

      const winnerData = await prisma.user.findUnique({ where: { id: winnerId }, select: { eventScore: true }});
      const winnerParticipantStr = await redis.hget(keys.participants, winnerId);

      if (winnerParticipantStr) {
          const winnerParticipant = JSON.parse(winnerParticipantStr);
          if (winnerParticipant.role === "challenger" && winnerData.eventScore > 100) {
              const loserParticipantStr = await redis.hget(keys.participants, loserId);
              const loserParticipant = JSON.parse(loserParticipantStr);
              winnerParticipant.role = "elite";
              loserParticipant.role = "challenger";
              
              await redis.multi()
                  .hset(keys.participants, winnerId, JSON.stringify(winnerParticipant))
                  .hset(keys.participants, loserId, JSON.stringify(loserParticipant))
                  .set(keys.role(winnerId), "elite").set(keys.role(loserId), "challenger")
                  .srem(keys.challengers, winnerId).sadd(keys.elites, winnerId)
                  .srem(keys.elites, loserId).sadd(keys.challengers, loserId)
                  .exec();
              io.emit("round2:roleUpdate", { newElite: winnerId, newChallenger: loserId });
          }
      }
      
      const loserParticipantStr = await redis.hget(keys.participants, loserId);
      if (loserParticipantStr) {
          const loserParticipant = JSON.parse(loserParticipantStr);
          if (loserParticipant.role === 'elite') {
              await prisma.user.update({ where: { id: loserId }, data: { eventScore: { decrement: 2 } }});
          }
      }
      
      for (const userId of [challengerId, eliteId]) {
          const pStr = await redis.hget(keys.participants, userId);
          if (pStr) {
              const p = JSON.parse(pStr);
              p.status = `${p.role}:idle`;
              await redis.hset(keys.participants, userId, JSON.stringify(p));
          }
          await redis.set(keys.cooldown(userId), "true", "EX", COOLDOWN_DURATION_S);
          io.to(userId).emit("round2:cooldown", { duration: COOLDOWN_DURATION_S });
      }

      await redis.del(keys.userMatch(challengerId), keys.userMatch(eliteId), matchKey);
      await broadcastRoundState();
    } catch (err) {
      console.error(`Error in handleMatchEnd for match ${matchId}:`, err);
    }
  };

  const handleBountyEnd = async (userId, questionId, isCorrect, submissionData) => {
    try {
      const sessionKey = keys.bountySession(userId, questionId);
      const session = await redis.hgetall(sessionKey);
      if (!session || session.status === 'completed' || session.status === 'timeout') return;

      if (isCorrect) {
        const isFirstSolver = await redis.sadd(keys.solvedBounties(), questionId) === 1;
        submissionData.isFirstSolverBonus = isFirstSolver;
        await prisma.submission.create({ data: submissionData });
      }

      await redis.multi()
        .hset(sessionKey, "status", isCorrect ? "completed" : "attempted")
        .del(keys.activeBounty(userId))
        .exec();
      io.to(userId).emit("round2:bountyEnded", { questionId, reason: isCorrect ? "completed" : "incorrect" });
    } catch (err) {
      console.error(`Error in handleBountyEnd for user ${userId}:`, err);
    }
  };

  matchEndHandler = handleMatchEnd;
  bountyEndHandler = handleBountyEnd;

  // --- Socket Event Handlers (Listeners) ---

  const handleLobbyJoin = async (callback) => {
    try {
      const userId = socket.user?.email;
      if (!userId) return callback?.({ success: false, message: "Authentication error." });

      socket.join('round2_lobby');
      socket.join(userId);

      const round2Status = await prisma.round.findUnique({ where: { roundNumber: 2 }, select: { status: true }});
      if (round2Status?.status !== 'LOBBY') {
          return callback?.({ success: false, message: `Round 2 is not in lobby phase. Current status: ${round2Status?.status}` });
      }

      if (await redis.hget(keys.participants, userId)) {
        await broadcastRoundState();
        return callback?.({ success: true, message: "Rejoined lobby." });
      }
      
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return callback?.({ success: false, message: "User not found." });
      
      const participant = { id: user.id, username: user.username || user.id.split('@')[0], status: 'lobby' };
      await redis.hset(keys.participants, userId, JSON.stringify(participant));
      
      await broadcastRoundState();
      callback?.({ success: true, message: "Joined lobby successfully." });
    } catch (err) {
      console.error("Error in handleLobbyJoin:", err);
      callback?.({ success: false, message: "Server error during join." });
    }
  };

  const handleStart = async (callback) => {
    try {
      const adminUser = await prisma.user.findUnique({ where: {id: socket.user?.email }});
      if (adminUser?.role !== 'ADMIN') return callback({ success: false, message: "Not authorized." });

      await prisma.round.update({
        where: { roundNumber: 2 },
        data: { status: 'IN_PROGRESS' },
      });
      console.log("✅ Round 2 status updated to IN_PROGRESS in database.");

      const endTime = Date.now() + ROUND_DURATION_MS;
      await redis.multi().set(keys.roundStarted, "true").set(keys.roundEndTime, endTime).exec();

      const participantsData = await redis.hgetall(keys.participants);
      const players = Object.values(participantsData).map(p => JSON.parse(p)).sort(() => Math.random() - 0.5);
      
      const eliteCount = Math.ceil(players.length * 0.5);
      const multi = redis.multi();
      for (let i = 0; i < players.length; i++) {
        const player = players[i];
        const role = i < eliteCount ? "elite" : "challenger";
        player.status = `${role}:idle`;
        player.role = role;
        
        multi.hset(keys.participants, player.id, JSON.stringify(player));
        multi.set(keys.role(player.id), role);
        if (role === "elite") multi.sadd(keys.elites, player.id);
        else multi.sadd(keys.challengers, player.id);

        io.to(player.id).emit("round2:rolesAssigned", { role });
      }
      await multi.exec();

      await broadcastRoundState();
      callback({ success: true });
    } catch (err) {
      console.error("Error in handleStart:", err);
      callback({ success: false, message: "Server error." });
    }
  };

  const handleGetState = async (callback) => {
     try {
      const userId = socket.user?.email;
      if (!userId) return callback?.({ success: false, message: "Authentication error." });

      const [roundStarted, endTimeStr, participantStr, userMatchId] = await Promise.all([
        redis.get(keys.roundStarted),
        redis.get(keys.roundEndTime),
        redis.hget(keys.participants, userId),
        redis.get(keys.userMatch(userId)),
      ]);

      const participant = participantStr ? JSON.parse(participantStr) : null;
      const shouldBeInGame = !!(participant?.role || userMatchId);

      callback?.({
        success: true,
        state: {
          roundIsActive: !!roundStarted,
          roundEndTime: endTimeStr ? parseInt(endTimeStr) : null,
          userRole: participant?.role || null,
          userMatchId: userMatchId || null,
          shouldBeInGame: shouldBeInGame,
        }
      });
    } catch (err) {
      console.error("Error in handleGetState:", err);
      callback?.({ success: false, message: "Server error." });
    }
  };

  const handleGetDashboardState = async (callback) => {
    try {
        const userId = socket.user?.email;
        if (!userId) return callback?.({ success: false, message: "Authentication error." });

        const [participantsData, allBountyQuestions, participantStr, userSubmissions, endTimeStr] = await Promise.all([
            redis.hgetall(keys.participants),
            prisma.problem.findMany({ where: { difficulty: 'R2_BOUNTY' } }),
            redis.hget(keys.participants, userId),
            prisma.submission.findMany({ where: { userId: userId, problem: { difficulty: 'R2_BOUNTY' }, status: 'ACCEPTED' } }),
            redis.get(keys.roundEndTime)
        ]);

        if (!participantStr) {
            return callback?.({ success: false, message: "You are not a participant in this round." });
        }
        
        const solvedQuestionIds = new Set(userSubmissions.map(sub => sub.problemId));
        const bountyQuestionsWithStatus = allBountyQuestions.map(q => ({
            ...q,
            isSolved: solvedQuestionIds.has(q.id)
        }));
        
        const participants = Object.values(participantsData).map(p => JSON.parse(p));
        const currentUser = JSON.parse(participantStr);
        let incomingRequests = [];
        if (currentUser.role === 'elite') {
            const requestIds = await redis.smembers(keys.pendingRequests(userId));
            incomingRequests = participants.filter(p => requestIds.includes(p.id));
        }

        const roundEndTime = endTimeStr ? parseInt(endTimeStr) : null;

        callback?.({
            success: true,
            dashboard: {
                allParticipants: participants,
                bountyQuestions: bountyQuestionsWithStatus,
                incomingRequests: incomingRequests,
                roundEndTime: roundEndTime,
            }
        });

    } catch (err) {
        console.error("Error in handleGetDashboardState:", err);
        callback?.({ success: false, message: "Server error fetching dashboard state." });
    }
  };
  
  const handleBountyBeginQuestion = async (payload, callback) => {
    try {
      const roundEndTimeStr = await redis.get(keys.roundEndTime);
      if (!roundEndTimeStr) return callback({ success: false, message: "Round has not started." });
      
      const startTime = parseInt(roundEndTimeStr) - ROUND_DURATION_MS;
      if (Date.now() < startTime + ACTION_LOCK_MS) {
        return callback({ success: false, message: "Bounties are locked for the first 5 minutes." });
      }

      const userId = socket.user.email;
      const { questionId } = payload;
      const LEVEL_TIME_LIMIT_MS = { R2_BOUNTY: 20 * 60 * 1000 };
      const question = await prisma.problem.findUnique({ where: { id: questionId } });
      if (!question || question.difficulty !== 'R2_BOUNTY') {
        return callback({ success: false, message: "Bounty question not found." });
      }

      const timeLimit = LEVEL_TIME_LIMIT_MS[question.difficulty];
      const sessionStartTime = Date.now();
      const sessionEndTime = sessionStartTime + timeLimit;
      const sessionKey = keys.bountySession(userId, questionId);

      await redis.multi()
        .hset(sessionKey, {
          status: "active",
          questionId,
          startTime: sessionStartTime,
          endTime: sessionEndTime,
          codeSnapshot: "",
        })
        .set(keys.activeBounty(userId), sessionKey)
        .exec();

      callback({ success: true, questionId, startTime: sessionStartTime, endTime: sessionEndTime });
    } catch (err) {
      console.error("Error in handleBountyBeginQuestion:", err);
      callback({ success: false, message: "Could not start bounty." });
    }
  };
  
  const handleChallengeRequest = async (payload, callback) => {
    try {
        const challengerId = socket.user.email;
        const { eliteId } = payload;

        const [challengerRole, eliteRole, challengerStatus, eliteStatus, challengerCooldown, eliteCooldown, challengerDataStr] = await Promise.all([
            redis.get(keys.role(challengerId)),
            redis.get(keys.role(eliteId)),
            redis.hget(keys.participants, challengerId).then(p => p ? JSON.parse(p).status : null),
            redis.hget(keys.participants, eliteId).then(p => p ? JSON.parse(p).status : null),
            redis.exists(keys.cooldown(challengerId)),
            redis.exists(keys.cooldown(eliteId)),
            redis.hget(keys.participants, challengerId)
        ]);

        if (challengerRole !== "challenger" || eliteRole !== "elite") return callback?.({ success: false, message: "Invalid roles for challenge." });
        if (challengerStatus !== "challenger:idle" || eliteStatus !== "elite:idle") return callback?.({ success: false, message: "One or both players are not available." });
        if (challengerCooldown || eliteCooldown) return callback?.({ success: false, message: "One or both players are in cooldown." });
        if (!challengerDataStr) return callback?.({ success: false, message: "Could not find your participant data." });

        const requestKey = keys.challengeRequest(challengerId, eliteId);
        const setResult = await redis.set(requestKey, "true", "EX", 30, "NX");

        if (!setResult) {
            return callback?.({ success: false, message: "Request already sent." });
        }
        
        await redis.multi()
            .sadd(keys.pendingRequests(eliteId), challengerId)
            .sadd(keys.outgoingRequests(challengerId), eliteId)
            .exec();

        const challenger = JSON.parse(challengerDataStr);
        io.to(eliteId).emit("round2:challengeIncoming", { challenger });
        callback?.({ success: true, message: "Challenge request sent." });
    } catch (err) {
        console.error("Error in handleChallengeRequest:", err);
        callback({ success: false, message: "Server error" });
    }
  };
  
  const handleChallengeAccept = async (payload, callback) => {
    try {
        const eliteId = socket.user.email;
        const { challengerId } = payload;
        const requestKey = keys.challengeRequest(challengerId, eliteId);
        if (!(await redis.exists(requestKey))) {
            return callback?.({ success: false, message: "Request expired or invalid." });
        }

        const multi = redis.multi().del(requestKey).srem(keys.pendingRequests(eliteId), challengerId);
        const [delResult] = await multi.exec();

        if (delResult === 0) return callback?.({ success: false, message: "Could not accept, request already handled." });
        
        await redis.del(keys.rejectCount(eliteId));

        const question = await prisma.problem.findFirst({ where: { difficulty: 'R2_CHALLENGE' }});
        const matchId = `match:${challengerId}:${eliteId}:${Date.now()}`;
        const endTime = Date.now() + MATCH_DURATION_MS;

        await redis.set(keys.matchInfo(matchId), JSON.stringify({ challengerId, eliteId, question, startTime: Date.now(), endTime }), "EX", MATCH_DURATION_MS + 60);
        
        for (const userId of [challengerId, eliteId]) {
            const pStr = await redis.hget(keys.participants, userId);
            const p = JSON.parse(pStr);
            p.status = 'in-match';
            await redis.hset(keys.participants, userId, JSON.stringify(p));
            await redis.set(keys.userMatch(userId), matchId);
        }

        const challengerSocket = (await io.in(challengerId).allSockets()).values().next().value;
        if (challengerSocket) io.sockets.sockets.get(challengerSocket)?.join(matchId);
        socket.join(matchId);

        io.to(matchId).emit("round2:matchStarted", { matchId, question, endTime, players: { challengerId, eliteId } });
        callback?.({ success: true, matchId });
        await broadcastRoundState();
    } catch (err) {
        console.error("Error in handleChallengeAccept:", err);
        callback?.({ success: false, message: "Server error." });
    }
  };

  const handleChallengeReject = async (payload, callback) => {
    try {
        const eliteId = socket.user.email;
        const { challengerId } = payload;
        await redis.multi()
            .del(keys.challengeRequest(challengerId, eliteId))
            .srem(keys.pendingRequests(eliteId), challengerId)
            .srem(keys.outgoingRequests(challengerId), eliteId)
            .exec();

        const rejectCount = await redis.incr(keys.rejectCount(eliteId));
        if (rejectCount >= 3) {
            await prisma.user.update({
                where: { id: eliteId },
                data: { eventScore: { decrement: 20 } }
            });
            await redis.del(keys.rejectCount(eliteId));
            io.to(eliteId).emit('round2:info', { message: "You lost 20 points for rejecting 3 challenges." });
        }
        
        io.to(challengerId).emit("round2:challengeRejected", { eliteId });
        callback?.({ success: true, message: "Challenge rejected." });
    } catch (err) {
        console.error("Error in handleChallengeReject:", err);
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

            callback({ success: true, sessionData: {
                type: 'match',
                opponent: { id: opponentId, username: opponentData.username },
                question: question,
                endTime: matchData.endTime,
            }});

        } else if (sessionType === 'bounty') {
            const questionId = contextId;
            const sessionKey = keys.bountySession(userId, questionId);
            const bountySession = await redis.hgetall(sessionKey);
            if (!bountySession.status) return callback({ success: false, message: "Bounty session not found." });
            
            const question = await prisma.problem.findUnique({ where: { id: questionId } });
            
            callback({ success: true, sessionData: {
                type: 'bounty',
                question: question,
                endTime: parseInt(bountySession.endTime),
            }});
        } else {
            callback({ success: false, message: "Invalid session type." });
        }
      } catch(err) {
          console.error("Error in getCodePageState:", err);
          callback({ success: false, message: "Server error getting session." });
      }
  };
  
  const handleDisconnect = async () => {
    try {
      const userId = socket.user?.email;
      if (!userId) return;
      console.log(`User ${userId} disconnected.`);
      const matchId = await redis.get(keys.userMatch(userId));
      if (matchId) {
        const matchDataStr = await redis.get(keys.matchInfo(matchId));
        if (!matchDataStr) return;
        const matchData = JSON.parse(matchDataStr);
        const winnerId = matchData.challengerId === userId ? matchData.eliteId : matchData.challengerId;
        await handleMatchEnd(matchId, winnerId, "disconnect");
      }
    } catch (err) {
      console.error(`Error on disconnect for ${socket.user?.email}:`, err);
    }
  };

  // --- Register all socket listeners ---
  socket.on("round2:join", handleLobbyJoin);
  socket.on("round2:start", handleStart);
  socket.on("round2:getState", handleGetState);
  socket.on("disconnect", handleDisconnect);
  socket.on("round2:getDashboardState", handleGetDashboardState);
  socket.on("round2:getCodePageState", handleGetCodePageState);
  socket.on("round2:bountyBeginQuestion", handleBountyBeginQuestion);
  socket.on("round2:challengeRequest", handleChallengeRequest);
  socket.on("round2:challengeAccept", handleChallengeAccept);
  socket.on("round2:challengeReject", handleChallengeReject);
};

export const getRound2Handlers = () => ({
  matchEndHandler,
  bountyEndHandler,
});