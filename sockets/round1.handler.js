/**
 * ROUND 1 SOCKET HANDLER
 * 
 * CLIENT → SERVER EVENTS:
 * - round1:join - Join round lobby
 * - round1:ready - Start round (admin only)  
 * - round1:getState - Get current game state
 * - round1:reset - Reset round (admin only)
 * - disconnect - Handle user disconnect
 * 
 * SERVER → CLIENT EVENTS:
 * - lobby:round1 - Lobby participant updates
 * - round1:started - Round officially started
 * - round1:matchFound - Match found with opponent and question
 * - round1:cooldown - Match ended, cooldown period started
 * - round1:ended - Round ended (90min timer)
 * - match:pause - Match paused due to opponent disconnect
 * - match:resume - Match resumed after opponent reconnect
 * 
 * REDIS KEYS:
 * - round1:participants - Hash of participants {userId: participantData}
 * - round1:readyQueue - Sorted set of ready players (score=rank)
 * - round1:matches - Hash of active matches {matchId: matchData}
 * - round1:status - Round status ("running" | "ended")
 * 
 * ROUND 1 FLOW:
 * 1. Lobby Phase: Users join and wait for admin to start
 * 2. Matchmaking Phase: 90min timer, continuous 5sec matchmaking cycles
 * 3. Match Phase: 1v1 matches with difficulty-based timers (15/20/25min)
 * 4. Cooldown Phase: 2min cooldown after each match
 * 5. Re-queue Phase: Back to matchmaking queue automatically
 * 
 * DIFFICULTY TIERS:
 * - G1 (Top third): Hard questions, 25min timer
 * - G2 (Middle third): Medium questions, 20min timer  
 * - G3 (Bottom third): Easy questions, 15min timer
 * 
 * SPECIAL HANDLING:
 * - Long wait (>5min): Force match with lower difficulty
 * - Odd numbers: Balance between groups, use bots if needed
 * - Disconnections: 1min timeout, opponent auto-wins
 */

import redis from "../config/redis.js";
import prisma from "../config/prisma.js";

// Constants
const ROUND_DURATION = 90 * 60 * 1000; // 90 minutes in milliseconds
const ROUND_NUMBER = 1;
const MATCHMAKING_INTERVAL = 5000; // 5 seconds
const COOLDOWN_DURATION = 2 * 60 * 1000; // 2 minutes
const DISCONNECT_TIMEOUT = 1 * 60 * 1000; // 1 minute
const LONG_WAIT_THRESHOLD = 5 * 60 * 1000; // 5 minutes

// In-memory map for disconnect timeouts, as they are process-specific.
const disconnectTimers = new Map();

// Global variables for round management
let globalTimer = null;
let matchmakingInterval = null;

// Store handleMatchEnd function globally so it can be accessed from external routes
let round1MatchEndHandler = null;

// --- Main Handler ---
export const round1Handler = (io, socket) => {

    // --- Utility Functions ---

    /**
     * Validates the current user from socket
     * @returns {object} Object with userId/email or error
     */
    const validateUser = () => {
        const userId = socket.user?.id;
        const email = socket.user?.email;
        if (!userId || !email) {
            return { error: 'Unauthorized - No user ID or email' };
        }
        return { userId, email };
    };

    /**
     * Gets Redis keys for Round 1
     * @param {string} userId - Optional user ID for user-specific keys
     * @returns {object} Object with Redis key names
     */
    const getRedisKeys = (userId = null) => ({
        participants: `round${ROUND_NUMBER}:participants`,
        readyQueue: `round${ROUND_NUMBER}:readyQueue`,
        matches: `round${ROUND_NUMBER}:matches`,
        status: `round${ROUND_NUMBER}:status`,
        presence: userId ? `round${ROUND_NUMBER}:user:${userId}` : null
    });

    /**
     * Broadcasts lobby update to all participants
     */
    const broadcastLobbyUpdate = async () => {
        try {
            const keys = getRedisKeys();
            const allParticipants = await redis.hgetall(keys.participants);
            const lobbyParticipants = Object.values(allParticipants)
                .map(p => JSON.parse(p))
                .filter(p => p.status === 'lobby');
            
            const currentStatus = await redis.get(keys.status);
            
            io.emit('lobby:round1', { 
                participants: lobbyParticipants,
                totalParticipants: lobbyParticipants.length,
                isActive: currentStatus === "running"
            });
        } catch (error) {
            console.error('[Broadcast Error] Failed to broadcast lobby update:', error);
        }
    };

    /**
     * Resets round state (admin only)
     */
    const resetRoundState = async () => {
        try {
            console.log("[Reset] Resetting Round 1 state...");
            
            // Clear timers
            if (globalTimer) {
                clearTimeout(globalTimer);
                globalTimer = null;
            }
            if (matchmakingInterval) {
                clearInterval(matchmakingInterval);
                matchmakingInterval = null;
            }
            
            // Clear disconnect timers
            disconnectTimers.forEach(timer => clearTimeout(timer));
            disconnectTimers.clear();
            
            // Clear Redis data
            const keys = getRedisKeys();
            await redis.del(keys.participants, keys.readyQueue, keys.matches, keys.status);
            
            // Reset database status
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

    /**
     * Fetches a random problem of a given difficulty for Round 1 from the database.
     * @param {('R1_EASY'|'R1_MEDIUM'|'R1_HARD')} difficulty - The difficulty level.
     * @returns {Promise<object|null>} A problem object or null if none are found.
     */
    const getQuestionByDifficulty = async (difficulty) => {
        try {
            const problems = await prisma.problem.findMany({
                where: {
                    roundId: 1,
                    difficulty: difficulty,
                },
            });

            if (problems.length === 0) {
                console.error(`[DB Error] No problems found for Round 1 with difficulty ${difficulty}`);
                return null;
            }
            // Return a random problem from the list
            return problems[Math.floor(Math.random() * problems.length)];
        } catch (error) {
            console.error("[Prisma Error] Failed to fetch question:", error);
            return null;
        }
    };

    /**
     * The core matchmaking logic. Runs periodically to create matches.
     */
    const runMatchmakingCycle = async () => {
        try {
            const queueSize = await redis.zcard("round1:readyQueue");
            if (queueSize < 1) return;

            console.log(`[Matchmaking] Running cycle with ${queueSize} players in queue.`);
            
            // Fetch all players from the ready queue, sorted by rank
            const waitingPlayerIds = await redis.zrange("round1:readyQueue", 0, -1);
            if (waitingPlayerIds.length === 0) return;

            const playerPipelines = waitingPlayerIds.map(id => redis.hget("round1:participants", id));
            const results = await Promise.all(playerPipelines);
            let waitingPlayers = results.map(p => JSON.parse(p)).filter(Boolean);


            // 1. Handle long-waiting players first (> 5 minutes)
            const now = Date.now();
            const longWaiters = waitingPlayers.filter(p => (now - p.waitingSince) > LONG_WAIT_THRESHOLD);
            let normalWaiters = waitingPlayers.filter(p => (now - p.waitingSince) <= LONG_WAIT_THRESHOLD);
            
            while (longWaiters.length >= 2) {
                const player1 = longWaiters.shift();
                const player2 = longWaiters.shift();
                console.log(`[Matchmaking] Force-matching long-waiting players: ${player1.id} and ${player2.id}`);
                // Use the difficulty of the lower-ranked player's group
                const lowerRank = Math.max(player1.rank, player2.rank);
                const totalPlayers = normalWaiters.length + longWaiters.length + 2; // +2 for current pair
                const third = Math.ceil(totalPlayers / 3);
                let difficulty;
                if (lowerRank <= third) difficulty = 'R1_HARD';
                else if (lowerRank <= 2 * third) difficulty = 'R1_MEDIUM';
                else difficulty = 'R1_EASY';
                
                await createMatch(player1, player2, difficulty);
            }
            normalWaiters.push(...longWaiters);

            if (normalWaiters.length < 2) {
                if (normalWaiters.length === 1) {
                    console.log(`[Matchmaking] Only one player left. Matching ${normalWaiters[0].id} with bot.`);
                    await createMatch(normalWaiters[0], { id: 'Team-Bot', rank: normalWaiters[0].rank }, 'R1_EASY');
                }
                return;
            }

            // 2. Group remaining players by rank (already sorted from Redis ZRANGE)
            const third = Math.ceil(normalWaiters.length / 3);
            let g1 = normalWaiters.slice(0, third);      // Hard
            let g2 = normalWaiters.slice(third, 2 * third); // Medium
            let g3 = normalWaiters.slice(2 * third);    // Easy

            // 3. Balance groups - move players to handle odd numbers
            if (g1.length % 2 !== 0 && g2.length % 2 !== 0) {
                g2.unshift(g1.pop()); // Move lowest from G1 to G2
            }
            if (g2.length % 2 !== 0 && g3.length % 2 !== 0) {
                g3.unshift(g2.pop()); // Move lowest from G2 to G3
            }

            // 4. Create matches for each group
            const processGroup = async (group, difficulty) => {
                while (group.length >= 2) {
                    await createMatch(group.shift(), group.shift(), difficulty);
                }
                // Match remaining single player with bot
                if (group.length === 1) {
                    const lastPlayer = group.shift();
                    await createMatch(lastPlayer, { id: 'Team-Bot', rank: lastPlayer.rank }, difficulty);
                }
            };

            await Promise.all([
                processGroup(g1, 'R1_HARD'),
                processGroup(g2, 'R1_MEDIUM'),
                processGroup(g3, 'R1_EASY')
            ]);
        } catch (error) {
            console.error("[Matchmaking Error]", error);
        }
    };

    /**
     * Creates a match, saves it to the DB, updates Redis state, and notifies clients.
     * @param {object} player1 - The first player's participant object.
     * @param {object} player2 - The second player's participant object or a Bot object.
     * @param {( 'R1_EASY'|'R1_MEDIUM'|'R1_HARD')} difficulty - The difficulty for the match.
     */
    const createMatch = async (player1, player2, difficulty) => {
        const question = await getQuestionByDifficulty(difficulty);
        if (!question) {
            console.error(`Could not create match, no question found for difficulty ${difficulty}`);
            return;
        }

        // Get timer duration based on difficulty
        let timerDuration;
        switch (difficulty) {
            case 'R1_HARD':
                timerDuration = 25 * 60 * 1000; // 25 minutes
                break;
            case 'R1_MEDIUM':
                timerDuration = 20 * 60 * 1000; // 20 minutes
                break;
            case 'R1_EASY':
                timerDuration = 15 * 60 * 1000; // 15 minutes
                break;
            default:
                timerDuration = 20 * 60 * 1000; // Default to 20 minutes
        }

        try {
            // Create the match record in the database
            const newMatch = await prisma.match.create({
                data: {
                    playerAId: player1.id,
                    playerBId: player2.id, // Assuming 'Team-Bot' is a valid placeholder or special user ID
                    problemId: question.id,
                    status: 'ONGOING',
                },
            });
            const matchId = newMatch.id;

            // Update state in Redis
            const redisMulti = redis.multi();
            redisMulti.zrem("round1:readyQueue", player1.id);
            if (player2.id !== 'Team-Bot') {
                redisMulti.zrem("round1:readyQueue", player2.id);
            }
            
            player1.status = 'in-match';
            redisMulti.hset("round1:participants", player1.id, JSON.stringify(player1));

            if (player2.id !== 'Team-Bot') {
                 const p2DataStr = await redis.hget("round1:participants", player2.id);
                 if(p2DataStr) {
                    const p2Data = JSON.parse(p2DataStr);
                    p2Data.status = 'in-match';
                    redisMulti.hset("round1:participants", player2.id, JSON.stringify(p2Data));
                 }
            }
            
            const matchDetails = { id: matchId, players: [player1.id, player2.id], problemId: question.id, startTime: Date.now(), difficulty: difficulty };
            redisMulti.hset("round1:matches", matchId, JSON.stringify(matchDetails));
            
            await redisMulti.exec();

            console.log(`[Match] Created in DB: ${matchId} between ${player1.id} and ${player2.id} with ${difficulty} difficulty`);

            // Notify players
            const questionData = { id: question.id, title: question.title, description: question.description, difficulty: question.difficulty, duration: timerDuration };
            const socket1 = io.sockets.sockets.get(player1.socketId);
            if (socket1) {
                socket1.emit('round1:matchFound', { opponent: { id: player2.id, rank: player2.rank }, question: questionData, timer: timerDuration / 1000 });
            }
            if (player2.id !== 'Team-Bot') {
                const p2Data = JSON.parse(await redis.hget("round1:participants", player2.id));
                const socket2 = io.sockets.sockets.get(p2Data.socketId);
                if (socket2) {
                    socket2.emit('round1:matchFound', { opponent: { id: player1.id, rank: player1.rank }, question: questionData, timer: timerDuration / 1000 });
                }
            }
        } catch (error) {
            console.error("[Create Match Error]", error);
        }
    };

    /**
     * Handles the end of a match. Should be exposed to be callable from an API route.
     * @param {string} matchId The ID of the match that ended.
     * @param {string} winnerId The user ID of the winning player.
     */
    const handleMatchEnd = async (matchId, winnerId) => {
        const matchStr = await redis.hget("round1:matches", matchId);
        if (!matchStr) return;
        const match = JSON.parse(matchStr);

        console.log(`[Match] Match ${matchId} ended. Winner: ${winnerId}.`);

        // Update match in DB
        await prisma.match.update({
            where: { id: matchId },
            data: { status: 'COMPLETED', winnerId: winnerId },
        });

        // Update players to cooldown status in Redis
        for (const playerId of match.players) {
            if (playerId === 'Team-Bot') continue;
            
            const playerStr = await redis.hget("round1:participants", playerId);
            if (!playerStr) continue;

            const player = JSON.parse(playerStr);
            player.status = 'cooldown';
            await redis.hset("round1:participants", playerId, JSON.stringify(player));
            
            const playerSocket = io.sockets.sockets.get(player.socketId);
            if (playerSocket) playerSocket.emit('round1:cooldown');

            // Set timeout to return them to the queue
            setTimeout(async () => {
                const latestPlayerStr = await redis.hget("round1:participants", playerId);
                if (!latestPlayerStr) return;

                const latestPlayer = JSON.parse(latestPlayerStr);
                if (latestPlayer.status === 'cooldown') {
                    latestPlayer.status = 'waiting';
                    latestPlayer.waitingSince = Date.now();
                    await redis.hset("round1:participants", playerId, JSON.stringify(latestPlayer));
                    await redis.zadd("round1:readyQueue", latestPlayer.rank, playerId);
                    console.log(`[Cooldown] Player ${playerId} is back in the matchmaking queue.`);
                }
            }, COOLDOWN_DURATION); // 2-minute cooldown
        }
        
        // Clean up match from Redis
        await redis.hdel("round1:matches", matchId);
    };

    /**
     * Ends the entire round.
     */
    const endRound = async () => {
        console.log("--- GLOBAL TIMER EXPIRED: ROUND 1 HAS ENDED ---");
        clearInterval(matchmakingInterval);
        clearTimeout(globalTimer);
        await redis.set("round1:status", "ended");
        io.emit('round1:ended');
    };

    // --- Client → Server Event Handlers ---

    /**
     * Handle round1:getState - Get current game state
     */
    const handleGetState = async (payload, callback) => {
        const validation = validateUser();
        if (validation.error) {
            return callback?.({ success: false, error: validation.error });
        }
        const { userId } = validation;

        try {
            const keys = getRedisKeys();
            const currentStatus = await redis.get(keys.status);
            const participantStr = await redis.hget(keys.participants, userId);
            
            if (!participantStr) {
                return callback?.({ 
                    success: false, 
                    error: 'User not found in Round 1' 
                });
            }

            const participant = JSON.parse(participantStr);
            
            let matchData = null;
            let timeRemaining = 0;

            // If user is in match, get match details
            if (participant.status === 'in-match') {
                const allMatches = await redis.hgetall(keys.matches);
                const matchEntry = Object.entries(allMatches).find(([, mStr]) => {
                    const match = JSON.parse(mStr);
                    return match.players.includes(userId);
                });

                if (matchEntry) {
                    const [matchId, matchStr] = matchEntry;
                    const match = JSON.parse(matchStr);
                    
                    // Get question details
                    const question = await prisma.problem.findUnique({ 
                        where: { id: match.problemId } 
                    });
                    
                    if (question) {
                        let timerDuration;
                        switch (match.difficulty) {
                            case 'R1_HARD': timerDuration = 25 * 60 * 1000; break;
                            case 'R1_MEDIUM': timerDuration = 20 * 60 * 1000; break;
                            case 'R1_EASY': timerDuration = 15 * 60 * 1000; break;
                            default: timerDuration = 20 * 60 * 1000;
                        }
                        
                        const elapsedTime = Date.now() - match.startTime;
                        timeRemaining = Math.max(0, timerDuration - elapsedTime);
                        
                        const opponentId = match.players.find(pId => pId !== userId);
                        
                        matchData = {
                            matchId,
                            opponent: { id: opponentId },
                            question: {
                                id: question.id,
                                title: question.title,
                                description: question.description,
                                difficulty: question.difficulty
                            },
                            timer: timeRemaining / 1000,
                            difficulty: match.difficulty
                        };
                    }
                }
            }

            // Calculate global time remaining if round is active
            let globalTimeRemaining = 0;
            if (currentStatus === "running") {
                // We'd need to store round start time in Redis to calculate this
                // For now, return a placeholder
                globalTimeRemaining = ROUND_DURATION / 1000; // TODO: Calculate actual remaining time
            }

            callback?.({
                success: true,
                participant,
                status: currentStatus || "lobby",
                isActive: currentStatus === "running",
                match: matchData,
                globalTimeRemaining,
                message: 'Current state retrieved successfully'
            });

        } catch (error) {
            console.error('[GetState Error]', error);
            callback?.({ success: false, error: 'Failed to retrieve game state' });
        }
    };

    socket.on('round1:join', async (payload, callback) => {
        const validation = validateUser();
        if (validation.error) {
            return callback?.({ success: false, error: validation.error });
        }
        const { userId, email } = validation;

        try {
            // Check if round has already ended
            const currentStatus = await redis.get(getRedisKeys().status);
            if (currentStatus === "ended") {
                return callback?.({ success: false, error: 'Round 1 has already ended' });
            }

            const keys = getRedisKeys();
            const participantStr = await redis.hget(keys.participants, userId);
            
            if (participantStr) {
                const participant = JSON.parse(participantStr);
                participant.socketId = socket.id;
                await redis.hset(keys.participants, userId, JSON.stringify(participant));
                console.log(`[Connection] Player ${userId} reconnected.`);

                // Handle reconnection during match
                if (participant.status === 'in-match' && disconnectTimers.has(userId)) {
                    clearTimeout(disconnectTimers.get(userId));
                    disconnectTimers.delete(userId);
                    console.log(`[Connection] Canceled disconnect timer for ${userId}.`);
                    
                    // Find the match and notify opponent about reconnection
                    const allMatches = await redis.hgetall(keys.matches);
                    const matchEntry = Object.entries(allMatches).find(([, mStr]) => JSON.parse(mStr).players.includes(userId));
                    if (matchEntry) {
                        const [matchId, matchStr] = matchEntry;
                        const match = JSON.parse(matchStr);
                        const opponentId = match.players.find(pId => pId !== userId);
                        
                        if (opponentId && opponentId !== 'Team-Bot') {
                            const opponentStr = await redis.hget(keys.participants, opponentId);
                            if(opponentStr) {
                                const opponent = JSON.parse(opponentStr);
                                const opponentSocket = io.sockets.sockets.get(opponent.socketId);
                                if (opponentSocket) {
                                    opponentSocket.emit('match:resume', { message: 'Opponent reconnected. Match resumed.' });
                                }
                            }
                        }
                        
                        // Send current match info to reconnected player
                        const question = await prisma.problem.findUnique({ where: { id: match.problemId } });
                        if (question) {
                            let timerDuration;
                            switch (match.difficulty) {
                                case 'R1_HARD': timerDuration = 25 * 60 * 1000; break;
                                case 'R1_MEDIUM': timerDuration = 20 * 60 * 1000; break;
                                case 'R1_EASY': timerDuration = 15 * 60 * 1000; break;
                                default: timerDuration = 20 * 60 * 1000;
                            }
                            
                            const elapsedTime = Date.now() - match.startTime;
                            const remainingTime = Math.max(0, timerDuration - elapsedTime);
                            
                            socket.emit('match:resume', { 
                                opponent: { id: opponentId }, 
                                question: { 
                                    id: question.id, 
                                    title: question.title, 
                                    description: question.description, 
                                    difficulty: question.difficulty 
                                }, 
                                timer: remainingTime / 1000 
                            });
                        }
                    }
                } else if (disconnectTimers.has(userId)) {
                    clearTimeout(disconnectTimers.get(userId));
                    disconnectTimers.delete(userId);
                    console.log(`[Connection] Canceled disconnect timer for ${userId}.`);
                }
            } else {
                // Fetch user data from database
                const userData = await prisma.user.findUnique({
                    where: { email },
                    select: { id: true, username: true, role: true, email: true, eventScore: true }
                });

                if (!userData) {
                    return callback?.({ success: false, error: 'User not found in database' });
                }

                const newParticipant = { 
                    id: userId, 
                    socketId: socket.id, 
                    username: userData.username || 'Anonymous',
                    rank: userData.eventScore || 999, 
                    status: 'lobby',
                    joinedAt: new Date().toISOString()
                };
                await redis.hset(keys.participants, userId, JSON.stringify(newParticipant));
                console.log(`[Lobby] User ${userId} (Rank: ${newParticipant.rank}) joined.`);
            }

            // Set user presence
            await redis.setex(getRedisKeys(userId).presence, 3600, 'online');

            await broadcastLobbyUpdate();
            
            callback?.({ 
                success: true, 
                message: 'Successfully joined Round 1 lobby'
            });

        } catch (error) {
            console.error('[Join Error]', error);
            callback?.({ success: false, error: 'Failed to join Round 1 lobby' });
        }
    });

    socket.on('round1:ready', async (payload, callback) => {
        const validation = validateUser();
        if (validation.error) {
            return callback?.({ success: false, error: validation.error });
        }
        const { userId, email } = validation;

        try {
            // Check if user is admin
            const userData = await prisma.user.findUnique({
                where: { email },
                select: { role: true }
            });

            if (!userData || userData.role !== 'ADMIN') {
                return callback?.({ success: false, error: 'Only admins can start Round 1' });
            }

            const keys = getRedisKeys();
            const currentStatus = await redis.get(keys.status);
            if (currentStatus === "running") {
                console.warn("[Admin] Round is already running.");
                return callback?.({ success: false, error: 'Round 1 is already running' });
            }

            // Check database status
            const round1DB = await prisma.round.findUnique({
                where: { roundNumber: 1 }
            });

            if (!round1DB || round1DB.status !== 'LOBBY') {
                return callback?.({ 
                    success: false, 
                    error: `Round 1 is not in LOBBY status. Current status: ${round1DB?.status || 'Not found'}` 
                });
            }

            console.log("--- ADMIN: Round 1 is starting now! ---");
            
            // Clear previous round data for a clean start
            await redis.del(keys.participants, keys.readyQueue, keys.matches);
            await redis.set(keys.status, "running");
            
            // Update database status
            await prisma.round.update({
                where: { roundNumber: 1 },
                data: { status: 'IN_PROGRESS' }
            });

            // Store round start time for global timer calculation
            const startTime = Date.now();
            await redis.setex(`round${ROUND_NUMBER}:startTime`, 3600, startTime.toString());

            globalTimer = setTimeout(endRound, ROUND_DURATION);

            // Get all current participants and move lobby participants to waiting
            const allParticipants = await redis.hgetall(keys.participants);
            const multi = redis.multi();
            let queueCount = 0;
            for (const userId in allParticipants) {
                const p = JSON.parse(allParticipants[userId]);
                if (p.status === 'lobby') {
                    p.status = 'waiting';
                    p.waitingSince = Date.now();
                    multi.hset(keys.participants, userId, JSON.stringify(p));
                    multi.zadd(keys.readyQueue, p.rank, userId);
                    queueCount++;
                }
            }
            await multi.exec();
            console.log(`[Queue] Moved ${queueCount} players to the matchmaking queue.`);

            matchmakingInterval = setInterval(runMatchmakingCycle, MATCHMAKING_INTERVAL);
            
            // Notify all clients that the round has started
            io.emit('round1:started', {
                message: 'Round 1 has started! Matchmaking in progress...',
                duration: ROUND_DURATION / 1000,
                startTime
            });

            callback?.({ 
                success: true, 
                message: `Round 1 started with ${queueCount} players`,
                duration: ROUND_DURATION / 1000
            });

        } catch (error) {
            console.error('[Ready Error]', error);
            callback?.({ success: false, error: 'Failed to start Round 1' });
        }
    });

    socket.on('disconnect', async () => {
        const validation = validateUser();
        if (validation.error) return;
        const { userId } = validation;

        try {
            const keys = getRedisKeys();
            const participantStr = await redis.hget(keys.participants, userId);
            if (!participantStr) return;

            const user = JSON.parse(participantStr);
            console.log(`[Connection] User ${user.id} disconnected.`);

            if (user.status === 'in-match') {
                const allMatches = await redis.hgetall(keys.matches);
                const matchEntry = Object.entries(allMatches).find(([, mStr]) => JSON.parse(mStr).players.includes(user.id));
                if (!matchEntry) return;

                const [matchId, matchStr] = matchEntry;
                const match = JSON.parse(matchStr);
                const opponentId = match.players.find(pId => pId !== user.id);

                // Notify opponent about the disconnection and pause the match
                if (opponentId && opponentId !== 'Team-Bot') {
                    const opponentStr = await redis.hget(keys.participants, opponentId);
                    if(opponentStr) {
                        const opponent = JSON.parse(opponentStr);
                        const opponentSocket = io.sockets.sockets.get(opponent.socketId);
                        if (opponentSocket) {
                            opponentSocket.emit('match:pause', { message: 'Opponent disconnected. Match paused for 1 minute.' });
                        }
                    }
                }

                // Set 1-minute timer for reconnection
                const timer = setTimeout(() => {
                    console.log(`[Disconnection] Player ${user.id} did not reconnect. Opponent ${opponentId} wins.`);
                    handleMatchEnd(matchId, opponentId);
                    disconnectTimers.delete(user.id);
                }, DISCONNECT_TIMEOUT);
                disconnectTimers.set(user.id, timer);
            } else {
                // If not in match, remove from participants and queue
                await redis.hdel(keys.participants, user.id);
                await redis.zrem(keys.readyQueue, user.id);
                await broadcastLobbyUpdate();
            }

            // Remove user presence
            await redis.del(getRedisKeys(userId).presence);

        } catch (error) {
            console.error('[Disconnect Error]', error);
        }
    });

    // Event Listeners
    socket.on('round1:getState', handleGetState);
    socket.on('round1:reset', async (payload, callback) => {
        const validation = validateUser();
        if (validation.error) {
            return callback?.({ success: false, error: validation.error });
        }

        try {
            // Check if user is admin
            const userData = await prisma.user.findUnique({
                where: { email: validation.email },
                select: { role: true }
            });

            if (!userData || userData.role !== 'ADMIN') {
                return callback?.({ success: false, error: 'Only admins can reset Round 1' });
            }

            const success = await resetRoundState();
            callback?.({ 
                success, 
                message: success ? 'Round 1 reset successfully' : 'Failed to reset Round 1'
            });

            if (success) {
                io.emit('round1:reset', { message: 'Round 1 has been reset by admin' });
            }

        } catch (error) {
            console.error('[Reset Error]', error);
            callback?.({ success: false, error: 'Failed to reset Round 1' });
        }
    });

    // Store the handleMatchEnd function globally so it can be accessed from external routes
    round1MatchEndHandler = handleMatchEnd;
};

// Export the match end handler for external use
export const getRound1MatchEndHandler = () => round1MatchEndHandler;

// Export helper function to check round status
export const getRound1Status = async () => {
    try {
        const keys = getRedisKeys();
        const currentStatus = await redis.get(keys.status);
        const allParticipants = await redis.hgetall(keys.participants);
        
        const participants = Object.entries(allParticipants).map(([uid, value]) => ({
            userId: uid,
            ...JSON.parse(value)
        }));

        const lobbyParticipants = participants.filter(p => p.status === 'lobby');
        const inMatchParticipants = participants.filter(p => p.status === 'in-match');
        const waitingParticipants = participants.filter(p => p.status === 'waiting');

        let timeRemaining = 0;
        if (currentStatus === "running") {
            try {
                const startTimeStr = await redis.get(`round${ROUND_NUMBER}:startTime`);
                if (startTimeStr) {
                    const startTime = parseInt(startTimeStr);
                    const elapsed = Date.now() - startTime;
                    timeRemaining = Math.max(0, ROUND_DURATION - elapsed);
                }
            } catch (error) {
                console.error('Error calculating time remaining:', error);
            }
        }

        return {
            isActive: currentStatus === "running",
            status: currentStatus || "lobby",
            participants,
            lobbyParticipants,
            inMatchParticipants,
            waitingParticipants,
            totalParticipants: participants.length,
            timeRemaining: timeRemaining / 1000, // Return in seconds
            duration: ROUND_DURATION / 1000
        };
    } catch (error) {
        console.error('Error getting Round 1 status:', error);
        return {
            isActive: false,
            status: "lobby",
            participants: [],
            lobbyParticipants: [],
            inMatchParticipants: [],
            waitingParticipants: [],
            totalParticipants: 0,
            timeRemaining: 0,
            duration: ROUND_DURATION / 1000
        };
    }
};