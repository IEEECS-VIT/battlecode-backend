import express from "express";
import axios from "axios";
import http from 'http';

const router = express.Router();

// Judge0 API configuration
const JUDGE0_API_URL = process.env.JUDGE0_API_URL
const JUDGE0_API_KEY = null; // Add if using RapidAPI hosted version

// Language ID mapping
const LANGUAGE_ID_MAP = {
  cpp: 54,
  python: 71,
  javascript: 63,
  java: 62,
  c: 50,
};

// Helper function to delay execution
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /execute
 * Submits code to Judge0 for execution and returns the result
 */
router.post("/execute", async (req, res) => {
  try {
    const { language, source_code, stdin, expected_output } = req.body;

    // Validate required fields
    if (!language || !source_code) {
      return res.status(400).json({
        error: "Missing required fields: language and source_code",
      });
    }

    const language_id = LANGUAGE_ID_MAP[language.toLowerCase()];
    if (!language_id) {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    // Create HTTP agent to prevent SSL issues
    const httpAgent = new http.Agent();
    const axiosConfig = {
      httpAgent,
      headers: JUDGE0_API_KEY 
        ? { "X-RapidAPI-Key": JUDGE0_API_KEY }
        : {}
    };

    // 1. Submit the code to Judge0
    const submissionResponse = await axios.post(
      `${JUDGE0_API_URL}/submissions`,
      {
        language_id,
        source_code,
        stdin: stdin || "",
        expected_output: expected_output || "",
        wait: false // We'll poll for results
      },
      axiosConfig
    );

    const token = submissionResponse.data.token;

    // 2. Poll for the result (with timeout)
    const startTime = Date.now();
    const timeout = 10000; // 10 seconds timeout
    let result;

    while (Date.now() - startTime < timeout) {
      const resultResponse = await axios.get(
        `${JUDGE0_API_URL}/submissions/${token}`,
        axiosConfig
      );

      const statusId = resultResponse.data.status?.id;

      // Status IDs:
      // 1: In Queue, 2: Processing, 3: Accepted
      // Other statuses mean we're done
      if (statusId === 1 || statusId === 2) {
        await sleep(1000); // Wait 1 second before polling again
      } else {
        result = resultResponse.data;
        break;
      }
    }

    if (!result) {
      return res.status(408).json({ error: "Execution timed out" });
    }

    // 3. Format the response
    const response = {
      status: {
        id: result.status.id,
        description: result.status.description,
      },
      stdout: result.stdout,
      stderr: result.stderr,
      compile_output: result.compile_output,
      time: result.time,
      memory: result.memory,
      exit_code: result.exit_code,
      exit_signal: result.exit_signal,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Judge0 execution error:", error.message);
    res.status(500).json({
      error: "Failed to execute code",
      details: error.response?.data || error.message
    });
  }
});

/**
 * POST /execute-batch
 * Submits multiple test cases as a batch to Judge0
 */
router.post("/execute-batch", async (req, res) => {
  try {
    const { language, source_code, test_cases } = req.body;

    // Validate required fields
    if (!language || !source_code || !test_cases || !Array.isArray(test_cases)) {
      return res.status(400).json({
        error: "Missing required fields: language, source_code, or test_cases",
      });
    }

    const language_id = LANGUAGE_ID_MAP[language.toLowerCase()];
    if (!language_id) {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    // Create HTTP agent to prevent SSL issues
    const httpAgent = new http.Agent();
    const axiosConfig = {
      httpAgent,
      headers: JUDGE0_API_KEY 
        ? { "X-RapidAPI-Key": JUDGE0_API_KEY }
        : {}
    };

    // Prepare submissions
    const submissions = test_cases.map((testCase, index) => ({
      language_id,
      source_code,
      stdin: testCase.stdin || "",
      expected_output: testCase.expected_output || "",
      callback_url: testCase.callback_url || null,
    }));

    // Submit batch
    const submissionResponse = await axios.post(
      `${JUDGE0_API_URL}/submissions/batch`,
      { submissions },
      axiosConfig
    );

    const tokens = submissionResponse.data.map(item => item.token);

    // Poll for results
    const results = [];
    const startTime = Date.now();
    const timeout = 15000; // 15 seconds timeout

    while (results.length < tokens.length && Date.now() - startTime < timeout) {
      // Get all pending tokens (those not in results yet)
      const pendingTokens = tokens.filter(
        token => !results.some(r => r.token === token)
      );

      // Get statuses for pending tokens
      const statusResponses = await Promise.all(
        pendingTokens.map(token => 
          axios.get(`${JUDGE0_API_URL}/submissions/${token}`, axiosConfig)
            .catch(err => ({ data: { token, error: err.message } }))
        )
      );

      // Process responses
      for (const response of statusResponses) {
        const data = response.data;
        
        // Skip if already in results
        if (results.some(r => r.token === data.token)) continue;

        const statusId = data.status?.id;

        if (statusId === 1 || statusId === 2) {
          // Still processing, leave in queue
          continue;
        } else {
          // Done processing, add to results
          results.push({
            token: data.token,
            status: data.status,
            stdout: data.stdout,
            stderr: data.stderr,
            compile_output: data.compile_output,
            time: data.time,
            memory: data.memory,
          });
        }
      }

      // If we have all results, break early
      if (results.length === tokens.length) break;

      // Otherwise wait before polling again
      await sleep(1000);
    }

    // Check for timeout
    if (results.length < tokens.length) {
      return res.status(408).json({
        error: "Batch execution timed out",
        completed: results,
        pending: tokens.filter(
          token => !results.some(r => r.token === token)
        ),
      });
    }

    res.status(200).json({ results });
  } catch (error) {
    console.error("Judge0 batch execution error:", error.message);
    res.status(500).json({
      error: "Failed to execute batch",
      details: error.response?.data || error.message
    });
  }
});

export default router;