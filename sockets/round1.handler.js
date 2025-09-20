/**
 * ROUND 1 SOCKET HANDLER - FIXED VERSION
 * Addresses cooldown timer synchronization issues and improves state management
 */

import redis from "../config/redis.js";
import prisma from "../config/prisma.js";

// Constants
const ROUND_DURATION = 90 * 60 * 1000;
const ROUND_NUMBER = 1;
const INITIAL_MATCHMAKING_INTERVAL = 5000;
const POST_MATCH_MATCHMAKING_INTERVAL = 3 * 60 * 1000;
const COOLDOWN_DURATION = 2 * 60 * 1000;
const DISCONNECT_TIMEOUT = 1 * 60 * 1000;
const LONG_WAIT_THRESHOLD = 5 * 60 * 1000;

// Global variables for round management
let globalTimer = null;
let globalTimerInterval = null;
let matchmakingInterval = null;
let matchmakingCycleInterval = null;
let cooldownTimers = new Map(); // Store cooldown timers per user: { userId: { interval, timeout, startTime, duration } }
let isFirstMatchCycleCompleted = false;
const disconnectTimers = new Map(); // Stores disconnect setTimeout IDs { userId: timeoutId }

// Store handleMatchEnd function globally so it can be accessed from external routes
let round1MatchEndHandler = null;

const getRedisKeys = (userId = null) => ({
    participants: `round${ROUND_NUMBER}:participants`,
    readyQueue: `round${ROUND_NUMBER}:readyQueue`,
    matches: `round${ROUND_NUMBER}:matches`,
    status: `round${ROUND_NUMBER}:status`,
    presence: userId ? `round${ROUND_NUMBER}:user:${userId}` : null,
    matchTimers: `round${ROUND_NUMBER}:matchTimers`,
});

export const round1Handler = (io, socket) => {

    const validateUser = () => {
        const userId = socket.user?.email;
        const email = socket.user?.email;
        if (!userId || !email) {
            console.error(`[Validation] Missing user data - userId: ${userId}, email: ${email}`);
            return { error: 'Unauthorized - No user ID or email' };
        }
        console.log(`[Validation] User validated - userId: ${userId}`);
        return { userId, email };
    };

    const broadcastLobbyUpdate = async () => {
        try {
            const keys = getRedisKeys();
            const allParticipants = await redis.hgetall(keys.participants);
            const lobbyParticipants = Object.values(allParticipants)
                .map(p => JSON.parse(p))
                .filter(p => p.status === 'lobby');
            
            const allParticipantsList = Object.values(allParticipants).map(p => JSON.parse(p));
            
            const currentStatus = await redis.get(keys.status);
            
            io.emit('lobby:round1', { 
                participants: lobbyParticipants,
                totalParticipants: lobbyParticipants.length,
                isActive: currentStatus === "running"
            });
            
            // Also emit detailed participants update for waiting room
            io.emit('round1:participantsUpdate', {
                participants: allParticipantsList
            });
        } catch (error) {
            console.error('[Broadcast Error]', error);
        }
    };

    const startGlobalTimerBroadcast = (roundStartTime) => {
        // Clear any existing global timer broadcast
        if (globalTimerInterval) clearInterval(globalTimerInterval);
        
        console.log(`[Global Timer] Starting global timer broadcast from ${roundStartTime}`);
        
        globalTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - roundStartTime) / 1000);
            const remaining = Math.max(0, Math.floor(ROUND_DURATION / 1000) - elapsed);
            
            io.emit('round1:globalTimer', { timeRemaining: remaining });
            console.log(`[Global Timer] Broadcasting: ${remaining}s remaining`);
            
            if (remaining <= 0) {
                clearInterval(globalTimerInterval);
                globalTimerInterval = null;
                console.log(`[Global Timer] Timer ended, broadcast stopped`);
            }
        }, 1000);
    };

    const startMatchmakingCycleBroadcast = () => {
        // Clear any existing cycle timer
        if (matchmakingCycleInterval) clearInterval(matchmakingCycleInterval);
        
        matchmakingCycleInterval = setInterval(() => {
            if (isFirstMatchCycleCompleted) {
                // Regular 3-minute cycles
                const cycleInterval = 3 * 60;
                const now = Math.floor(Date.now() / 1000);
                const nextCycle = cycleInterval - (now % cycleInterval);
                
                io.emit('round1:matchmakingCycle', { 
                    nextCycle, 
                    isFirstCycle: false,
                    intervalType: 'regular'
                });
                
                console.log(`[Matchmaking Cycle] Next regular cycle in ${nextCycle}s`);
            } else {
                // Initial 5-second cycles
                const cycleInterval = 5;
                const now = Math.floor(Date.now() / 1000);
                const nextCycle = cycleInterval - (now % cycleInterval);
                
                io.emit('round1:matchmakingCycle', { 
                    nextCycle, 
                    isFirstCycle: true,
                    intervalType: 'initial'
                });
                
                console.log(`[Matchmaking Cycle] Next initial cycle in ${nextCycle}s`);
            }
        }, 1000);
    };

    // FIXED: More robust cooldown timer management
    const startCooldownTimer = async (userId, duration, startTime) => {
        // Clear any existing cooldown timer for this user
        if (cooldownTimers.has(userId)) {
            const existingTimer = cooldownTimers.get(userId);
            if (existingTimer.interval) clearInterval(existingTimer.interval);
            if (existingTimer.timeout) clearTimeout(existingTimer.timeout);
            cooldownTimers.delete(userId);
        }

        // Get the latest participant data
        const participant = await redis.hget(getRedisKeys().participants, userId);
        if (!participant) {
            console.log(`[Cooldown Timer] No participant found for ${userId}`);
            return;
        }

        const participantData = JSON.parse(participant);
        
        // Verify participant is actually in cooldown
        if (participantData.status !== 'cooldown') {
            console.log(`[Cooldown Timer] Participant ${userId} not in cooldown status, skipping timer`);
            return;
        }

        console.log(`[Cooldown Timer] Starting cooldown timer for ${userId}, duration: ${Math.ceil(duration/1000)}s, startTime: ${startTime}`);

        // Calculate initial remaining time more accurately
        const elapsed = Date.now() - startTime;
        const initialRemaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
        
        if (initialRemaining <= 0) {
            console.log(`[Cooldown Timer] Cooldown already expired for ${userId}, ending immediately`);
            await endCooldownForUser(userId);
            return;
        }

        // Broadcast cooldown timer every second
        const cooldownInterval = setInterval(async () => {
            const currentElapsed = Date.now() - startTime;
            const remaining = Math.max(0, Math.ceil((duration - currentElapsed) / 1000));
            
            // Get current socket for this user
            const currentParticipant = await redis.hget(getRedisKeys().participants, userId);
            if (!currentParticipant) {
                console.log(`[Cooldown Timer] Participant ${userId} no longer exists, stopping timer`);
                clearInterval(cooldownInterval);
                cooldownTimers.delete(userId);
                return;
            }

            const currentParticipantData = JSON.parse(currentParticipant);
            const userSocket = io.sockets.sockets.get(currentParticipantData.socketId);
            
            if (userSocket && currentParticipantData.status === 'cooldown') {
                userSocket.emit('round1:cooldownTimer', { 
                    timeRemaining: remaining,
                    duration: Math.ceil(duration / 1000),
                    startTime: startTime
                });
                console.log(`[Cooldown Timer] ${userId}: ${remaining}s remaining`);
            }
            
            if (remaining <= 0) {
                console.log(`[Cooldown Timer] Timer reached 0 for ${userId}`);
                clearInterval(cooldownInterval);
                cooldownTimers.delete(userId);
                await endCooldownForUser(userId);
            }
        }, 1000);

        // Set timeout for when cooldown actually ends (backup mechanism)
        const actualRemainingDuration = Math.max(1000, duration - (Date.now() - startTime));
        const cooldownTimeout = setTimeout(async () => {
            console.log(`[Cooldown Timer] Backup timeout triggered for ${userId}`);
            clearInterval(cooldownInterval);
            cooldownTimers.delete(userId);
            await endCooldownForUser(userId);
        }, actualRemainingDuration);

        cooldownTimers.set(userId, {
            interval: cooldownInterval,
            timeout: cooldownTimeout,
            startTime,
            duration
        });
    };

    // FIXED: Separate function for ending cooldown to avoid duplication
    const endCooldownForUser = async (userId) => {
        const keys = getRedisKeys();
        const latestPlayerStr = await redis.hget(keys.participants, userId);
        if (!latestPlayerStr) {
            console.log(`[Cooldown End] No participant found for ${userId}`);
            return;
        }
        
        const latestPlayer = JSON.parse(latestPlayerStr);
        
        // Only end cooldown if user is actually in cooldown
        if (latestPlayer.status === 'cooldown') {
            latestPlayer.status = 'waiting';
            latestPlayer.waitingSince = Date.now();
            delete latestPlayer.cooldownStartTime;
            await redis.hset(keys.participants, userId, JSON.stringify(latestPlayer));
            
            // Add back to matchmaking queue
            await redis.zadd(keys.readyQueue, latestPlayer.rank, userId);
            
            // Notify the user
            const userSocket = io.sockets.sockets.get(latestPlayer.socketId);
            if (userSocket) {
                userSocket.emit('round1:cooldownEnd');
            }
            
            console.log(`[Cooldown End] Player ${userId} back in queue.`);
            
            // Broadcast updated participant list
            await broadcastLobbyUpdate();
        } else {
            console.log(`[Cooldown End] Player ${userId} not in cooldown status: ${latestPlayer.status}`);
        }
    };

    // FIXED: Helper function to calculate accurate cooldown remaining time
    const getCooldownTimeRemaining = (cooldownStartTime) => {
        if (!cooldownStartTime) return 0;
        const elapsed = Date.now() - cooldownStartTime;
        return Math.max(0, Math.ceil((COOLDOWN_DURATION - elapsed) / 1000));
    };

    const resetRoundState = async () => {
        try {
            console.log("[Reset] Resetting Round 1 state...");
            
            if (globalTimer) clearTimeout(globalTimer);
            if (globalTimerInterval) clearInterval(globalTimerInterval);
            if (matchmakingInterval) clearInterval(matchmakingInterval);
            if (matchmakingCycleInterval) clearInterval(matchmakingCycleInterval);
            
            globalTimer = null;
            globalTimerInterval = null;
            matchmakingInterval = null;
            matchmakingCycleInterval = null;
            isFirstMatchCycleCompleted = false;

            disconnectTimers.forEach(timeout => clearTimeout(timeout));
            disconnectTimers.clear();
            
            cooldownTimers.forEach(timer => {
                if (timer.interval) clearInterval(timer.interval);
                if (timer.timeout) clearTimeout(timer.timeout);
            });
            cooldownTimers.clear();
            
            const keys = getRedisKeys();
            await redis.del(
                keys.participants, keys.readyQueue, keys.matches, 
                keys.status, keys.matchTimers
            );
            
            await prisma.round.update({
                where: { roundNumber: 1 },
                data: { status: 'LOBBY' }
            });
            
            console.log("[Reset] Round 1 state reset successfully");
            return true;
        } catch (error) {
            console.error("[Reset Error]", error);
            return false;
        }
    };

    const getQuestionByDifficulty = async (difficulty) => {
        try {
            const problems = await prisma.problem.findMany({
                where: { roundId: 1, difficulty },
            });
            if (problems.length === 0) return null;
            return problems[Math.floor(Math.random() * problems.length)];
        } catch (error) {
            console.error("[Prisma Error] Failed to fetch question:", error);
            return null;
        }
    };

    const runMatchmakingCycle = async () => {
        try {
            const queueSize = await redis.zcard(getRedisKeys().readyQueue);
            if (queueSize < 2) {
                console.log(`[Matchmaking] Skipping cycle - only ${queueSize} players in queue`);
                return;
            }

            console.log(`[Matchmaking] Running cycle with ${queueSize} players.`);
            
            const playerIds = await redis.zrange(getRedisKeys().readyQueue, 0, -1);
            const playerPromises = playerIds.map(id => redis.hget(getRedisKeys().participants, id));
            const playersRaw = await Promise.all(playerPromises);
            let waitingPlayers = playersRaw.map(p => JSON.parse(p)).filter(Boolean);

            // Only include players who are actually waiting (not in cooldown)
            waitingPlayers = waitingPlayers.filter(p => p.status === 'waiting');

            if (waitingPlayers.length < 2) {
                console.log(`[Matchmaking] Skipping cycle - only ${waitingPlayers.length} players actually waiting`);
                return;
            }

            const third = Math.ceil(waitingPlayers.length / 3);
            let g1 = waitingPlayers.slice(0, third);
            let g2 = waitingPlayers.slice(third, 2 * third);
            let g3 = waitingPlayers.slice(2 * third);

            if (g1.length % 2 !== 0 && g2.length > 0) g2.unshift(g1.pop());
            if (g2.length % 2 !== 0 && g3.length > 0) g3.unshift(g2.pop());

            const processGroup = async (group, difficulty) => {
                while (group.length >= 2) {
                    await createMatch(group.shift(), group.shift(), difficulty);
                }
            };

            await Promise.all([
                processGroup(g1, 'R1_HARD'),
                processGroup(g2, 'R1_MEDIUM'),
                processGroup(g3, 'R1_EASY'),
            ]);

        } catch (error) {
            console.error("[Matchmaking Error]", error);
        }
    };

    const startMatchTimer = (matchId, durationMs) => {
        const timerInterval = setInterval(async () => {
            try {
                const matchStr = await redis.hget(getRedisKeys().matches, matchId);
                if (!matchStr) {
                    clearInterval(timerInterval);
                    return;
                }
                const match = JSON.parse(matchStr);
                const elapsed = Date.now() - match.startTime;
                const timeRemaining = Math.max(0, Math.floor((durationMs - elapsed) / 1000));
                
                io.to(`match:${matchId}`).emit('round1:timerUpdate', { timeRemaining });
                
                if (timeRemaining <= 0) {
                    clearInterval(timerInterval);
                    console.log(`[Timer] Match ${matchId} time expired.`);
                    await handleMatchEnd(matchId, null);
                }
            } catch (error) {
                clearInterval(timerInterval);
                console.error(`[Timer Error] Match ${matchId}:`, error);
            }
        }, 1000);
    };

    const createMatch = async (player1, player2, difficulty) => {
        let timerDuration;
        if (difficulty === 'R1_HARD') timerDuration = 25 * 60 * 1000;
        else if (difficulty === 'R1_MEDIUM') timerDuration = 1 * 60 * 1000;
        else timerDuration = 15 * 60 * 1000;

        const question = await getQuestionByDifficulty(difficulty);
        if (!question) {
            console.error(`No question for difficulty ${difficulty}. Cannot create match.`);
            return;
        }

        try {
            const newMatch = await prisma.match.create({
                data: { playerAId: player1.id, playerBId: player2.id, problemId: question.id, status: 'ONGOING' },
            });

            const matchId = newMatch.id;
            const startTime = Date.now();
            const keys = getRedisKeys();

            const matchDetails = {
                id: matchId, players: [player1.id, player2.id], problemId: question.id,
                startTime, duration: timerDuration, difficulty
            };

            const multi = redis.multi()
                .zrem(keys.readyQueue, player1.id, player2.id)
                .hset(keys.matches, matchId, JSON.stringify(matchDetails));

            player1.status = 'in-match';
            multi.hset(keys.participants, player1.id, JSON.stringify(player1));
            
            const p2DataStr = await redis.hget(keys.participants, player2.id);
            if(p2DataStr) {
                const p2Data = JSON.parse(p2DataStr);
                p2Data.status = 'in-match';
                multi.hset(keys.participants, player2.id, JSON.stringify(p2Data));
            }

            await multi.exec();
            console.log(`[Match Created] ${matchId} between ${player1.id} and ${player2.id}`);

            startMatchTimer(matchId, timerDuration);

            const questionData = {
                id: question.id, title: question.title, description: question.description,
                difficulty: question.difficulty, constraints: question.constraints || [],
                boilerplate: question.boilerplate || {}, sampleTestCases: question.sampleTestCases?.testCases || [],
                hints: question.hints || [],
            };

            const matchPayload = { opponent: {}, question: questionData, startTime, duration: timerDuration };
            
            const socket1 = io.sockets.sockets.get(player1.socketId);
            const socket2 = io.sockets.sockets.get(JSON.parse(p2DataStr).socketId);

            const matchRoom = `match:${matchId}`;
            if (socket1) {
                socket1.join(matchRoom);
                socket1.emit('round1:matchFound', { ...matchPayload, opponent: { id: player2.id, rank: player2.rank } });
            }
            if (socket2) {
                socket2.join(matchRoom);
                socket2.emit('round1:matchFound', { ...matchPayload, opponent: { id: player1.id, rank: player1.rank } });
            }

        } catch (error) {
            console.error("[Create Match Error]", error);
        }
    };

    const handleMatchEnd = async (matchId, winnerId) => {
        const keys = getRedisKeys();
        const matchStr = await redis.hget(keys.matches, matchId);
        if (!matchStr) return; // Match already handled
        const match = JSON.parse(matchStr);

        console.log(`[Match End] Match ${matchId} ended. Winner: ${winnerId || 'Timeout'}.`);

        await prisma.match.update({
            where: { id: matchId },
            data: { status: 'COMPLETED', winnerId },
        });

        const allUsers = await prisma.user.findMany({
            select: { id: true, username: true, eventScore: true },
            orderBy: [{ eventScore: 'desc' }, { username: 'asc' }]
        });

        for (const playerId of match.players) {
            const playerStr = await redis.hget(keys.participants, playerId);
            if (!playerStr) continue;
            
            const player = JSON.parse(playerStr);
            const userRank = allUsers.findIndex(u => u.id === playerId) + 1;
            player.rank = userRank;
            player.status = 'cooldown';
            player.cooldownStartTime = Date.now();
            await redis.hset(keys.participants, playerId, JSON.stringify(player));

            const playerSocket = io.sockets.sockets.get(player.socketId);
            if (playerSocket) {
                playerSocket.emit('round1:matchEnd', {
                    type: winnerId ? (playerId === winnerId ? 'win' : 'lose') : 'timeout',
                    message: winnerId ? (playerId === winnerId ? 'You won!' : 'You lost.') : "Time's up!",
                });
                playerSocket.emit('round1:cooldown', {
                    duration: COOLDOWN_DURATION,
                    startTime: player.cooldownStartTime
                });
            }

            // FIXED: Start robust cooldown timer
            await startCooldownTimer(playerId, COOLDOWN_DURATION, player.cooldownStartTime);
        }

        await redis.hdel(keys.matches, matchId);

        if (!isFirstMatchCycleCompleted) {
            isFirstMatchCycleCompleted = true;
            clearInterval(matchmakingInterval);
            matchmakingInterval = setInterval(runMatchmakingCycle, POST_MATCH_MATCHMAKING_INTERVAL);
            console.log(`[Matchmaking] Switched to ${POST_MATCH_MATCHMAKING_INTERVAL / 60000} minute interval.`);
            
            // Notify all clients that first cycle is complete
            io.emit('round1:firstCycleComplete');
        }

        // Broadcast updated participant list
        await broadcastLobbyUpdate();
    };

    const endRound = async () => {
        console.log("--- GLOBAL TIMER EXPIRED: ROUND 1 HAS ENDED ---");
        
        // Clear all timers
        if(matchmakingInterval) clearInterval(matchmakingInterval);
        if(globalTimer) clearTimeout(globalTimer);
        if(globalTimerInterval) clearInterval(globalTimerInterval);
        if(matchmakingCycleInterval) clearInterval(matchmakingCycleInterval);
        
        // Clear all cooldown timers
        cooldownTimers.forEach(timer => {
            if (timer.interval) clearInterval(timer.interval);
            if (timer.timeout) clearTimeout(timer.timeout);
        });
        cooldownTimers.clear();
        
        await redis.set(getRedisKeys().status, "ended");
        io.emit('round1:ended');
    };

    // FIXED: Enhanced getState with better cooldown handling
    socket.on('round1:getState', async (payload, callback) => {
        const validation = validateUser();
        if (validation.error) return callback?.({ success: false, error: validation.error });
        const { userId } = validation;
        
        try {
            const keys = getRedisKeys();
            
            // First, try to get user's participant data
            let participantStr = await redis.hget(keys.participants, userId);
            let participant = null;
            
            // If user not found in participants, check if they should be auto-joined
            if (!participantStr) {
                console.log(`[GetState] User ${userId} not found in participants, attempting auto-join...`);
                
                // Check if round is active and user exists in database
                const userData = await prisma.user.findUnique({ where: { id: validation.email } });
                if (!userData) {
                    return callback?.({ success: false, error: 'User not found in database.' });
                }
                
                const currentStatus = await redis.get(keys.status);
                if (currentStatus === "ended") {
                    return callback?.({ success: false, error: 'Round 1 has ended.' });
                }
                
                // Auto-join user to round (this handles refresh scenario)
                const allUsers = await prisma.user.findMany({ orderBy: [{ eventScore: 'desc' }, { username: 'asc' }] });
                const userRank = allUsers.findIndex(u => u.id === validation.email) + 1;

                const newParticipant = {
                    id: userId, socketId: socket.id, username: userData.username,
                    rank: userRank, originalScore: userData.eventScore || 0,
                    status: currentStatus === "running" ? 'waiting' : 'lobby', 
                    joinedAt: new Date().toISOString()
                };
                
                if (currentStatus === "running") {
                    newParticipant.waitingSince = Date.now();
                    await redis.zadd(keys.readyQueue, userRank, userId);
                }
                
                await redis.hset(keys.participants, userId, JSON.stringify(newParticipant));
                participant = newParticipant;
                console.log(`[GetState] Auto-joined ${userId} to round with status: ${newParticipant.status}`);
            } else {
                participant = JSON.parse(participantStr);
                // FIXED: Always update socket ID on reconnection to ensure proper communication
                if (participant.socketId !== socket.id) {
                    console.log(`[GetState] Updating socket ID for ${userId}: ${participant.socketId} -> ${socket.id}`);
                    participant.socketId = socket.id;
                    await redis.hset(keys.participants, userId, JSON.stringify(participant));
                }
            }

            const allParticipantsData = await redis.hgetall(keys.participants);
            const round1Participants = Object.values(allParticipantsData).map(p => JSON.parse(p));
            const queueSize = await redis.zcard(keys.readyQueue);
            const currentStatus = await redis.get(keys.status);
            const isActive = currentStatus === "running";
            
            // Get round start time and calculate current time remaining
            let roundStartTime = null;
            let globalTimeRemaining = 0;
            if (isActive) {
                const startTimeStr = await redis.get(`${keys.status}:startTime`);
                if (startTimeStr) {
                    roundStartTime = parseInt(startTimeStr);
                    const elapsed = Math.floor((Date.now() - roundStartTime) / 1000);
                    globalTimeRemaining = Math.max(0, Math.floor(ROUND_DURATION / 1000) - elapsed);
                    
                    // Ensure timer broadcasts are running for active round
                    if (!globalTimerInterval) {
                        console.log(`[GetState] Starting timer broadcasts for active round`);
                        startGlobalTimerBroadcast(roundStartTime);
                        startMatchmakingCycleBroadcast();
                    }
                }
            }
            
            // Handle reconnection for users already in matches
            if (participant.status === 'in-match') {
                const matches = await redis.hgetall(keys.matches);
                for (const matchId in matches) {
                    const match = JSON.parse(matches[matchId]);
                    if (match.players.includes(userId)) {
                        socket.join(`match:${matchId}`);
                        console.log(`[Reconnect] ${userId} rejoined match ${matchId}`);
                        break;
                    }
                }
            }

            // BULLETPROOF: Simple cooldown handling - calculation only, no complex timers
            let cooldownTimeRemaining = null;
            
            if (participant.status === 'cooldown') {
                console.log(`[GetState] User ${userId} is in cooldown`);
                
                if (participant.cooldownStartTime) {
                    const remaining = getCooldownTimeRemaining(participant.cooldownStartTime);
                    console.log(`[GetState] Cooldown time remaining: ${remaining}s`);
                    
                    if (remaining > 0) {
                        // Still in cooldown
                        cooldownTimeRemaining = remaining;
                        console.log(`[GetState] ✅ Returning ${remaining}s cooldown to frontend`);
                    } else {
                        // Cooldown expired
                        console.log(`[GetState] Cooldown expired, updating to waiting`);
                        participant.status = 'waiting';
                        participant.waitingSince = Date.now();
                        delete participant.cooldownStartTime;
                        
                        await redis.hset(keys.participants, userId, JSON.stringify(participant));
                        
                        const currentStatus = await redis.get(keys.status);
                        if (currentStatus === "running") {
                            await redis.zadd(keys.readyQueue, participant.rank, userId);
                        }
                        
                        cooldownTimeRemaining = null;
                        await broadcastLobbyUpdate();
                    }
                } else {
                    // No start time - reset status
                    console.warn(`[GetState] No cooldown start time, resetting status`);
                    participant.status = isActive ? 'waiting' : 'lobby';
                    if (isActive) {
                        participant.waitingSince = Date.now();
                        await redis.zadd(keys.readyQueue, participant.rank, userId);
                    }
                    await redis.hset(keys.participants, userId, JSON.stringify(participant));
                    cooldownTimeRemaining = null;
                }
            }

            // Calculate next matchmaking cycle time
            let nextMatchmakingCycle = null;
            if (isActive) {
                if (isFirstMatchCycleCompleted) {
                    // Regular 3-minute cycles
                    const cycleInterval = 3 * 60;
                    const now = Math.floor(Date.now() / 1000);
                    nextMatchmakingCycle = cycleInterval - (now % cycleInterval);
                } else {
                    // Initial 5-second cycles
                    const cycleInterval = 5;
                    const now = Math.floor(Date.now() / 1000);
                    nextMatchmakingCycle = cycleInterval - (now % cycleInterval);
                }
            }

            // FIXED: Always include comprehensive state information for frontend
            callback?.({
                success: true,
                participant,
                isActive,
                round1Participants,
                queueSize,
                roundStartTime,
                globalTimeRemaining,
                cooldownTimeRemaining,
                nextMatchmakingCycle,
                isFirstCycle: !isFirstMatchCycleCompleted,
                // Additional debugging info
                currentStatus: await redis.get(keys.status),
                userInQueue: await redis.zscore(keys.readyQueue, userId) !== null
            });
            
            // Broadcast updated lobby after potential auto-join
            await broadcastLobbyUpdate();
            
        } catch (error) {
            console.error('[GetState Error]', error);
            callback?.({ success: false, error: 'Server error fetching state.' });
        }
    });

    socket.on('round1:join', async (payload, callback) => {
        const validation = validateUser();
        if (validation.error) {
            console.error(`[Join] Validation failed: ${validation.error}`);
            return callback?.({ success: false, error: validation.error });
        }
        const { userId, email } = validation;

        console.log(`[Join] User ${userId} attempting to join round 1`);
        
        const keys = getRedisKeys();
        const currentStatus = await redis.get(keys.status);
        console.log(`[Join] Current round status: ${currentStatus}`);
        
        if (currentStatus === "ended") {
            return callback?.({ success: false, error: 'Round 1 has ended.' });
        }

        if (disconnectTimers.has(userId)) {
            clearTimeout(disconnectTimers.get(userId));
            disconnectTimers.delete(userId);
            console.log(`[Reconnect] Cleared disconnect timer for ${userId}.`);
        }

        const participantStr = await redis.hget(keys.participants, userId);
        if (participantStr) {
            const participant = JSON.parse(participantStr);
            participant.socketId = socket.id;
            await redis.hset(keys.participants, userId, JSON.stringify(participant));
            console.log(`[Connection] ${userId} reconnected with status: ${participant.status}`);

            if (participant.status === 'in-match') {
                const matches = await redis.hgetall(keys.matches);
                for (const matchId in matches) {
                    const match = JSON.parse(matches[matchId]);
                    if (match.players.includes(userId)) {
                        socket.join(`match:${matchId}`);
                        console.log(`[Reconnect] ${userId} rejoined match ${matchId}`);
                        
                        // Send them back to the match with current data
                        const problem = await prisma.problem.findUnique({ where: { id: match.problemId } });
                        if (problem) {
                            const questionData = {
                                id: problem.id, title: problem.title, description: problem.description,
                                difficulty: problem.difficulty, constraints: problem.constraints || [],
                                boilerplate: problem.boilerplate || {}, sampleTestCases: problem.sampleTestCases?.testCases || [],
                                hints: problem.hints || [],
                            };
                            
                            const opponentId = match.players.find(pId => pId !== userId);
                            const matchPayload = { 
                                opponent: { id: opponentId }, 
                                question: questionData, 
                                startTime: match.startTime, 
                                duration: match.duration 
                            };
                            
                            // Emit matchFound to redirect them back to the match
                            socket.emit('round1:matchFound', matchPayload);
                        }
                        break;
                    }
                }
            }
            // FIXED: Restart cooldown timer for reconnected users in cooldown
            else if (participant.status === 'cooldown' && participant.cooldownStartTime) {
                const remaining = getCooldownTimeRemaining(participant.cooldownStartTime);
                if (remaining > 0 && !cooldownTimers.has(userId)) {
                    console.log(`[Reconnect] Restarting cooldown timer for ${userId}: ${remaining}s remaining`);
                    await startCooldownTimer(userId, COOLDOWN_DURATION, participant.cooldownStartTime);
                }
            }
        } else {
            const userData = await prisma.user.findUnique({ where: { id: email } });
            if (!userData) return callback?.({ success: false, error: 'User not found.' });

            const allUsers = await prisma.user.findMany({ orderBy: [{ eventScore: 'desc' }, { username: 'asc' }] });
            const userRank = allUsers.findIndex(u => u.id === email) + 1;

            const newParticipant = {
                id: userId, socketId: socket.id, username: userData.username,
                rank: userRank, originalScore: userData.eventScore || 0,
                status: 'lobby', joinedAt: new Date().toISOString()
            };
            await redis.hset(keys.participants, userId, JSON.stringify(newParticipant));
            console.log(`[Lobby] ${userId} (Rank: ${userRank}) joined.`);
        }
        await broadcastLobbyUpdate();
        callback?.({ success: true, message: 'Joined Round 1 lobby.' });
    });

    socket.on('round1:ready', async (payload, callback) => {
        const validation = validateUser();
        if (validation.error) return callback?.({ success: false, error: validation.error });
        
        // Check admin status from database only (more reliable)
        const userData = await prisma.user.findUnique({ where: { id: validation.email } });
        if (!userData) {
            return callback?.({ success: false, error: 'User not found in database.' });
        }
        
        if (userData.role !== 'ADMIN') {
            console.log(`Non-admin user ${validation.email} tried to start round. User role: ${userData.role}`);
            return callback?.({ success: false, error: 'Unauthorized - Admin access required.' });
        }

        const keys = getRedisKeys();
        if (await redis.get(keys.status) === 'running') return callback?.({ success: false, error: 'Round already running.' });

        console.log(`--- ADMIN (${validation.email}): Round 1 is starting! ---`);
        await redis.set(keys.status, "running");
        
        // Store round start time for global timer
        const roundStartTime = Date.now();
        await redis.set(`${keys.status}:startTime`, roundStartTime);
        
        // FIXED: Properly update all participants from lobby to waiting status
        const participants = await redis.hgetall(keys.participants);
        const multi = redis.multi();
        let updatedCount = 0;
        
        Object.values(participants).forEach(pStr => {
            const p = JSON.parse(pStr);
            if (p.status === 'lobby') {
                p.status = 'waiting';
                p.waitingSince = Date.now();
                multi.hset(keys.participants, p.id, JSON.stringify(p));
                multi.zadd(keys.readyQueue, p.rank, p.id);
                updatedCount++;
                console.log(`[Round Start] Updated ${p.id} from lobby to waiting`);
            }
        });
        
        await multi.exec();
        console.log(`[Round Start] Updated ${updatedCount} participants from lobby to waiting status`);

        isFirstMatchCycleCompleted = false;
        matchmakingInterval = setInterval(runMatchmakingCycle, INITIAL_MATCHMAKING_INTERVAL);
        globalTimer = setTimeout(endRound, ROUND_DURATION);
        
        // Start all backend timer broadcasts
        startGlobalTimerBroadcast(roundStartTime);
        startMatchmakingCycleBroadcast();
        
        // FIXED: Broadcast round start and updated participant list
        io.emit('round1:started', { roundStartTime, roundDuration: ROUND_DURATION });
        
        // Broadcast updated participant list to ensure all clients see status changes
        await broadcastLobbyUpdate();
        
        callback?.({ success: true, message: 'Round 1 started successfully.' });
    });

    socket.on('disconnect', async () => {
        const validation = validateUser();
        if (validation.error) return;
        const { userId } = validation;

        const keys = getRedisKeys();
        const participantStr = await redis.hget(keys.participants, userId);
        if (!participantStr) return;
        
        const participant = JSON.parse(participantStr);
        console.log(`[Disconnect] ${userId} disconnected.`);

        if (participant.status === 'in-match') {
            const matches = await redis.hgetall(keys.matches);
            for (const matchId in matches) {
                const match = JSON.parse(matches[matchId]);
                if (match.players.includes(userId)) {
                    const opponentId = match.players.find(pId => pId !== userId);
                    console.log(`[Disconnect] Starting ${DISCONNECT_TIMEOUT/1000}s timer for ${userId}.`);
                    
                    const timeoutId = setTimeout(() => {
                        console.log(`[Disconnect] Timer expired for ${userId}. ${opponentId} wins.`);
                        handleMatchEnd(matchId, opponentId);
                        disconnectTimers.delete(userId);
                    }, DISCONNECT_TIMEOUT);
                    disconnectTimers.set(userId, timeoutId);
                    return;
                }
            }
        }
        // If not in match, or no match found, remove them cleanly.
        await redis.hdel(keys.participants, userId);
        await redis.zrem(keys.readyQueue, userId);
        
        // FIXED: Clear cooldown timer if user disconnects during cooldown
        if (cooldownTimers.has(userId)) {
            const timer = cooldownTimers.get(userId);
            if (timer.interval) clearInterval(timer.interval);
            if (timer.timeout) clearTimeout(timer.timeout);
            cooldownTimers.delete(userId);
            console.log(`[Disconnect] Cleared cooldown timer for ${userId}`);
        }
        
        await broadcastLobbyUpdate();
    });

    socket.on('round1:reset', async (payload, callback) => {
        const validation = validateUser();
        if (validation.error) return callback?.({ success: false, error: validation.error });

        // Check admin status from database only (more reliable)
        const userData = await prisma.user.findUnique({ where: { id: validation.email } });
        if (!userData) {
            return callback?.({ success: false, error: 'User not found in database.' });
        }
        
        if (userData.role !== 'ADMIN') {
            console.log(`Non-admin user ${validation.email} tried to reset round. User role: ${userData.role}`);
            return callback?.({ success: false, error: 'Unauthorized - Admin access required.' });
        }

        const success = await resetRoundState();
        if (success) {
            io.emit('round1:reset');
            callback?.({ success: true, message: 'Round 1 reset successfully.' });
        } else {
            callback?.({ success: false, error: 'Failed to reset round.' });
        }
    });

    round1MatchEndHandler = handleMatchEnd;
};

export const getRound1MatchEndHandler = () => round1MatchEndHandler;