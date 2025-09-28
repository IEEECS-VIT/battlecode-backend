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
import { getRound1MatchEndHandler } from "../sockets/round1.handler.js";
import { getRound2Handlers } from "../sockets/round2.handler.js";

const router = express.Router();

const JUDGE0_API_URL = process.env.JUDGE0_API_URL;
const JUDGE0_API_KEY = null;

const LANGUAGE_ID_MAP = {
  cpp: 54,
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
  console.log("➡️ [RUN] Route called with body:", req.body);
  try {
    const { language, source_code, problemId } = req.body;

    if (!language || !source_code || !problemId) {
      console.warn("⚠️ [RUN] Missing required fields:", {
        language,
        source_code: !!source_code,
        problemId,
      });
      return res.status(400).json({
        error: "Missing required fields: language, source_code, problemId",
      });
    }

    const language_id = LANGUAGE_ID_MAP[language.toLowerCase()];
    if (!language_id) {
      console.warn("⚠️ [RUN] Unsupported language:", language);
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    console.log("🔎 [RUN] Fetching problem:", problemId);
    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      select: { sampleTestCases: true, title: true },
    });

    if (!problem) {
      console.warn("⚠️ [RUN] Problem not found:", problemId);
      return res.status(404).json({ error: "Problem not found" });
    }

    console.log("📋 [RUN] Problem test cases:", problem.sampleTestCases);
    const sampleTestCases = Array.isArray(problem.sampleTestCases)
      ? problem.sampleTestCases
      : problem.sampleTestCases.testCases || [];

    if (sampleTestCases.length === 0) {
      console.warn("⚠️ [RUN] No sample test cases found for problem:", problemId);
      return res.status(400).json({ error: "No sample test cases found" });
    }

    const httpAgent = new http.Agent();
    const axiosConfig = {
      httpAgent,
      headers: JUDGE0_API_KEY ? { "X-RapidAPI-Key": JUDGE0_API_KEY } : {},
    };

    const submissions = sampleTestCases.map((testCase, idx) => ({
      language_id,
      source_code,
      stdin: testCase.stdin || testCase.input || "",
      expected_output: testCase.expected_output || testCase.output || "",
      index: idx,
    }));

    console.log("📤 [RUN] Sending submissions to Judge0:", submissions);

    const submissionResponse = await axios.post(
      `${JUDGE0_API_URL}/submissions/batch`,
      { submissions },
      axiosConfig
    );

    console.log("✅ [RUN] Judge0 submission response:", submissionResponse.data);

    const tokens = submissionResponse.data.map((item) => item.token);
    let results = [];
    const startTime = Date.now();
    const timeout = 15000;

    while (results.length < tokens.length && Date.now() - startTime < timeout) {
      const pendingTokens = tokens.filter(
        (token) => !results.some((r) => r.token === token)
      );

      if (pendingTokens.length === 0) break;

      console.log("🔄 [RUN] Checking statuses for tokens:", pendingTokens);

      const statusResponses = await Promise.all(
        pendingTokens.map((token) =>
          axios
            .get(`${JUDGE0_API_URL}/submissions/${token}`, axiosConfig)
            .catch((err) => ({ data: { token, error: err.message } }))
        )
      );

      console.log("📥 [RUN] Status responses:", statusResponses);

      for (const response of statusResponses) {
        const data = response.data;
        if (results.some((r) => r.token === data.token)) continue;
        const statusId = data.status?.id;
        if (statusId > 2) {
          console.log("✅ [RUN] Finished result for token:", data.token);
          results.push({
            token: data.token,
            status: data.status,
            stdout: data.stdout,
            stderr: data.stderr,
            compile_output: data.compile_output,
            time: data.time,
            memory: data.memory,
            passed: data.status?.id === 3,
          });
        }
      }
      if (results.length < tokens.length) await sleep(1000);
    }

    console.log("🏁 [RUN] Final results:", results);
    if (results.length < tokens.length) {
      console.error("⏱️ [RUN] Timeout waiting for Judge0 results");
      return res.status(408).json({ error: "Execution timed out" });
    }

    const passedCount = results.filter((r) => r.passed).length;
    const totalCount = sampleTestCases.length;

    console.log("📊 [RUN] Summary:", { passedCount, totalCount });

    res.status(200).json({
      success: true,
      results,
      summary: { passed: passedCount, total: totalCount },
    });
  } catch (error) {
    console.error("💥 [RUN] Error:", error.message, error.response?.data);
    res.status(500).json({
      error: "Failed to execute code",
      details: error.response?.data || error.message,
    });
  }
});

/**
 * POST /submit
 */
router.post("/submit", verifyAuthToken, async (req, res) => {
  console.log("➡️ [SUBMIT] Route called with body:", req.body);
  try {
    const { language, source_code, problemId, roundNumber, context } = req.body;
    const userId = req.user?.email;

    if (!userId) {
      console.warn("⚠️ [SUBMIT] Unauthorized - no userId in token");
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("🔎 [SUBMIT] Checking user:", userId);
    // Fetched the full user object to access round2Role later
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      console.warn("⚠️ [SUBMIT] User not found in DB:", userId);
      return res.status(404).json({
        error: "Authenticated user not found. Please log out and log in again.",
      });
    }

    if (!language || !source_code || !problemId || roundNumber === undefined) {
      console.warn("⚠️ [SUBMIT] Missing fields:", {
        language,
        source_code: !!source_code,
        problemId,
        roundNumber,
      });
      return res.status(400).json({
        error: "Missing required fields: language, source_code, problemId, roundNumber",
      });
    }

    const language_id = LANGUAGE_ID_MAP[language.toLowerCase()];
    if (!language_id) {
      console.warn("⚠️ [SUBMIT] Unsupported language:", language);
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    console.log("🔎 [SUBMIT] Fetching problem:", problemId);
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
      console.warn("⚠️ [SUBMIT] Problem not found:", problemId);
      return res.status(404).json({ error: "Problem not found" });
    }

    if (problem.roundId !== roundNumber) {
      console.warn("⚠️ [SUBMIT] Problem round mismatch:", {
        expected: problem.roundId,
        got: roundNumber,
      });
      return res.status(400).json({ error: "Problem does not belong to specified round" });
    }

    const sampleTestCases = Array.isArray(problem.sampleTestCases)
      ? problem.sampleTestCases
      : problem.sampleTestCases.testCases || [];
    const hiddenTestCases = Array.isArray(problem.hiddenTestCases)
      ? problem.hiddenTestCases
      : problem.hiddenTestCases.testCases || [];
    const allTestCases = [...sampleTestCases, ...hiddenTestCases];

    if (allTestCases.length === 0) {
      console.warn("⚠️ [SUBMIT] No test cases found for problem:", problemId);
      return res.status(400).json({ error: "No test cases found" });
    }

    console.log("📤 [SUBMIT] Sending all test cases to Judge0:", allTestCases);

    const httpAgent = new http.Agent();
    const axiosConfig = {
      httpAgent,
      headers: JUDGE0_API_KEY ? { "X-RapidAPI-Key": JUDGE0_API_KEY } : {},
    };
    const submissions = allTestCases.map((testCase, idx) => ({
      language_id,
      source_code,
      stdin: testCase.stdin || testCase.input || "",
      expected_output: testCase.expected_output || testCase.output || "",
      index: idx,
    }));
    const submissionResponse = await axios.post(
      `${JUDGE0_API_URL}/submissions/batch`,
      { submissions },
      axiosConfig
    );

    console.log("✅ [SUBMIT] Judge0 submission response:", submissionResponse.data);

    const tokens = submissionResponse.data.map((item) => item.token);
    let results = [];
    const startTime = Date.now();
    const timeout = 20000;

    while (results.length < tokens.length && Date.now() - startTime < timeout) {
      const pendingTokens = tokens.filter(
        (token) => !results.some((r) => r.token === token)
      );
      if (pendingTokens.length === 0) break;

      console.log("🔄 [SUBMIT] Checking statuses for tokens:", pendingTokens);

      const statusResponses = await Promise.all(
        pendingTokens.map((token) =>
          axios
            .get(`${JUDGE0_API_URL}/submissions/${token}`, axiosConfig)
            .catch((err) => ({ data: { token, error: err.message } }))
        )
      );

      console.log("📥 [SUBMIT] Status responses:", statusResponses);

      for (const response of statusResponses) {
        const data = response.data;
        if (results.some((r) => r.token === data.token)) continue;
        const statusId = data.status?.id;
        if (statusId > 2) {
          console.log("✅ [SUBMIT] Finished result for token:", data.token);
          results.push({
            token: data.token,
            status: data.status,
            stdout: data.stdout,
            stderr: data.stderr,
            compile_output: data.compile_output,
            time: data.time,
            memory: data.memory,
            passed: data.status?.id === 3,
          });
        }
      }
      if (results.length < tokens.length) await sleep(1000);
    }

    if (results.length < tokens.length) {
      console.error("⏱️ [SUBMIT] Timeout waiting for Judge0 results");
      return res.status(408).json({ error: "Submission execution timed out" });
    }

    console.log("🏁 [SUBMIT] Final results:", results);

    const passedCount = results.filter((r) => r.passed).length;
    const totalCount = allTestCases.length;
    console.log("📊 [SUBMIT] Summary:", { passedCount, totalCount });

    let submissionStatus;
    if (results.some((r) => r.compile_output)) submissionStatus = "COMPILATION_ERROR";
    else if (results.some((r) => r.stderr)) submissionStatus = "RUNTIME_ERROR";
    else if (results.some((r) => parseFloat(r.time) > 2.0))
      submissionStatus = "TIME_LIMIT_EXCEEDED";
    else if (passedCount === totalCount) submissionStatus = "ACCEPTED";
    else submissionStatus = "WRONG_ANSWER";

    console.log("📌 [SUBMIT] Final submission status:", submissionStatus);

    const existingSubmission = await prisma.submission.findFirst({
      where: { userId, problemId },
    });

    const executionCount = (existingSubmission?.executionCount || 0) + 1;
    console.log("📌 [SUBMIT] Execution count:", executionCount);

    let calculatedScore = 0;
    if (roundNumber === 0) {
      calculatedScore = ScoreRound0(totalCount, passedCount, executionCount);
      console.log("📊 [SUBMIT] Round0 Score:", calculatedScore);
    } else if (roundNumber === 3){
      calculatedScore=ScoreRound3(totalCount,passedCount,executionCount);
    }else if (roundNumber === 1) {
      const keys = getRound1RedisKeys();
      const allMatchesStr = await redis.hgetall(keys.matches);
      console.log("📥 [SUBMIT] Redis matches:", allMatchesStr);

      let activeMatch = null;
      for (const matchId in allMatchesStr) {
        const match = JSON.parse(allMatchesStr[matchId]);
        if (match.players.includes(userId) && match.problemId === problemId) {
          activeMatch = match;
          break;
        }
      }
      console.log("📌 [SUBMIT] Active match:", activeMatch);

      if (activeMatch) {
        const isWinner = submissionStatus === "ACCEPTED";
        const difficultyTimeMap = {
          R1_EASY: 15 * 60,
          R1_MEDIUM: 20 * 60,
          R1_HARD: 25 * 60,
        };
        const totalTimeInSeconds = difficultyTimeMap[problem.difficulty] || 0;
        const elapsedTimeInSeconds = (Date.now() - activeMatch.startTime) / 1000;
        const timeLeftInSeconds = Math.max(
          0,
          totalTimeInSeconds - elapsedTimeInSeconds
        );

        calculatedScore = ScoreRound1(
          timeLeftInSeconds,
          totalCount,
          passedCount,
          problem.difficulty,
          isWinner,
          executionCount
        );
        console.log("📊 [SUBMIT] Round1 Score:", calculatedScore);

        if (isWinner) {
          console.log("🏆 [SUBMIT] User is winner, calling round1MatchEndHandler");
          const round1MatchEndHandler = getRound1MatchEndHandler();
          if (round1MatchEndHandler) {
            await round1MatchEndHandler(activeMatch.id, userId);
          }
        }
      } else {
        console.warn(`[Round 1] No active match found for user ${userId}`);
      }
    } else if (roundNumber === 2) {
      // --- NEW: ROUND 2 SCORING LOGIC ---
      console.log("📌 [SUBMIT] Handling Round2 with context:", context);
      const isCorrect = submissionStatus === "ACCEPTED";
      const { matchEndHandler, bountyEndHandler } = getRound2Handlers();

      if (context?.type === "match") { // Assuming 'match' is the challenge type
        console.log("📌 [SUBMIT] Round2 challenge context found");

        const isElite = user.round2Role === "ELITE";
        
        // NOTE: time_left isn't readily available here like in Round 1.
        // Passing 0 for timeLeft, as score might be calculated within the handler with more context.
        const timeLeftInSeconds = 0;

        calculatedScore = ScoreRound2(
          timeLeftInSeconds,
          totalCount,
          passedCount,
          problem.difficulty,
          isCorrect,
          isElite,
          executionCount // Passing executionCount as 'submits'
        );
        console.log(`📊 [SUBMIT] Round2 Challenge Score: ${calculatedScore} (isElite: ${isElite})`);

        if (isCorrect && matchEndHandler) {
          await matchEndHandler(context.contextId, userId, "submission");
        }
      } else if (context?.type === "bounty") {
        console.log("📌 [SUBMIT] Round2 bounty context found");
        
        // TODO: The `ScoreBounty` function expects "EASY", "MEDIUM", or "HARD".
        // The problem difficulty from the schema is 'R2_BOUNTY'. A mapping or a
        // new field on the Problem model is needed. Using "MEDIUM" as a placeholder.
        const bountyDifficulty = "MEDIUM";

        const previouslySolvedSubmission = await prisma.submission.findFirst({
          where: {
            problemId: problemId,
            status: "ACCEPTED",
          },
        });

        const isSolved = !!previouslySolvedSubmission;

        calculatedScore = ScoreBounty(bountyDifficulty, executionCount, isSolved);
        console.log(`📊 [SUBMIT] Round2 Bounty Score: ${calculatedScore}`);

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
        console.warn(`[Round 2] Unknown or missing context type: ${context?.type}`);
      }
    }

    console.log("📊 [SUBMIT] Final calculated score:", calculatedScore);

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
        console.log("⬆️ [SUBMIT] Improved score:", {
          previousBestScore,
          calculatedScore,
          scoreImprovement,
        });
      } else {
        finalSubmission = await prisma.submission.update({
          where: { id: existingSubmission.id },
          data: { executionCount },
        });
        console.log("⚠️ [SUBMIT] No score improvement:", {
          previousBestScore,
          calculatedScore,
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
      console.log("🆕 [SUBMIT] First submission created:", finalSubmission.id);
    }

    if (scoreImprovement > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { eventScore: { increment: scoreImprovement } },
      });
      console.log(
        `📈 [SUBMIT] User ${userId} eventScore increased by ${scoreImprovement}`
      );
    }

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
    res.status(500).json({
      error: "Failed to submit code",
      details: error.response?.data || error.message,
    });
  }
});

export default router;