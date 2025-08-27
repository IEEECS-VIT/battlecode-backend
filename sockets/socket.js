import { Server } from "socket.io";
import { createServer } from "http";
import express from "express";
import redis from "../config/redis.js";
import { verifySocketToken } from "../middleware/authMiddleware.js";
import { GetProblems } from "../controller/matchController.js";
import { handleRound1Join, handleRound1Ready } from "./round1.handler.js";
import { use } from "react";

const app = express();
const httpServer = createServer(app);

const getMatchKey = (matchId) => `match:${matchId}`;
const getActiveMatchesKey = () => "active_matches";

async function createMatch(matchId, matchData) {
  try {
    await redis.setex(getMatchKey(matchId), 86400, JSON.stringify(matchData));
    await redis.sadd(getActiveMatchesKey(), matchId);
    console.log(`Match created: ${matchId}`);
    return true;
  } catch (error) {
    console.error(`Error creating match ${matchId}:`, error);
    throw error;
  }
}

async function getMatch(matchId) {
  try {
    const data = await redis.get(getMatchKey(matchId));
    if (!data) {
      console.log(`Match not found in Redis: ${matchId}`);
      return null;
    }
    const match = JSON.parse(data);
    console.log(`Match retrieved: ${matchId}`);
    return match;
  } catch (error) {
    console.error(`Error getting match ${matchId}:`, error);
    throw error;
  }
}

async function updateMatch(matchId, matchData) {
  try {
    await redis.setex(getMatchKey(matchId), 86400, JSON.stringify(matchData));
    console.log(`Match updated: ${matchId}`);
    return true;
  } catch (error) {
    console.error(`Error updating match ${matchId}:`, error);
    throw error;
  }
}

function generateMatchId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export default function initializeSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.replace("Bearer ", "");
      if (!token) {
        return next(new Error("Authentication token required"));
      }

      const user = await verifySocketToken(token);
      if (!user) {
        return next(new Error("Invalid token"));
      }

      socket.user = user;
      console.log(`User authenticated: ${user.id}`);
      next();
    } catch (error) {
      console.error("Authentication error:", error);
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.user.id} (Socket: ${socket.id})`);

    handleRound1Join(socket);
    handleRound1Ready(socket);

    socket.on("round1:join", async({userId}) => {
      try{
        await prisma.user.update({  //updating the current round of the user to 1
          where: { id: userId },
        data: { currentRound: 1 }
        });

        await redis.sadd("round1:lobby", userId);

        const participants = await redis.smembers("round1:lobby");
        io.emit("lobby:round1", {participants});
      }catch(error){
        console.error("JOining error:", error);

      }
    })

    socket.on("round1:ready", async({ adminId }) => {
      try {
        const admin = await prisma.user.findUnique({
          where: { id: adminId },
        });
        if (admin.role !== "ADMIN") return; 

        const endTime  = Date.now() + 90 * 60 *1000; // the 90 min thing

        await redis.set("round1:timer", endTime);

        for ( let userId of participants){
          await redis.zadd("round1:readyQueue", 0, userId); // ranking should be based on score ( i'll do that in a bit)
        }

        await redis.del("round1:lobby");

        setInterval(() => {
        runMatchmaking();
      }, 5000);

      }
      catch(error){
        console.error("Ready error  :", error);

      }
    })

    // Enhanced join room handler with callback
    socket.on("joinRoom", ({ matchId }, callback) => {
      if (!matchId) {
        const error = "Match ID is required for joinRoom";
        console.error(error);
        if (callback) callback({ success: false, error });
        return;
      }

      socket.join(matchId);
      console.log(`User ${socket.user.id} joined room: ${matchId}`);

      if (callback) callback({ success: true, matchId });
    });

    // Enhanced get match handler
    socket.on("getMatch", async ({ matchId }, callback) => {
      console.log(
        `Getting match data for: ${matchId} by user: ${socket.user.id}`
      );

      try {
        if (!matchId) {
          const error = "Match ID is required";
          console.error(error);
          return callback({ success: false, error });
        }

        const match = await getMatch(matchId);
        if (!match) {
          const error = `Match not found: ${matchId}`;
          console.log(error);
          return callback({ success: false, error });
        }

        console.log(`Match data retrieved for ${matchId}`);
        callback({ success: true, match });
      } catch (error) {
        console.error("Get match error:", error);
        callback({ success: false, error: "Failed to get match data" });
      }
    });

    // Enhanced create match handler
    socket.on("createMatch", async (settings, callback) => {
      console.log(`Creating match for user: ${socket.user.id}`, settings);

      try {
        if (!settings?.topics?.length) {
          throw new Error("At least one topic is required");
        }

        // --- MODIFICATION START ---
        // Validate that either timeLimit or noOfQuestions is provided, but not both.
        const hasTimeLimit =
          settings.hasOwnProperty("timeLimit") && settings.timeLimit;
        const hasNoOfQuestions =
          settings.hasOwnProperty("noOfQuestions") && settings.noOfQuestions;

        if (hasTimeLimit && hasNoOfQuestions) {
          throw new Error(
            "Provide either a time limit OR number of questions, not both."
          );
        }

        if (!hasTimeLimit && !hasNoOfQuestions) {
          throw new Error(
            "Provide either a time limit OR number of questions."
          );
        }
        // --- MODIFICATION END ---

        const matchId = generateMatchId();
        const matchData = {
          id: matchId,
          playerAId: socket.user.id,
          status: "WAITING",
          settings: {
            // --- MODIFICATION START ---
            // Conditionally add the provided setting
            ...(hasTimeLimit && { timeLimit: settings.timeLimit }),
            ...(hasNoOfQuestions && { noOfQuestions: settings.noOfQuestions }),
            // --- MODIFICATION END ---
            difficulty: settings.difficulty || "MEDIUM",
            topics: settings.topics,
          },
          createdAt: new Date().toISOString(),
          questions: [],
          scores: {},
          correctAnswers: {},
          currentQuestionIndex: 0,
        };

        await createMatch(matchId, matchData);
        socket.join(matchId);

        // Verify match was created
        const verifiedMatch = await getMatch(matchId);
        if (!verifiedMatch) {
          throw new Error("Failed to verify match creation");
        }

        const response = {
          success: true,
          matchId,
          playerId: socket.user.id,
          match: verifiedMatch,
        };

        if (callback) callback(response);
        io.to(matchId).emit("matchCreated", verifiedMatch);
      } catch (error) {
        console.error("Match creation error:", error);
        const response = {
          success: false,
          error: error.message || "Failed to create match",
        };
        if (callback) callback(response);
      }
    });

    // Enhanced join match handler
    socket.on("joinMatch", async ({ matchId }, callback) => {
      console.log(
        `User ${socket.user.id} attempting to join match: ${matchId}`
      );

      try {
        if (!matchId) throw new Error("Match ID is required");

        const match = await getMatch(matchId);
        if (!match) throw new Error("Match not found");
        if (match.playerBId) throw new Error("Match is full");
        if (match.playerAId === socket.user.id)
          throw new Error("Cannot join your own match");

        match.playerBId = socket.user.id;
        match.status = "READY";
        await updateMatch(matchId, match);

        socket.join(matchId);

        const response = {
          success: true,
          matchId,
          playerId: socket.user.id,
          match,
        };

        if (callback) callback(response);
        io.to(matchId).emit("matchReady", {
          matchId,
          playerAId: match.playerAId,
          playerBId: match.playerBId,
          settings: match.settings,
        });
      } catch (error) {
        console.error("Join match error:", error);
        if (callback) callback({ success: false, error: error.message });
      }
    });

    // Enhanced start match handler
    socket.on("startMatch", async ({ matchId }, callback) => {
      console.log(`🎮 Starting match: ${matchId} by user: ${socket.user.id}`);

      try {
        if (!matchId) throw new Error("Match ID is required");

        const match = await getMatch(matchId);
        if (!match) throw new Error("Match not found");
        if (match.status !== "READY")
          throw new Error("Match is not ready to start");
        if (match.playerAId !== socket.user.id)
          throw new Error("Only the match creator can start the match");

        // --- MODIFICATION START ---
        // If noOfQuestions is not set, it's a timed match. We'll fetch a default
        // number of questions, and the game will be limited by the timer on the client.
        const noOfQuestionsToFetch = match.settings.noOfQuestions || 50;
        // --- MODIFICATION END ---

        console.log("🔍 Match validation passed, fetching questions with:", {
          noOfQuestions: noOfQuestionsToFetch,
          difficulty: match.settings.difficulty,
          topics: match.settings.topics,
        });

        // Add more detailed logging for question fetching
        let questions;
        try {
          questions = await GetProblems(
            noOfQuestionsToFetch, // Use the potentially defaulted value
            match.settings.difficulty,
            match.settings.topics
          );
          console.log("Questions fetched successfully:", questions.length);
        } catch (questionError) {
          console.error("Error fetching questions:", questionError);

          // Try to provide more helpful error messages
          if (questionError.message.includes("No questions found")) {
            const errorMessage = `No questions available for difficulty: ${
              match.settings.difficulty
            } and topics: ${match.settings.topics.join(
              ", "
            )}. Please try different settings.`;
            throw new Error(errorMessage);
          } else if (questionError.message.includes("Database")) {
            throw new Error(
              "Database connection issue. Please try again later."
            );
          } else {
            throw new Error(
              `Failed to load questions: ${questionError.message}`
            );
          }
        }

        if (!questions || questions.length === 0) {
          throw new Error(
            "No questions were loaded. Please check your match settings."
          );
        }

        console.log(
          "Questions loaded:",
          questions.map((q) => ({
            id: q.id,
            title: q.title,
            difficulty: q.difficulty,
            categories: q.categories,
          }))
        );

        // Update match with questions and start the game
        match.questions = questions;
        match.currentQuestionIndex = 0;
        match.status = "IN_PROGRESS";
        match.startedAt = new Date().toISOString();
        match.scores = {
          [match.playerAId]: 0,
          [match.playerBId]: 0,
        };
        match.correctAnswers = {
          [match.playerAId]: 0,
          [match.playerBId]: 0,
        };

        await updateMatch(matchId, match);
        console.log("Match updated with questions and started");

        const firstQuestion = questions[0];
        const questionData = {
          id: firstQuestion.id,
          title: firstQuestion.title,
          description: firstQuestion.description,
          difficulty: firstQuestion.difficulty,
          constraints: firstQuestion.constraints || [],
          hints: firstQuestion.hints || [],
          boilerplate: firstQuestion.boilerplate || {
            python: "",
            cpp: "",
            java: "",
            c: "",
            javascript: "",
          },
          sampleTestCases: firstQuestion.sampleTestCases || [],
          categories: firstQuestion.categories || [],
          avgTimeComplexity: firstQuestion.avgTimeComplexity || "O(n)",
          avgSpaceComplexity: firstQuestion.avgSpaceComplexity || "O(n)",
        };

        const response = {
          matchId,
          startTime: match.startedAt,
          timeLimit: match.settings.timeLimit,
          question: questionData,
          questionIndex: 0,
          totalQuestions: questions.length,
        };

        console.log("📤 Sending match started response:", {
          matchId,
          questionTitle: questionData.title,
          totalQuestions: questions.length,
        });

        if (callback) callback({ success: true });
        io.to(matchId).emit("matchStarted", response);
      } catch (error) {
        console.error("Start match error:", error);
        console.error("Error stack:", error.stack);

        const errorMessage = error.message || "Failed to start match";
        if (callback) callback({ success: false, error: errorMessage });
      }
    });

    // Submit Answer
    socket.on(
      "submitAnswer",
      async ({ matchId, answer, questionIndex }, callback) => {
        console.log(
          `Answer submitted for match: ${matchId} by user: ${socket.user.id}`
        );

        try {
          if (!matchId) {
            throw new Error("Match ID is required");
          }

          const match = await getMatch(matchId);
          if (!match) {
            throw new Error("Match not found");
          }

          if (match.status !== "IN_PROGRESS") {
            throw new Error("Match is not in progress");
          }

          // Initialize scores and correctAnswers if they don't exist
          if (!match.scores) {
            match.scores = {
              [match.playerAId]: 0,
              [match.playerBId]: 0,
            };
          }

          if (!match.correctAnswers) {
            match.correctAnswers = {
              [match.playerAId]: 0,
              [match.playerBId]: 0,
            };
          }

          // Here you would typically:
          // 1. Validate the answer against test cases
          // 2. Update scores based on correctness
          // 3. Update match state
          // This is a placeholder implementation

          await updateMatch(matchId, match);

          callback({ success: true, message: "Answer received" });
        } catch (error) {
          console.error("Answer submission error:", error);
          callback({ success: false, error: error.message });
        }
      }
    );

    // Next Question
    socket.on("nextQuestion", async ({ matchId }, callback) => {
      console.log(`Requesting next question for match: ${matchId}`);

      try {
        if (!matchId) {
          throw new Error("Match ID is required");
        }

        const match = await getMatch(matchId);
        if (!match) {
          throw new Error("Match not found");
        }

        if (match.status !== "IN_PROGRESS") {
          throw new Error("Match is not in progress");
        }

        const nextIndex = match.currentQuestionIndex + 1;
        if (nextIndex >= match.questions.length) {
          // End of questions
          match.status = "COMPLETED";
          match.completedAt = new Date().toISOString();
          await updateMatch(matchId, match);

          io.to(matchId).emit("matchCompleted", {
            matchId,
            finalScores: {
              [match.playerAId]: match.scores?.[match.playerAId] || 0,
              [match.playerBId]: match.scores?.[match.playerBId] || 0,
            },
            questions: match.questions.length,
            correctAnswers: {
              [match.playerAId]: match.correctAnswers?.[match.playerAId] || 0,
              [match.playerBId]: match.correctAnswers?.[match.playerBId] || 0,
            },
          });

          return callback({ success: true, completed: true });
        }

        // Update to next question
        match.currentQuestionIndex = nextIndex;
        await updateMatch(matchId, match);

        const nextQuestion = match.questions[nextIndex];
        const questionToSend = {
          id: nextQuestion.id,
          title: nextQuestion.title,
          description: nextQuestion.description,
          difficulty: nextQuestion.difficulty,
          constraints: nextQuestion.constraints || [],
          hints: nextQuestion.hints || [],
          boilerplate: nextQuestion.boilerplate || {
            python: "",
            cpp: "",
            java: "",
            c: "",
            javascript: "",
          },
          sampleTestCases: nextQuestion.sampleTestCases || [],
          categories: nextQuestion.categories || [],
          avgTimeComplexity: nextQuestion.avgTimeComplexity || "O(n)",
          avgSpaceComplexity: nextQuestion.avgSpaceComplexity || "O(n)",
        };

        io.to(matchId).emit("nextQuestion", {
          matchId,
          question: questionToSend,
          questionIndex: nextIndex,
          timeRemaining: match.settings.timeLimit * 60, // Convert minutes to seconds
        });

        callback({ success: true });
      } catch (error) {
        console.error("Next question error:", error);
        callback({ success: false, error: error.message });
      }
    });

    // Disconnect handler
    socket.on("disconnect", () => {
      console.log(
        `User disconnected: ${socket.user.id} (Socket: ${socket.id})`
      );
    });
  });
}
