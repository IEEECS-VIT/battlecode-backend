import express from "express";
import axios from "axios";
import http from 'http';
import prisma from "../config/prisma.js";
import redis from "../config/redis.js";
import { ScoreRound0, ScoreRound1 } from "../utils/calculateScore.js";
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
 * (This route is unchanged)
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
      select: { sampleTestCases: true, title: true }
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

    const httpAgent = new http.Agent();
    const axiosConfig = {
      httpAgent,
      headers: JUDGE0_API_KEY ? { "X-RapidAPI-Key": JUDGE0_API_KEY } : {}
    };

    const submissions = sampleTestCases.map((testCase) => ({
      language_id,
      source_code,
      stdin: testCase.stdin || testCase.input || "",
      expected_output: testCase.expected_output || testCase.output || "",
    }));

    const submissionResponse = await axios.post(
      `${JUDGE0_API_URL}/submissions/batch`,
      { submissions },
      axiosConfig
    );

    const tokens = submissionResponse.data.map(item => item.token);
    let results = [];
    const startTime = Date.now();
    const timeout = 15000;

    while (results.length < tokens.length && Date.now() - startTime < timeout) {
      const pendingTokens = tokens.filter(
        token => !results.some(r => r.token === token)
      );

      if (pendingTokens.length === 0) break;

      const statusResponses = await Promise.all(
        pendingTokens.map(token =>
          axios.get(`${JUDGE0_API_URL}/submissions/${token}`, axiosConfig)
            .catch(err => ({ data: { token, error: err.message } }))
        )
      );

      for (const response of statusResponses) {
        const data = response.data;
        if (results.some(r => r.token === data.token)) continue;
        const statusId = data.status?.id;
        if (statusId > 2) {
          results.push({
            token: data.token,
            status: data.status,
            stdout: data.stdout,
            stderr: data.stderr,
            compile_output: data.compile_output,
            time: data.time,
            memory: data.memory,
            passed: data.status?.id === 3
          });
        }
      }
      if (results.length < tokens.length) await sleep(1000);
    }

    if (results.length < tokens.length) {
      return res.status(408).json({ error: "Execution timed out" });
    }

    const passedCount = results.filter(r => r.passed).length;
    const totalCount = sampleTestCases.length;

    res.status(200).json({
      success: true,
      results,
      summary: {
        passed: passedCount,
        total: totalCount,
      }
    });

  } catch (error) {
    console.error("Run execution error:", error.message);
    res.status(500).json({
      error: "Failed to execute code",
      details: error.response?.data || error.message
    });
  }
});


/**
 * POST /submit
 * This route is now fully updated with the new "upsert" logic
 */
router.post("/submit", verifyAuthToken, async (req, res) => {
  try {
    const { language, source_code, problemId, roundNumber,context } = req.body;
    

    const userId = req.user?.email;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userExists = await prisma.user.findUnique({
        where: { id: userId },
    });

    if (!userExists) {
        return res.status(404).json({ error: "Authenticated user not found. Please log out and log in again." });
    }
    
    if (!language || !source_code || !problemId || roundNumber === undefined) {
      return res.status(400).json({
        error: "Missing required fields: language, source_code, problemId, roundNumber",
      });
    }

    const language_id = LANGUAGE_ID_MAP[language.toLowerCase()];
    if (!language_id) {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      select: {
        sampleTestCases: true, hiddenTestCases: true, title: true,
        roundId: true, difficulty: true,
      }
    });

    if (!problem) {
      return res.status(404).json({ error: "Problem not found" });
    }

    if (problem.roundId !== roundNumber) {
      return res.status(400).json({ error: "Problem does not belong to specified round" });
    }

    const sampleTestCases = Array.isArray(problem.sampleTestCases) ? problem.sampleTestCases : (problem.sampleTestCases.testCases || []);
    const hiddenTestCases = Array.isArray(problem.hiddenTestCases) ? problem.hiddenTestCases : (problem.hiddenTestCases.testCases || []);
    const allTestCases = [...sampleTestCases, ...hiddenTestCases];

    if (allTestCases.length === 0) {
      return res.status(400).json({ error: "No test cases found" });
    }

    // --- Judge0 Execution Logic (remains the same) ---
    const httpAgent = new http.Agent();
    const axiosConfig = { httpAgent, headers: JUDGE0_API_KEY ? { "X-RapidAPI-Key": JUDGE0_API_KEY } : {} };
    const submissions = allTestCases.map((testCase) => ({
      language_id, source_code,
      stdin: testCase.stdin || testCase.input || "",
      expected_output: testCase.expected_output || testCase.output || "",
    }));
    const submissionResponse = await axios.post(`${JUDGE0_API_URL}/submissions/batch`, { submissions }, axiosConfig);
    const tokens = submissionResponse.data.map(item => item.token);
    let results = [];
    const startTime = Date.now();
    const timeout = 20000;
    while (results.length < tokens.length && Date.now() - startTime < timeout) {
        const pendingTokens = tokens.filter(token => !results.some(r => r.token === token));
        if (pendingTokens.length === 0) break;
        const statusResponses = await Promise.all(pendingTokens.map(token => axios.get(`${JUDGE0_API_URL}/submissions/${token}`, axiosConfig).catch(err => ({ data: { token, error: err.message } }))));
        for (const response of statusResponses) {
            const data = response.data;
            if (results.some(r => r.token === data.token)) continue;
            const statusId = data.status?.id;
            if (statusId > 2) {
                results.push({ token: data.token, status: data.status, stdout: data.stdout, stderr: data.stderr, compile_output: data.compile_output, time: data.time, memory: data.memory, passed: data.status?.id === 3 });
            }
        }
        if (results.length < tokens.length) await sleep(1000);
    }
    if (results.length < tokens.length) {
      return res.status(408).json({ error: "Submission execution timed out" });
    }
    const passedCount = results.filter(r => r.passed).length;
    const totalCount = allTestCases.length;
    let submissionStatus;
    if (results.some(r => r.compile_output)) submissionStatus = 'COMPILATION_ERROR';
    else if (results.some(r => r.stderr)) submissionStatus = 'RUNTIME_ERROR';
    else if (results.some(r => parseFloat(r.time) > 2.0)) submissionStatus = 'TIME_LIMIT_EXCEEDED';
    else if (passedCount === totalCount) submissionStatus = 'ACCEPTED';
    else submissionStatus = 'WRONG_ANSWER';

    // --- New "Upsert" and Scoring Logic ---
    
    // Find any existing submission for this user and problem.
    const existingSubmission = await prisma.submission.findFirst({
        where: { userId: userId, problemId: problemId }
    });
    
    const executionCount = (existingSubmission?.executionCount || 0) + 1;

    // Calculate score for the current attempt
    let calculatedScore = 0;
    if (roundNumber === 0) {
      calculatedScore = ScoreRound0(totalCount, passedCount, executionCount);
    } else if (roundNumber === 1) {
      // (Round 1 scoring logic is unchanged for this example)
      const keys = getRound1RedisKeys();
      const allMatchesStr = await redis.hgetall(keys.matches);
      let activeMatch = null;

      for (const matchId in allMatchesStr) {
          const match = JSON.parse(allMatchesStr[matchId]);
          if (match.players.includes(userId) && match.problemId === problemId) {
              activeMatch = match;
              break;
          }
      }

      if (activeMatch) {
          const isWinner = submissionStatus === 'ACCEPTED';
          const difficultyTimeMap = { "R1_EASY": 15 * 60, "R1_MEDIUM": 20 * 60, "R1_HARD": 25 * 60 };
          const totalTimeInSeconds = difficultyTimeMap[problem.difficulty] || 0;
          const elapsedTimeInSeconds = (Date.now() - activeMatch.startTime) / 1000;
          const timeLeftInSeconds = Math.max(0, totalTimeInSeconds - elapsedTimeInSeconds);

          calculatedScore = ScoreRound1(timeLeftInSeconds, totalCount, passedCount, problem.difficulty, isWinner, executionCount);
          console.log("Function returned: ", calculatedScore)
          if (isWinner) {
              const round1MatchEndHandler = getRound1MatchEndHandler();
              if (round1MatchEndHandler) {
                  await round1MatchEndHandler(activeMatch.id, userId);
              }
          }
      } else {
          console.warn(`[Round 1] No active match found for user ${userId}. No score calculated.`);
      }
    }

      if (roundNumber === 2) {
        const { matchEndHandler, bountyEndHandler } = getRound2Handlers();
        const isCorrect = submissionStatus === 'ACCEPTED';

        if (context?.type === 'match' && matchEndHandler) {
            if (isCorrect) {
                await matchEndHandler(context.contextId, userId, 'submission');
            }
        } else if (context?.type === 'bounty' && bountyEndHandler) {
            const submissionData = {
                userId, problemId, roundId: 2, code: source_code, language,
                status: submissionStatus, testCasesPassed: passedCount,
            };
            await bountyEndHandler(userId, problemId, isCorrect, submissionData);
        }
    }

    let scoreImprovement = 0;
    let finalSubmission;

    if (existingSubmission) {
        // UPDATE PATH: A submission already exists
        const previousBestScore = existingSubmission.score || 0;

        if (calculatedScore > previousBestScore) {
            // If new score is better, update the existing submission
            finalSubmission = await prisma.submission.update({
                where: { id: existingSubmission.id },
                data: {
                    code: source_code, language: language, status: submissionStatus,
                    runtime: Math.max(...results.map(r => parseFloat(r.time) || 0)),
                    memory: Math.max(...results.map(r => parseInt(r.memory) || 0)),
                    testCasesPassed: passedCount, executionCount: executionCount,
                    score: calculatedScore
                }
            });
            scoreImprovement = calculatedScore - previousBestScore;
            console.log(`[Scoring] User ${userId} improved score for problem ${problemId}. New best: ${calculatedScore}`);
        } else {
            // If new score is not better, just update the execution count
            finalSubmission = await prisma.submission.update({
                where: { id: existingSubmission.id },
                data: { executionCount: executionCount }
            });
            console.log(`[Scoring] User ${userId} did not improve score for problem ${problemId}.`);
        }
    } else {
        // CREATE PATH: No previous submission exists
        finalSubmission = await prisma.submission.create({
            data: {
                userId: userId, problemId: problemId, roundId: roundNumber,
                code: source_code, language: language, status: submissionStatus,
                runtime: Math.max(...results.map(r => parseFloat(r.time) || 0)),
                memory: Math.max(...results.map(r => parseInt(r.memory) || 0)),
                testCasesPassed: passedCount, executionCount: executionCount,
                score: calculatedScore
            }
        });
        scoreImprovement = calculatedScore; // The improvement is the whole score
        console.log(`[Scoring] User ${userId} created first submission for problem ${problemId}. Score: ${calculatedScore}`);
    }

    // Update the user's total event score only if there's an improvement.
    if (scoreImprovement > 0) {
        await prisma.user.update({
            where: { id: userId },
            data: {
                eventScore: {
                    increment: scoreImprovement
                }
            }
        });
        console.log(`[Scoring] User ${userId} total eventScore increased by ${scoreImprovement.toFixed(2)}.`);
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
      summary: {
        passed: passedCount,
        total: totalCount,
      }
    });

  } catch (error) {
    console.error("Submit execution error:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to submit code",
      details: error.response?.data || error.message
    });
  }
});

export default router;