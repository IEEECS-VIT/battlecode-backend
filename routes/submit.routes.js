import express from "express";
import axios from "axios";
import http from "http";
import prisma from "../config/prisma.js";
import redis from "../config/redis.js";
// All score functions are now imported
import {
  ScoreRound0,
  ScoreRound1,
  ScoreRound2,
  ScoreBounty,
  ScoreRound3,
} from "../utils/calculateScore.js";
import verifyAuthToken from "../middleware/authMiddleware.js";
import { handleMatchEnd } from "../sockets/round1.handler.js";
import { getRound2Handlers } from "../sockets/round2.handler.js";
import { broadcastLeaderboard } from "../sockets/global.handler.js";


const router = express.Router();

const JUDGE0_API_URL = process.env.JUDGE0_API_URL;
const JUDGE0_API_KEY = null;
const HARD_API_TIMEOUT_MS = 15_000; // 15 seconds max polling timeout
const POLL_INTERVAL_MS = 500; // 500ms polling interval
const CPU_TIME_LIMIT = 2.0; // 2.0s CPU time limit
const WALL_TIME_LIMIT = 3.0; // 3.0s Wall time limit (terminates infinite loops instantly)
const SESSION_GRACE_MS = 30_000; // 30 seconds

const LANGUAGE_ID_MAP = {
  cpp: 105,
  python: 71,
  java: 62,
  c: 50,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getRound1RedisKeys = () => ({
  matches: `round1:matches`,
});

/**
 * POST /run
 */
router.post("/run", async (req, res) => {
  try {
    const { language, source_code, problemId } = req.body;

    if (!language || !source_code || !problemId) {
      return res.status(400).json({
        error: "Missing required fields: language, source_code, problemId",
      });
    }

    const language_id = LANGUAGE_ID_MAP[language.toLowerCase()];
    if (!language_id) {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      select: { sampleTestCases: true },
    });

    if (!problem) {
      return res.status(404).json({ error: "Problem not found" });
    }

    const sampleTestCases = Array.isArray(problem.sampleTestCases)
      ? problem.sampleTestCases
      : problem.sampleTestCases.testCases || [];

    if (sampleTestCases.length === 0) {
      return res.status(400).json({ error: "No sample test cases found" });
    }

    const submissions = sampleTestCases.map((tc) => ({
      language_id,
      source_code,
      stdin: tc.stdin || tc.input || "",
      expected_output: tc.expected_output || tc.output || "",
      cpu_time_limit: CPU_TIME_LIMIT,
      wall_time_limit: WALL_TIME_LIMIT,
      max_processes_and_or_threads: 60,
    }));

    const submissionResponse = await axios.post(
      `${JUDGE0_API_URL}/submissions/batch`,
      { submissions }
    );

    const tokens = submissionResponse.data.map((s) => s.token);
    const results = [];
    const startTime = Date.now();

    while (results.length < tokens.length) {
      if (Date.now() - startTime > HARD_API_TIMEOUT_MS) {
        return res.status(200).json({
          success: false,
          error: "TIME_LIMIT_EXCEEDED",
          meta: { timeoutSeconds: HARD_API_TIMEOUT_MS / 1000 },
        });
      }

      const pendingTokens = tokens.filter(
        (t) => !results.some((r) => r.token === t)
      );

      if (pendingTokens.length === 0) break;

      const responses = await Promise.all(
        pendingTokens.map((token) =>
          axios
            .get(`${JUDGE0_API_URL}/submissions/${token}`)
            .catch(() => null)
        )
      );

      for (const r of responses) {
        if (!r?.data) continue;
        if (results.some((x) => x.token === r.data.token)) continue;
        if (r.data.status?.id > 2) {
          results.push(r.data);
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const passed = results.filter((r) => r.status?.id === 3).length;

    res.json({
      success: true,
      results,
      summary: { passed, total: sampleTestCases.length },
    });
  } catch (err) {
    console.error("[RUN ERROR]", err);
    res.status(500).json({ error: "Run failed" });
  }
});
/**
 * POST /submit
 */
router.post("/submit", verifyAuthToken, async (req, res) => {
  let submitLockKey = null;
  try {
    console.log("🔵 [SUBMIT] New submission request received");

    const io = req.app.get("io");

    if (!io) {
      console.error("❌ IO INSTANCE NOT FOUND IN SUBMIT");
    }
    const { language, source_code, problemId, roundNumber, context } = req.body;
    const userId = req.user?.email;

    console.log("📊 [SUBMIT] Request details:", {
      userId,
      problemId,
      roundNumber,
      language,
      codeLength: source_code?.length,
      context
    });

    if (!userId) {
      console.log("❌ [SUBMIT] Unauthorized - No userId found");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Fetched the full user object to access round2Role later
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      console.log("❌ [SUBMIT] User not found in database:", userId);
      return res.status(404).json({
        error: "Authenticated user not found. Please log out and log in again.",
      });
    }

    console.log("✅ [SUBMIT] User validated:", user.username);

    if (!language || !source_code || !problemId || roundNumber === undefined) {
      console.log("❌ [SUBMIT] Missing required fields:", {
        hasLanguage: !!language,
        hasSourceCode: !!source_code,
        hasProblemId: !!problemId,
        hasRoundNumber: roundNumber !== undefined
      });
      return res.status(400).json({
        error:
          "Missing required fields: language, source_code, problemId, roundNumber",
      });
    }

    // Prevent concurrent duplicate submissions for the same user+problem from
    // racing past the existingSubmission read and double-counting eventScore.
    submitLockKey = `submit:lock:${userId}:${problemId}`;
    const lockAcquired = await redis.set(submitLockKey, "1", "NX", "EX", 90);
    if (!lockAcquired) {
      submitLockKey = null; // not ours to release
      return res.status(429).json({
        error: "A submission for this problem is already being processed. Please wait for it to finish.",
      });
    }

    const language_id = LANGUAGE_ID_MAP[language.toLowerCase()];
    if (!language_id) {
      console.log("❌ [SUBMIT] Unsupported language:", language);
      return res
        .status(400)
        .json({ error: `Unsupported language: ${language}` });
    }

    console.log("✅ [SUBMIT] Language validated:", language, "->", language_id);

    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      select: {
        sampleTestCases: true,
        hiddenTestCases: true,
        title: true,
        roundId: true,
        difficulty: true,
      },
    });

    if (!problem) {
      console.log("❌ [SUBMIT] Problem not found:", problemId);
      return res.status(404).json({ error: "Problem not found" });
    }

    console.log("✅ [SUBMIT] Problem found:", {
      title: problem.title,
      difficulty: problem.difficulty,
      roundId: problem.roundId,
      requestedRound: roundNumber
    });

    if (problem.roundId !== roundNumber) {
      console.log("❌ [SUBMIT] Round mismatch - Problem belongs to round", problem.roundId, "but submission is for round", roundNumber);
      return res
        .status(400)
        .json({ error: "Problem does not belong to specified round" });
    }

    // The round must actually be running. Without this, Round 0 and Round 3
    // problems could be submitted before their round opened or long after it
    // closed (Rounds 1 & 2 were incidentally protected by needing a live
    // match/bounty). Admins bypass so they can smoke-test a round any time.
    const roundState = await prisma.round.findUnique({
      where: { roundNumber },
      select: { status: true },
    });

    if (user.role !== "ADMIN" && roundState?.status !== "IN_PROGRESS") {
      console.log("❌ [SUBMIT] Round not in progress:", roundNumber, roundState?.status);
      return res.status(403).json({
        error: `Round ${roundNumber} is not currently accepting submissions.`,
        roundStatus: roundState?.status || "UNKNOWN",
      });
    }

    // Capture any live Round 1/2 session BEFORE the code goes to Judge0.
    // Judging takes up to 60s, and the opponent may finish in that window,
    // which deletes the session key. Previously that made an honest
    // submission score 0 (Round 1) or fail outright with a 400 (Round 2).
    // The session is re-checked after judging, but only to decide the win
    // bonus -- partial credit is now always kept.
    let activeMatch = null;   // Round 1 match
    let round2Match = null;   // Round 2 challenge match
    const now = Date.now();

    if (roundNumber === 1) {
      const keys = getRound1RedisKeys();
      const allMatchesStr = await redis.hgetall(keys.matches);

      for (const matchId in allMatchesStr) {
        const match = JSON.parse(allMatchesStr[matchId]);
        if (match.players.includes(userId) && match.problemId === problemId) {
          activeMatch = match;
          break;
        }
      }

      if (!activeMatch) {
        console.warn(`[Round 1] No active match found for user ${userId}`);
      }
    } else if (roundNumber === 2) {
      if (context?.type === "match") {
        // Verify the caller is actually a participant in a live Round 2 match
        // for this exact problem, mirroring the Round 1 activeMatch check.
        const matchDataStr = context.contextId
          ? await redis.get(`round2:match:${context.contextId}`)
          : null;
        const matchData = matchDataStr ? JSON.parse(matchDataStr) : null;

        if (
          !matchData ||
          ![matchData.challengerId, matchData.eliteId].includes(userId) ||
          matchData.question?.id !== problemId
        ) {
          console.warn(`[Round 2] No active match found for user ${userId} on problem ${problemId}`);
          return res.status(400).json({ error: "No active match found for this submission" });
        }

        // Round 2 has no server-side match timer, so the deadline is enforced
        // here instead. Small grace period so someone who hits submit right on
        // the buzzer isn't punished for network latency.
        if (matchData.endTime && now > matchData.endTime + SESSION_GRACE_MS) {
          console.warn(`[Round 2] Match ${context.contextId} already ended for user ${userId}`);
          return res.status(400).json({ error: "This match has already ended." });
        }

        round2Match = matchData;
      } else if (context?.type === "bounty") {
        // Verify the caller actually has a live bounty session open for this
        // problem before scoring anything.
        const bountySession = await redis.hgetall(`round2:bounty:${userId}:${problemId}`);
        if (!bountySession || bountySession.status !== "active") {
          console.warn(`[Round 2] No active bounty session found for user ${userId} on problem ${problemId}`);
          return res.status(400).json({ error: "No active bounty session found for this submission" });
        }

        const bountyEndTime = parseInt(bountySession.endTime);
        if (bountyEndTime && now > bountyEndTime + SESSION_GRACE_MS) {
          console.warn(`[Round 2] Bounty session expired for user ${userId} on problem ${problemId}`);
          return res.status(400).json({ error: "This bounty session has already ended." });
        }
      } else {
        console.warn(
          `[Round 2] Unknown or missing context type: ${context?.type}`
        );
      }
    }

    // Timestamp used for all time-bonus maths. Captured before judging so a
    // slow Judge0 queue doesn't eat into the student's time bonus.
    const submitReceivedAt = Date.now();

    const sampleTestCases = Array.isArray(problem.sampleTestCases)
      ? problem.sampleTestCases
      : problem.sampleTestCases.testCases || [];
    const hiddenTestCases = Array.isArray(problem.hiddenTestCases)
      ? problem.hiddenTestCases
      : problem.hiddenTestCases.testCases || [];
    const allTestCases = [...sampleTestCases, ...hiddenTestCases];

    console.log("📝 [SUBMIT] Test cases:", {
      sampleCount: sampleTestCases.length,
      hiddenCount: hiddenTestCases.length,
      totalCount: allTestCases.length
    });

    if (allTestCases.length === 0) {
      console.log("❌ [SUBMIT] No test cases found for problem");
      return res.status(400).json({ error: "No test cases found" });
    }

    const httpAgent = new http.Agent();

    const axiosConfig = {
      httpAgent,
      headers: {
        ...(JUDGE0_API_KEY && { "X-RapidAPI-Key": JUDGE0_API_KEY }),
        "X-Judge0-Client-ID": process.env.JUDGE0_CLIENT_ID,
        "X-Judge0-Client": process.env.JUDGE0_CLIENT,
      },
    };
    const submissions = allTestCases.map((testCase, idx) => ({
      language_id,
      source_code,
      stdin: testCase.stdin || testCase.input || "",
      expected_output: testCase.expected_output || testCase.output || "",
      cpu_time_limit: CPU_TIME_LIMIT,
      wall_time_limit: WALL_TIME_LIMIT,
      max_processes_and_or_threads: 60,
      index: idx,
    }));

    console.log("🔄 [SUBMIT] Sending to Judge0:", JUDGE0_API_URL);

    const submissionResponse = await axios.post(
      `${JUDGE0_API_URL}/submissions/batch`,
      { submissions },
      axiosConfig
    );

    console.log("✅ [SUBMIT] Judge0 batch submission created, tokens received:", submissionResponse.data?.length);

    const tokens = submissionResponse.data.map((s) => s.token);
    let results = [];
    let submissionStatus = "PENDING";

    const startTime = Date.now();

    while (results.length < tokens.length) {
      if (Date.now() - startTime > HARD_API_TIMEOUT_MS) {
        submissionStatus = "TIME_LIMIT_EXCEEDED";
        break;
      }

      const pendingTokens = tokens.filter(
        (t) => !results.some((r) => r.token === t)
      );

      if (pendingTokens.length === 0) break;

      const responses = await Promise.all(
        pendingTokens.map((token) =>
          axios
            .get(`${JUDGE0_API_URL}/submissions/${token}`)
            .catch(() => null)
        )
      );

      for (const r of responses) {
        if (!r?.data) continue;
        if (results.some((x) => x.token === r.data.token)) continue;
        if (r.data.status?.id > 2) {
          results.push(r.data);
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const passedCount = results.filter((r) => r.status?.id === 3).length;
    const totalCount = allTestCases.length;
    
/** ✅ FINAL STATUS RESOLUTION */
if (submissionStatus === "TIME_LIMIT_EXCEEDED") {
  // already set by hard timeout
} else if (
  results.some(
    (r) =>
      r.status?.id === 5 ||
      (r.time && parseFloat(r.time) >= CPU_TIME_LIMIT) ||
      r.status?.description?.toLowerCase().includes("time limit exceeded")
  )
) {
  submissionStatus = "TIME_LIMIT_EXCEEDED";
} else if (passedCount === totalCount && totalCount > 0) {
  submissionStatus = "ACCEPTED";
} else if (
  results.some((r) => r.status?.id === 6 || !!r.compile_output)
) {
  submissionStatus = "COMPILATION_ERROR";
} else if (
  results.some(
    (r) =>
      r.status?.id >= 7 ||
      (r.stderr &&
        !r.status?.description?.toLowerCase().includes("time limit"))
  )
) {
  submissionStatus = "RUNTIME_ERROR";
} else {
  submissionStatus = "WRONG_ANSWER";
}

    const existingSubmission = await prisma.submission.findFirst({
      where: { userId, problemId },
    });

    const executionCount = (existingSubmission?.executionCount || 0) + 1;

    let calculatedScore = 0;
    if (roundNumber === 0) {
      calculatedScore = ScoreRound0(totalCount, passedCount, executionCount);
      console.log("💯 [SUBMIT] Round 0 score calculated:", calculatedScore);
    } else if (roundNumber === 3) {
      if (!user.qualifiedForR3) {
        console.log("❌ [SUBMIT] User not qualified for Round 3:", userId);
        return res.status(403).json({ error: "You are not qualified for Round 3" });
      }
      calculatedScore = ScoreRound3(totalCount, passedCount, executionCount);
      console.log("💯 [SUBMIT] Round 3 score calculated:", calculatedScore);
    } else if (roundNumber === 1) {
      if (activeMatch) {
        // The win bonus goes to the first correct solver only. Re-check the
        // match here rather than trusting the copy captured before judging,
        // since the opponent may have finished (or the clock run out) while
        // Judge0 was working. The claim key makes "who was first" atomic so a
        // simultaneous double-solve can't hand both players the bonus.
        let isWinner = false;
        if (submissionStatus === "ACCEPTED") {
          const keys = getRound1RedisKeys();
          const matchStillLive = await redis.hexists(keys.matches, activeMatch.id);
          if (matchStillLive === 1) {
            const claimed = await redis.set(
              `round1:winner:${activeMatch.id}`,
              userId,
              "NX",
              "EX",
              3600
            );
            isWinner = !!claimed;
          }
        }

        const difficultyTimeMapMs = {
          R1_EASY: 15 * 60 * 1000,
          R1_MEDIUM: 20 * 60 * 1000,
          R1_HARD: 25 * 60 * 1000,
        };
        const matchEndTime =
          activeMatch.endTime ??
          (activeMatch.startTime
            ? activeMatch.startTime + (activeMatch.duration || difficultyTimeMapMs[problem.difficulty] || 0)
            : null);
        // ScoreRound1's decay curve is calibrated in seconds.
        const timeLeftInSeconds = matchEndTime
          ? Math.max(0, (matchEndTime - submitReceivedAt) / 1000)
          : 0;

        calculatedScore = ScoreRound1(
          timeLeftInSeconds,
          totalCount,
          passedCount,
          problem.difficulty,
          isWinner,
          executionCount
        );

        if (isWinner) {
          await handleMatchEnd(io, activeMatch.id, userId);
        }
      }
    } else if (roundNumber === 2) {
      // --- NEW: ROUND 2 SCORING LOGIC ---
      const isCorrect = submissionStatus === "ACCEPTED";
      const { matchEndHandler, bountyEndHandler } = getRound2Handlers();

      if (context?.type === "match") {
        // round2Match was validated (participant, problem, deadline) before
        // judging started -- see the session capture block above.
        const isElite = user.round2Role === "ELITE";

        // The win bonus goes to the first correct solver only, claimed
        // atomically so a simultaneous double-solve can't pay it twice.
        let isWinner = false;
        if (isCorrect) {
          const matchStillLive = await redis.exists(`round2:match:${context.contextId}`);
          if (matchStillLive === 1) {
            const claimed = await redis.set(
              `round2:winner:${context.contextId}`,
              userId,
              "NX",
              "EX",
              3600
            );
            isWinner = !!claimed;
          }
        }

        // Real time remaining, from the match record written at match start.
        // This was hardcoded to 0, which collapsed the intended 20% time
        // component to a flat ~3.7 points for every player.
        const timeLeftInSeconds = round2Match?.endTime
          ? Math.max(0, (round2Match.endTime - submitReceivedAt) / 1000)
          : 0;

        calculatedScore = ScoreRound2(
          timeLeftInSeconds,
          totalCount,
          passedCount,
          problem.difficulty,
          isWinner,
          isElite,
          executionCount // Passing executionCount as 'submits'
        );

        if (isWinner && matchEndHandler) {
          await matchEndHandler(context.contextId, userId, "submission");
        }
      } else if (context?.type === "bounty") {
        // The bounty session was validated (exists, active, not expired)
        // before judging started -- see the session capture block above.

        // TODO: The `ScoreBounty` function expects "EASY", "MEDIUM", or "HARD".
        // The problem difficulty from the schema is 'R2_BOUNTY'. A mapping or a
        // new field on the Problem model is needed. Using "MEDIUM" as a placeholder.
        const bountyDifficulty = "MEDIUM";

        calculatedScore = ScoreBounty(
          bountyDifficulty,
          executionCount,
          totalCount,
          passedCount
        );

        if (bountyEndHandler) {
          const submissionData = {
            userId,
            problemId,
            roundId: 2,
            code: source_code,
            language,
            status: submissionStatus,
            testCasesPassed: passedCount,
          };
          await bountyEndHandler(userId, problemId, isCorrect, submissionData);
        }
      } else {
        console.warn(
          `[Round 2] Unknown or missing context type: ${context?.type}`
        );
      }
    }

    // User.eventScore is an Int column, but every formula with an exp() term
    // (and most partial-credit paths) produces a float. Prisma rejects a
    // fractional value on an Int field, so the eventScore update threw and the
    // whole request 500'd after the submission row had already been written --
    // the student's leaderboard score silently never moved. Rounding here
    // keeps Submission.score and User.eventScore in agreement.
    calculatedScore = Math.round(calculatedScore) || 0;

    let scoreImprovement = 0;
    let finalSubmission;
    if (existingSubmission) {
      const previousBestScore = existingSubmission.score || 0;
      if (calculatedScore > previousBestScore) {
        finalSubmission = await prisma.submission.update({
          where: { id: existingSubmission.id },
          data: {
            code: source_code,
            language,
            status: submissionStatus,
            runtime: Math.max(...results.map((r) => parseFloat(r.time) || 0)),
            memory: Math.max(...results.map((r) => parseInt(r.memory) || 0)),
            testCasesPassed: passedCount,
            executionCount,
            score: calculatedScore,
          },
        });
        scoreImprovement = calculatedScore - previousBestScore;
      } else {
        finalSubmission = await prisma.submission.update({
          where: { id: existingSubmission.id },
          data: { executionCount },
        });
      }
    } else {
      finalSubmission = await prisma.submission.create({
        data: {
          userId,
          problemId,
          roundId: roundNumber,
          code: source_code,
          language,
          status: submissionStatus,
          runtime: Math.max(...results.map((r) => parseFloat(r.time) || 0)),
          memory: Math.max(...results.map((r) => parseInt(r.memory) || 0)),
          testCasesPassed: passedCount,
          executionCount,
          score: calculatedScore,
        },
      });
      scoreImprovement = calculatedScore;
    }

    if (scoreImprovement > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { eventScore: { increment: scoreImprovement } },
      });

      await broadcastLeaderboard(io);

      console.log("✅ [SUBMIT] User score updated. Improvement:", scoreImprovement);
    } else {
      console.log("ℹ️ [SUBMIT] No score improvement. Current score:", calculatedScore, "Previous best:", existingSubmission?.score || 0);
    }

    console.log("🎉 [SUBMIT] Submission completed successfully:", {
      submissionId: finalSubmission.id,
      status: finalSubmission.status,
      score: finalSubmission.score
    });

    res.status(200).json({
      success: true,
      submission: {
        id: finalSubmission.id,
        status: finalSubmission.status,
        testCasesPassed: finalSubmission.testCasesPassed,
        totalTestCases: totalCount,
        calculatedScore: finalSubmission.score,
      },
      results,
      summary: { passed: passedCount, total: totalCount },
    });
  } catch (error) {
    console.error("💥 [SUBMIT] Error:", error.message, error.response?.data);
    console.error("💥 [SUBMIT] Stack trace:", error.stack);
    res.status(500).json({
      error: "Failed to submit code",
      details: error.response?.data || error.message,
    });
  } finally {
    if (submitLockKey) {
      await redis.del(submitLockKey).catch(() => {});
    }
  }
});

export default router;
