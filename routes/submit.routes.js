import express from "express";
import axios from "axios";
import http from 'http';
import prisma from "../config/prisma.js";
import redis from "../config/redis.js";
import { ScoreRound0 } from "../utils/calculateScore.js";
import verifyAuthToken from "../middleware/authMiddleware.js";
import { getRound1MatchEndHandler } from "../sockets/round1.handler.js";

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

// Helper to get Redis keys, consistent with your handler
const getRound1RedisKeys = () => ({
    matches: `round1:matches`,
});

/**
 * POST /run
 * Test code against sample test cases only (no database changes)
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
        if (statusId > 2) { // Processing is finished
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
 * Submit code against all test cases with database updates and scoring
 */
router.post("/submit", verifyAuthToken, async (req, res) => {
  try {
    const { language, source_code, problemId, roundNumber } = req.body;
    const userId = req.user?.email;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
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
        sampleTestCases: true, 
        hiddenTestCases: true, 
        title: true,
        roundId: true
      }
    });

    if (!problem) {
      return res.status(404).json({ error: "Problem not found" });
    }

    if (problem.roundId !== roundNumber) {
      return res.status(400).json({ error: "Problem does not belong to specified round" });
    }

    const sampleTestCases = Array.isArray(problem.sampleTestCases) ? problem.sampleTestCases : problem.sampleTestCases.testCases || [];
    const hiddenTestCases = Array.isArray(problem.hiddenTestCases) ? problem.hiddenTestCases : problem.hiddenTestCases.testCases || [];
    const allTestCases = [...sampleTestCases, ...hiddenTestCases];

    if (allTestCases.length === 0) {
      return res.status(400).json({ error: "No test cases found" });
    }

    const httpAgent = new http.Agent();
    const axiosConfig = {
      httpAgent,
      headers: JUDGE0_API_KEY ? { "X-RapidAPI-Key": JUDGE0_API_KEY } : {}
    };

    const submissions = allTestCases.map((testCase) => ({
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
    const timeout = 20000;

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
      return res.status(408).json({ error: "Submission execution timed out" });
    }

    const passedCount = results.filter(r => r.passed).length;
    const totalCount = allTestCases.length;

    let submissionStatus;
    if (results.some(r => r.compile_output)) {
      submissionStatus = 'COMPILATION_ERROR';
    } else if (results.some(r => r.stderr)) {
      submissionStatus = 'RUNTIME_ERROR';
    } else if (results.some(r => parseFloat(r.time) > 2.0)) {
      submissionStatus = 'TIME_LIMIT_EXCEEDED';
    } else if (passedCount === totalCount) {
      submissionStatus = 'ACCEPTED';
    } else {
      submissionStatus = 'WRONG_ANSWER';
    }

    const existingSubmissions = await prisma.submission.findMany({
      where: { userId: userId, problemId: problemId },
      orderBy: { createdAt: 'desc' }
    });
    const executionCount = existingSubmissions.length + 1;

    const submission = await prisma.submission.create({
      data: {
        userId: userId,
        problemId: problemId,
        roundId: roundNumber,
        code: source_code,
        language: language,
        status: submissionStatus,
        runtime: Math.max(...results.map(r => parseFloat(r.time) || 0)),
        memory: Math.max(...results.map(r => parseInt(r.memory) || 0)),
        testCasesPassed: passedCount,
        executionCount: executionCount
      }
    });
    
    if (roundNumber === 1 && submissionStatus === 'ACCEPTED') {
      try {
        const keys = getRound1RedisKeys();
        const allMatchesStr = await redis.hgetall(keys.matches);
        let activeMatchId = null;

        for (const matchId in allMatchesStr) {
            const match = JSON.parse(allMatchesStr[matchId]);
            if (match.players.includes(userId) && match.problemId === problemId) {
                activeMatchId = matchId;
                break;
            }
        }

        if (activeMatchId) {
          console.log(`[Round 1] User ${userId} passed all test cases for match ${activeMatchId}.`);
          const round1MatchEndHandler = getRound1MatchEndHandler();
          if (round1MatchEndHandler) {
            await round1MatchEndHandler(activeMatchId, userId);
            console.log(`[Round 1] Match end handler called for match ${activeMatchId}. Winner: ${userId}`);
          } else {
            console.error('[Round 1] CRITICAL: Match end handler is not available.');
          }
        } else {
            console.warn(`[Round 1] User ${userId} passed tests, but no active match was found in Redis for problem ${problemId}.`);
        }
      } catch (matchEndError) {
        console.error('[Round 1] Error during match completion logic:', matchEndError);
      }
    }

    if (roundNumber === 0) {
      // Handle Round 0 scoring logic if needed
    }
    
    res.status(200).json({
      success: true,
      submission: {
        id: submission.id,
        status: submissionStatus,
        testCasesPassed: passedCount,
        totalTestCases: totalCount,
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