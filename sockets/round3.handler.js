import redis from "../config/redis.js";
import prisma from "../config/prisma.js";

const ROUND3_STATE_KEY = "round3:state";
const ROUND3_LOBBY_KEY = "round3:lobby";
const ROUND3_QUESTIONS_KEY = "round3:questions";

const ROUND_DURATION_MS = 90 * 60 * 1000;
const HACKING_PHASE_START_MS = 60 * 60 * 1000; // Hacking phase begins 60 minutes after start
const COUNTDOWN_SECONDS = 20;

// Global timers to manage the round's lifecycle.
let roundEndTimer = null;
let hackingPhaseTimer = null;

// Helper to broadcast the lobby state
const broadcastLobbyUpdate = async (io) => {
  try {
    const lobbyUserIds = await redis.smembers(ROUND3_LOBBY_KEY);
    if (lobbyUserIds.length === 0) {
      io.emit("lobby:round3", []);
      return;
    }
    const users = await prisma.user.findMany({
      where: { id: { in: lobbyUserIds } },
      select: { id: true, username: true },
    });
    io.emit("lobby:round3", users);
  } catch (error) {
    console.error("Failed to broadcast Round 3 lobby update:", error);
  }
};

export const round3Handler = (io, socket) => {

  const userId = socket.user.id;

  // 1. handleJoin (Client -> Server)
  // Handles a user joining the Round 3 lobby.
  const handleJoin = async (payload, callback) => {
    try {
      const roundStateRaw = await redis.get(ROUND3_STATE_KEY);
      const roundState = roundStateRaw ? JSON.parse(roundStateRaw) : { status: "LOBBY" };
      if (roundState.status !== "LOBBY") {
        return callback?.({ success: false, error: "Round 3 is not in lobby state." });
      }
      await redis.sadd(ROUND3_LOBBY_KEY, userId);
      await broadcastLobbyUpdate(io);
      callback?.({ success: true, message: "Joined Round 3 lobby." });
    } catch (error) {
      console.error("Error in round3:join handler:", error);
      callback?.({ success: false, error: "Failed to join lobby." });
    }
  };

  // 2. handleReady (Admin -> Server)
  // Handles the admin "ready" signal to start the round countdown.
  const handleReady = async (payload, callback) => {
    try {
      // Admin validation
      if (socket.user.role !== "ADMIN") {
        return callback?.({ success: false, error: "Unauthorized." });
      }
      const currentStateRaw = await redis.get(ROUND3_STATE_KEY);
      const currentState = currentStateRaw ? JSON.parse(currentStateRaw) : { status: "LOBBY" };
      if (currentState.status !== "LOBBY") {
        return callback?.({ success: false, error: "Round is not in lobby state." });
      }
      await redis.set(ROUND3_STATE_KEY, JSON.stringify({ status: "COUNTDOWN" }));
      callback?.({ success: true, message: "Countdown initiated." });

      let countdown = COUNTDOWN_SECONDS;
      const countdownInterval = setInterval(async () => {
        io.emit("round3:countdown", { timeLeft: countdown });
        countdown--;

        if (countdown < 0) {
          clearInterval(countdownInterval);
          
          // Fetch questions from DB
          const questions = await prisma.problem.findMany({
            where: { roundId: 3 },
            take: 6,
          });

          if (questions.length < 6) {
            console.error("Fewer than 6 questions for Round 3. Aborting start.");
            await redis.set(ROUND3_STATE_KEY, JSON.stringify({ status: "LOBBY" }));
            io.emit("round3:start_failed", { error: "Insufficient questions for Round 3." });
            return;
          }
          await redis.set(ROUND3_QUESTIONS_KEY, JSON.stringify(questions));

          // Set round state in redis
          const endTime = Date.now() + ROUND_DURATION_MS;
          await redis.set(
            ROUND3_STATE_KEY,
            JSON.stringify({
              status: "IN_PROGRESS",
              endTime: endTime,
              hackingPhase: false,
            })
          );
          io.emit("round3:start", { questions, endTime });

          // Schedule hacking phase
          hackingPhaseTimer = setTimeout(async () => {
            const currentStateRaw = await redis.get(ROUND3_STATE_KEY);
            if (currentStateRaw) {
                const currentState = JSON.parse(currentStateRaw);
                if (currentState.status === "IN_PROGRESS") {
                  currentState.hackingPhase = true;
                  await redis.set(ROUND3_STATE_KEY, JSON.stringify(currentState));
                  io.emit("round3:hackingPhaseStart");
                }
            }
          }, HACKING_PHASE_START_MS);

          // Schedule round end
          roundEndTimer = setTimeout(async () => {
            await redis.set(ROUND3_STATE_KEY, JSON.stringify({ status: "COMPLETED" }));
            io.emit("round3:ended");
            if (hackingPhaseTimer) clearTimeout(hackingPhaseTimer);
          }, ROUND_DURATION_MS);
        }
      }, 1000);
    } catch (error) {
      console.error("Error in round3:ready handler:", error);
      callback?.({ success: false, error: "Failed to start round." });
    }
  };

  // 3. handleLockQuestion (Client -> Server)
  // Handles a user locking a question to view submissions for hacking.
  const handleLockQuestion = async (payload, callback) => {
    try {
      const { questionId } = payload;
      if (!questionId) {
        return callback?.({ success: false, error: "Question ID is required." });
      }
      const roundStateRaw = await redis.get(ROUND3_STATE_KEY);
      const roundState = roundStateRaw ? JSON.parse(roundStateRaw) : {};
      
      // check if hacking is on
      if (roundState.status !== "IN_PROGRESS" || !roundState.hackingPhase) {
        return callback?.({ success: false, error: "Hacking phase is not active." });
      }
      
      // check if user solved it
      const solvedKey = `round3:user_solved:${userId}`;
      const hasSolved = await redis.sismember(solvedKey, questionId);
      if (!hasSolved) {
        return callback?.({ success: false, error: "You have not solved this question." });
      }
      
      // check if already locked
      const lockedKey = `round3:user_locked:${userId}`;
      const isAlreadyLocked = await redis.sismember(lockedKey, questionId);
      if (isAlreadyLocked) {
        return callback?.({ success: false, error: "You have already locked this question." });
      }
      
      await redis.sadd(lockedKey, questionId);
      await prisma.lockedSolution.create({
        data: {
            userId: userId,
            questionId: questionId,
        }
      });
      
      // get submissions to view
      const submissionsKey = `round3:submissions:${questionId}`;
      const submissionsRaw = await redis.hgetall(submissionsKey);
      const submitterIds = Object.keys(submissionsRaw).filter(id => id !== userId);
      if (submitterIds.length === 0) {
        socket.emit("round3:viewSubmissions", { questionId, submissions: [] });
        return callback?.({ success: true, message: "Question locked. No other submissions to view yet." });
      }
      const submitters = await prisma.user.findMany({
        where: { id: { in: submitterIds } },
        select: { id: true, username: true },

      });
      const submissions = submitters.map(submitter => ({
        submitterId: submitter.id,
        username: submitter.username,
        code: submissionsRaw[submitter.id],
      }));
      
      // send submissions to the user
      socket.emit("round3:viewSubmissions", { questionId, submissions });
      callback?.({ success: true, message: "Question locked. Submissions retrieved." });
    } catch (error) {
      console.error("Error in round3:lockQuestion handler:", error);
      callback?.({ success: false, error: "Failed to lock question." });
    }
  };

  // 4. handleDisconnect
  // Handles user disconnection.
  const handleDisconnect = async () => {
    try {
      const wasInLobby = await redis.srem(ROUND3_LOBBY_KEY, userId);
      if (wasInLobby) {
        await broadcastLobbyUpdate(io);
      }
    } catch (error) {
      console.error("Error in round3:disconnect handler:", error);
    }
  };

  // 5. handleReconnect (Client -> Server)
  // Handles a user reconnecting to an in-progress Round 3.
  const handleReconnect = async (payload, callback) => {
    try {
      const roundStateRaw = await redis.get(ROUND3_STATE_KEY);
      const roundState = roundStateRaw ? JSON.parse(roundStateRaw) : null;
      if (!roundState || roundState.status !== "IN_PROGRESS") {
        return callback?.({ success: false, error: "Round is not in progress." });
      }
      const questionsRaw = await redis.get(ROUND3_QUESTIONS_KEY);
      const questions = questionsRaw ? JSON.parse(questionsRaw) : [];
      
      // get user progress
      const solvedKey = `round3:user_solved:${userId}`;
      const lockedKey = `round3:user_locked:${userId}`;
      const [solvedQuestions, lockedQuestionIds] = await Promise.all([
        redis.smembers(solvedKey),
        redis.smembers(lockedKey),
      ]);
      
      // get data for locked questions
      const lockedQuestionsData = {};
      for (const questionId of lockedQuestionIds) {
        const submissionsKey = `round3:submissions:${questionId}`;
        const submissionsRaw = await redis.hgetall(submissionsKey);
        const submitterIds = Object.keys(submissionsRaw).filter(id => id !== userId);
        if (submitterIds.length > 0) {
            const submitters = await prisma.user.findMany({
                where: { id: { in: submitterIds } },
                select: { id: true, username: true },
            });
            lockedQuestionsData[questionId] = submitters.map(submitter => ({
                submitterId: submitter.id,
                username: submitter.username,
                code: submissionsRaw[submitter.id],
            }));
        } else {
            lockedQuestionsData[questionId] = [];
        }
      }
      
      // build game state object
      const gameState = {
        status: roundState.status,
        endTime: roundState.endTime,
        hackingPhase: roundState.hackingPhase,
        questions,
        solvedQuestions,
        lockedQuestions: lockedQuestionsData,
      };
      
      // send it all to the user
      socket.emit("round3:reconnect", gameState);
      callback?.({ success: true, message: "Reconnected successfully." });
    } catch (error) {
      console.error("Error in round3:reconnect handler:", error);
      callback?.({ success: false, error: "Failed to reconnect." });
    }
  };

  // Register socket event listeners
  socket.on("round3:join", handleJoin);
  socket.on("round3:ready", handleReady);
  socket.on("round3:lockQuestion", handleLockQuestion);
  socket.on("round3:reconnect", handleReconnect);
  socket.on("disconnect", handleDisconnect);
};