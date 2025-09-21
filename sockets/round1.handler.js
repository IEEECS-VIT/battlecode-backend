import redis from "../config/redis.js";
import prisma from "../config/prisma.js";

// Constants
const ROUND_DURATION = 90 * 60 * 1000;
const ROUND_NUMBER = 1;
const MATCHMAKING_INTERVAL = 3 * 60 * 1000;
const COOLDOWN_DURATION = 2 * 60 * 1000;
const DISCONNECT_TIMEOUT = 1 * 60 * 1000;
const JANITOR_INTERVAL = 5000;

// Global round management variables
let globalTimer = null;
let globalTimerInterval = null;
let matchmakingInterval = null;
let matchmakingCycleInterval = null; // Re-added for matchmaking timer broadcast
let round1MatchEndHandler = null;

const getRedisKeys = () => ({
    participants: `round${ROUND_NUMBER}:participants`,
    readyQueue: `round${ROUND_NUMBER}:readyQueue`,
    matches: `round${ROUND_NUMBER}:matches`,
    status: `round${ROUND_NUMBER}:status`,
    startTime: `round${ROUND_NUMBER}:status:startTime`,
});

const startJanitor = () => {
    setInterval(async () => {
        try {
            const keys = getRedisKeys();
            const allMatchesStr = await redis.hgetall(keys.matches);
            for (const matchId in allMatchesStr) {
                const match = JSON.parse(allMatchesStr[matchId]);
                if (match.disconnectEndTime && Date.now() > match.disconnectEndTime) {
                    console.log(`[Janitor] Found expired disconnect for match ${matchId}.`);
                    const opponentId = match.players.find(pId => pId !== match.disconnectedPlayerId);
                    if (round1MatchEndHandler) {
                        await round1MatchEndHandler(matchId, opponentId);
                    }
                }
            }
        } catch (error) {
            console.error('[Janitor Error]', error);
        }
    }, JANITOR_INTERVAL);
    console.log('[System] Persistent timer janitor started.');
};

startJanitor();

export const round1Handler = (io, socket) => {
    const validateUser = () => {
        const userId = socket.user?.email;
        if (!userId) return { error: 'Unauthorized' };
        return { userId, email: userId };
    };

    const broadcastLobbyUpdate = async () => {
        try {
            const keys = getRedisKeys();
            const allParticipantsData = await redis.hgetall(keys.participants);
            const participantsList = Object.values(allParticipantsData).map(p => JSON.parse(p));
            const lobbyParticipants = participantsList.filter(p => p.status === 'lobby');
            const currentStatus = await redis.get(keys.status);

            io.emit('lobby:round1', {
                participants: lobbyParticipants,
                totalParticipants: lobbyParticipants.length,
                isActive: currentStatus === "running"
            });
            io.emit('round1:participantsUpdate', { participants: participantsList });
        } catch (error) {
            console.error('[Broadcast Error]', error);
        }
    };
    
    // CHANGE: Re-added matchmaking cycle broadcast
    const startMatchmakingCycleBroadcast = () => {
        if (matchmakingCycleInterval) clearInterval(matchmakingCycleInterval);
        matchmakingCycleInterval = setInterval(() => {
            const now = Math.floor(Date.now() / 1000);
            const nextCycle = Math.floor((MATCHMAKING_INTERVAL / 1000) - (now % (MATCHMAKING_INTERVAL / 1000)));
            io.emit('round1:matchmakingCycle', { nextCycle });
        }, 1000);
    };

    const handleMatchEnd = async (matchId, winnerId) => {
        const keys = getRedisKeys();
        const matchStr = await redis.hget(keys.matches, matchId);
        if (!matchStr) return;
        const match = JSON.parse(matchStr);

        console.log(`[Match End] Match ${matchId} ended. Winner: ${winnerId || 'Timeout'}.`);

        await redis.hdel(keys.matches, matchId);
        await prisma.match.update({ where: { id: matchId }, data: { status: 'COMPLETED', winnerId } }).catch(err => console.log(`Prisma update failed for match ${matchId}, might be a bot match.`));

        const playerRanks = await prisma.user.findMany({ select: { id: true }, orderBy: [{ eventScore: 'desc' }, { username: 'asc' }] });
        const rankMap = new Map(playerRanks.map((u, i) => [u.id, i + 1]));

        for (const playerId of match.players) {
            const playerStr = await redis.hget(keys.participants, playerId);
            if (!playerStr) continue;

            const player = JSON.parse(playerStr);
            player.rank = rankMap.get(playerId) || player.rank;
            player.status = 'cooldown';
            player.cooldownEndTime = Date.now() + COOLDOWN_DURATION;
            await redis.hset(keys.participants, playerId, JSON.stringify(player));

            io.to(`user:${playerId}`).emit('round1:matchEnd', {
                type: winnerId ? (playerId === winnerId ? 'win' : 'lose') : 'timeout',
            });
            io.to(`user:${playerId}`).emit('round1:cooldown', {
                cooldownEndTime: player.cooldownEndTime
            });
        }
        await broadcastLobbyUpdate();
    };

    const getQuestionByDifficulty = async (difficulty) => {
        const problems = await prisma.problem.findMany({ where: { roundId: 1, difficulty } });
        return problems.length > 0 ? problems[Math.floor(Math.random() * problems.length)] : null;
    };
    
    const createMatch = async (player1, player2, difficulty) => {
        const question = await getQuestionByDifficulty(difficulty);
        if (!question) {
            console.error(`No question for ${difficulty}. Cannot create match.`);
            return;
        }

        let timerDuration;
        if (difficulty === 'R1_HARD') timerDuration = 25 * 60 * 1000;
        else if (difficulty === 'R1_MEDIUM') timerDuration = 1 * 60 * 1000;
        else timerDuration = 15 * 60 * 1000;

        try {
            const newMatch = await prisma.match.create({
                data: { playerAId: player1.id, playerBId: player2.id, problemId: question.id, status: 'ONGOING' },
            });

            const matchId = newMatch.id;
            const startTime = Date.now();
            const keys = getRedisKeys();
            const matchDetails = { id: matchId, players: [player1.id, player2.id], problemId: question.id, startTime, duration: timerDuration, difficulty, isPaused: false, timePaused: 0 };

            await redis.multi()
                .zrem(keys.readyQueue, player1.id, player2.id)
                .hset(keys.matches, matchId, JSON.stringify(matchDetails))
                .hset(keys.participants, player1.id, JSON.stringify({ ...player1, status: 'in-match' }))
                .hset(keys.participants, player2.id, JSON.stringify({ ...player2, status: 'in-match' }))
                .exec();

            const matchRoom = `match:${matchId}`;
            const questionData = { id: question.id, title: question.title, description: question.description };
            const matchPayload = { question: questionData, startTime, duration: timerDuration };
            
            io.to(`user:${player1.id}`).emit('round1:matchFound', { ...matchPayload, opponent: { id: player2.id, rank: player2.rank } });
            io.to(`user:${player2.id}`).emit('round1:matchFound', { ...matchPayload, opponent: { id: player1.id, rank: player1.rank } });
            
            const [socket1] = await io.in(`user:${player1.id}`).allSockets();
            const [socket2] = await io.in(`user:${player2.id}`).allSockets();
            if(socket1) io.sockets.sockets.get(socket1)?.join(matchRoom);
            if(socket2) io.sockets.sockets.get(socket2)?.join(matchRoom);
            
            const timerInterval = setInterval(async () => {
                const currentMatchStr = await redis.hget(getRedisKeys().matches, matchId);
                if (!currentMatchStr) return clearInterval(timerInterval);
                
                const currentMatch = JSON.parse(currentMatchStr);
                if (currentMatch.isPaused) return;

                const elapsed = (Date.now() - currentMatch.startTime) - currentMatch.timePaused;
                const timeRemaining = Math.max(0, Math.floor((currentMatch.duration - elapsed) / 1000));
                
                io.to(matchRoom).emit('round1:timerUpdate', { timeRemaining });

                if (timeRemaining <= 0) {
                    clearInterval(timerInterval);
                    handleMatchEnd(matchId, null);
                }
            }, 1000);
            
            console.log(`[Match Created] ${matchId} between ${player1.id} and ${player2.id}`);

        } catch (error) {
            console.error("[Create Match Error]", error);
        }
    };

    const runMatchmakingCycle = async () => {
        const keys = getRedisKeys();
        const queueSize = await redis.zcard(keys.readyQueue);
        if (queueSize < 2) return;

        console.log(`[Matchmaking] Running cycle with ${queueSize} players.`);
        
        try {
            const playerIds = await redis.zrange(keys.readyQueue, 0, -1);
            const playersRaw = await redis.hmget(keys.participants, ...playerIds);
            let waitingPlayers = playersRaw.map(p => JSON.parse(p)).filter(p => p && p.status === 'waiting');

            if (waitingPlayers.length < 2) return;

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
                    matchPromises.push(createMatch(group[i*2], group[i*2 + 1], difficulties[index]));
                }
            });

            await Promise.all(matchPromises);
        } catch (error) {
            console.error("[Matchmaking Error]", error);
        }
    };

    const endRound = async () => {
        console.log("--- ROUND 1 HAS ENDED ---");
        if(matchmakingInterval) clearInterval(matchmakingInterval);
        if(globalTimer) clearTimeout(globalTimer);
        if(globalTimerInterval) clearInterval(globalTimerInterval);
        if(matchmakingCycleInterval) clearInterval(matchmakingCycleInterval);
        matchmakingInterval = globalTimer = globalTimerInterval = matchmakingCycleInterval = null;
        await redis.set(getRedisKeys().status, "ended");
        await prisma.round.update({ where: { roundNumber: ROUND_NUMBER }, data: { status: 'COMPLETED' } });
        io.emit('round1:ended');
    };

    const resetRoundState = async () => {
        try {
            console.warn("--- ADMIN: Resetting Round 1 State ---");
            if(matchmakingInterval) clearInterval(matchmakingInterval);
            if(globalTimer) clearTimeout(globalTimer);
            if(globalTimerInterval) clearInterval(globalTimerInterval);
            if(matchmakingCycleInterval) clearInterval(matchmakingCycleInterval);
            matchmakingInterval = globalTimer = globalTimerInterval = matchmakingCycleInterval = null;
            
            const keys = Object.values(getRedisKeys());
            await redis.del(keys);
            
            await prisma.match.deleteMany({ where: { problem: { roundId: 1 } } });
            await prisma.round.update({ where: { roundNumber: ROUND_NUMBER }, data: { status: 'LOBBY' } });
            console.log("Round 1 state has been cleared.");
            return true;
        } catch (error) {
            console.error('[Reset Error]', error);
            return false;
        }
    };
    
    round1MatchEndHandler = handleMatchEnd;

    socket.on('round1:join', async (payload, callback) => {
        const { userId, email, error } = validateUser();
        if (error) return callback?.({ success: false, error });

        socket.join(`user:${userId}`);
        const keys = getRedisKeys();

        try {
            if (await redis.hget(keys.participants, userId)) {
                return callback?.({ success: true, message: 'Already joined.' });
            }
            if (await redis.get(keys.status) === 'ended') {
                return callback?.({ success: false, error: 'Round has already ended.' });
            }
            const userData = await prisma.user.findUnique({ where: { id: email } });
            if (!userData) return callback?.({ success: false, error: 'User not found.' });
            
            const userRank = (await prisma.user.count({ where: { eventScore: { gt: userData.eventScore || 0 } }})) + 1;
            const newParticipant = { id: userId, socketId: socket.id, username: userData.username, rank: userRank, status: 'lobby' };
            await redis.hset(keys.participants, userId, JSON.stringify(newParticipant));

            await broadcastLobbyUpdate();
            callback?.({ success: true, message: 'Successfully joined lobby.' });
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
        await redis.set(keys.status, "running");
        await redis.set(keys.startTime, roundStartTime);
        await prisma.round.update({ where: { roundNumber: ROUND_NUMBER }, data: { status: 'IN_PROGRESS' } });
        
        const participants = await redis.hgetall(keys.participants);
        const multi = redis.multi();
        Object.values(participants).forEach(pStr => {
            const p = JSON.parse(pStr);
            if (p.status === 'lobby') {
                p.status = 'waiting';
                multi.hset(keys.participants, p.id, JSON.stringify(p));
                multi.zadd(keys.readyQueue, p.rank, p.id);
            }
        });
        await multi.exec();

        globalTimer = setTimeout(endRound, ROUND_DURATION);
        if (globalTimerInterval) clearInterval(globalTimerInterval);
        globalTimerInterval = setInterval(() => {
            const elapsed = Date.now() - roundStartTime;
            const remaining = Math.max(0, Math.floor((ROUND_DURATION - elapsed) / 1000));
            io.emit('round1:globalTimer', { timeRemaining: remaining });
            if (remaining <= 0) clearInterval(globalTimerInterval);
        }, 1000);

        matchmakingInterval = setInterval(runMatchmakingCycle, MATCHMAKING_INTERVAL);
        startMatchmakingCycleBroadcast(); // CHANGE: Start the cycle timer broadcast
        runMatchmakingCycle();
        
        io.emit('round1:started', { roundStartTime, roundDuration: ROUND_DURATION });
        await broadcastLobbyUpdate();
        callback?.({ success: true, message: 'Round 1 started.' });
    });

    socket.on('disconnect', async () => {
        const { userId, error } = validateUser();
        if (error) return;

        const keys = getRedisKeys();
        const participantStr = await redis.hget(keys.participants, userId);
        if (!participantStr) return;
        
        const participant = JSON.parse(participantStr);
        console.log(`[Disconnect] User ${userId} with status ${participant.status} disconnected.`);

        if (participant.status === 'in-match') {
            const matches = await redis.hgetall(keys.matches);
            for (const matchId in matches) {
                let match = JSON.parse(matches[matchId]);
                if (match.players.includes(userId) && !match.isPaused) {
                    console.log(`[Disconnect] Pausing match ${matchId} and setting disconnect timer.`);
                    match.isPaused = true;
                    match.pauseStartTime = Date.now();
                    match.disconnectEndTime = Date.now() + DISCONNECT_TIMEOUT;
                    match.disconnectedPlayerId = userId;
                    await redis.hset(keys.matches, matchId, JSON.stringify(match));
                    io.to(`match:${matchId}`).emit('round1:matchPaused', { disconnectedPlayerId: userId });
                    return; 
                }
            }
        } else {
             console.log(`[Disconnect] User ${userId} state preserved for refresh/reconnect.`);
        }
    });

    socket.on('round1:getState', async (payload, callback) => {
        const { userId, error } = validateUser();
        if (error) return callback?.({ success: false, error });

        socket.join(`user:${userId}`);

        try {
            const keys = getRedisKeys();
            const currentStatus = await redis.get(keys.status);
            const allParticipantsData = await redis.hgetall(keys.participants);
            const allParticipants = Object.values(allParticipantsData).map(p => JSON.parse(p));
            let participant = allParticipants.find(p => p.id === userId);
            
            if (!participant) {
                return callback?.({ success: true, participant: null, allParticipants });
            }

            if (participant.status === 'cooldown' && Date.now() > participant.cooldownEndTime) {
                console.log(`[GetState] Cooldown for ${userId} expired. Updating status.`);
                participant.status = 'waiting';
                delete participant.cooldownEndTime;
                await redis.hset(keys.participants, userId, JSON.stringify(participant));
                await redis.zadd(keys.readyQueue, participant.rank, userId);
                await broadcastLobbyUpdate();
            }
            
            if (participant.socketId !== socket.id) {
                participant.socketId = socket.id;
                await redis.hset(keys.participants, userId, JSON.stringify(participant));
            }
            
            if (participant.status === 'in-match') {
                const matches = await redis.hgetall(keys.matches);
                for (const matchId in matches) {
                    let match = JSON.parse(matches[matchId]);
                    if (match.players.includes(userId)) {
                        socket.join(`match:${matchId}`);
                        if (match.isPaused && match.disconnectedPlayerId === userId) {
                            console.log(`[Reconnect] User ${userId} reconnected, resuming match ${matchId}.`);
                            match.isPaused = false;
                            match.timePaused += Date.now() - match.pauseStartTime;
                            delete match.disconnectEndTime;
                            delete match.disconnectedPlayerId;
                            delete match.pauseStartTime;
                            await redis.hset(keys.matches, matchId, JSON.stringify(match));
                            io.to(`match:${matchId}`).emit('round1:matchResumed');
                        }
                        break;
                    }
                }
            }

            const startTimeStr = await redis.get(keys.startTime);
            const roundStartTime = startTimeStr ? parseInt(startTimeStr) : null;
            const globalTimeRemaining = roundStartTime ? Math.max(0, Math.floor((ROUND_DURATION - (Date.now() - roundStartTime)) / 1000)) : 0;
            
            // CHANGE: Include next matchmaking cycle time in getState response
            let nextMatchmakingCycle = null;
            if (currentStatus === "running") {
                const now = Math.floor(Date.now() / 1000);
                nextMatchmakingCycle = Math.floor((MATCHMAKING_INTERVAL / 1000) - (now % (MATCHMAKING_INTERVAL / 1000)));
            }
            
            callback?.({ success: true, participant, isActive: currentStatus === "running", globalTimeRemaining, allParticipants, nextMatchmakingCycle });
        } catch (err) {
            console.error('[GetState Error]', err);
            callback?.({ success: false, error: 'Server error fetching state.' });
        }
    });

    socket.on('round1:reset', async (payload, callback) => {
        const { userId, error } = validateUser();
        if (error) return callback?.({ success: false, error });

        const userData = await prisma.user.findUnique({ where: { id: userId, role: 'ADMIN' } });
        if (!userData) return callback?.({ success: false, error: 'Unauthorized.' });
        
        if (await resetRoundState()) {
            io.emit('round1:reset');
            callback?.({ success: true, message: 'Round 1 reset successfully.' });
        } else {
            callback?.({ success: false, error: 'Failed to reset round.' });
        }
    });
};

export const getRound1MatchEndHandler = () => round1MatchEndHandler;

