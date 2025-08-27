import { Server } from "socket.io";
import { createServer } from "http";
import express from "express";
import redis from "../config/redis.js";
import { io } from "./socket.js"
import { verifySocketToken } from "../middleware/authMiddleware.js";
// round0_handler.js

import { GetProblems } from '../controller/matchController.js';
const REDIS_KEY = 'round0';
export const round0Handler = (io, socket) => {
  // Handle generic client message
  const handleClientMessage = (payload, callback) => {
      console.log(
        `Message from client ${socket.id} (User: ${socket.user.id}): "${payload.message}"`
      );
  
      socket.emit("server:messageReceived", {
        confirmation: `We received your message: "${payload.message}"`,
      });
  
      if (callback) {
        callback({ success: true, status: "Message handled by server." });
      }
    };
  
    socket.on("client:sendMessage", handleClientMessage);

  //fetch for round 0
  const fetchQuestion = async (payload, callback) => {
    try {
      const {difficulty = 'EASY', categories = [], limit = 1 } = payload || {};   //all keys with pairs defined in payload will be given to the variables difficulty, catgeories, limit

      const questions = await GetProblems(    //questions is an array
        limit,
        difficulty,   
        categories
      );

      if (!questions || questions.length === 0) {
        if (callback) callback({ success: false, error: 'No questions found' });
        return;
      }


      // Emit to frontend with 'questionFetched'
      socket.emit('questionFetched', { question: questions[0] });

      
      const redisKeyQuestions = `round0:questions:${userId}`;
      const redisKeyCurrentIndex = `round0:currentIndex:${userId}`;

      // Store questions as JSON string
      await redis.setex(redisKeyQuestions, 86400, JSON.stringify(questions)); // expire in 1 day
      await redis.set(redisKeyCurrentIndex, 0); // start with first question index

      if (callback) callback({ success: true, question: questions[0] });  // the callback function is what will send the 
    } catch (error) {
      console.error('Error fetching question:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  };

  socket.on('fetchQuestion', fetchQuestion);
  

  // Join lobby 
  const joinLobby = async (payload, callback) => {
    try {
      const userId = socket.user?.id;
      if (!userId) {
        return callback?.({ success: false, error: 'Unauthorized' });
      }

      const joinedAt = new Date().toISOString();

      // Store participant info in Redis hash
      await redis.hset(REDIS_KEY, userId, JSON.stringify({
        status: 'LOBBY',
        joinedAt,
      }));

      // Set a TTL key for presence expiry management
      await redis.setex(`round0:user:${userId}`, 86400, 'online'); // expires in 1 day

      // Fetch all active participants for lobby sync
      const allParticipantsRaw = await redis.hgetall(REDIS_KEY);
      const lobbyParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
        userId: uid,
        ...JSON.parse(value),
      }));

      // Optionally broadcast updated lobby to all connected Round 0 sockets
      io.emit('lobbyUpdate', { lobbyParticipants });

      // Respond to the joining client
      callback?.({ success: true, lobbyParticipants });
    } catch (error) {
      console.error('Round 0 join (socket) error:', error);
      callback?.({ success: false, error: 'Failed to join Round 0' });
    }
  };

  // Leave lobby (equivalent to /leave HTTP POST)
  const leaveLobby = async (payload, callback) => {
    try {
      const userId = socket.user?.id;
      if (!userId) {
        return callback?.({ success: false, error: 'Unauthorized' });
      }

      // Remove user from Redis hash and presence TTL key
      await redis.hdel(REDIS_KEY, userId);
      await redis.del(`round0:user:${userId}`);

      // Fetch lobby participants after removal
      const allParticipantsRaw = await redis.hgetall(REDIS_KEY);
      const lobbyParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
        userId: uid,
        ...JSON.parse(value),
      }));

      // Broadcast updated lobby to all connected sockets
      io.emit('lobbyUpdate', { lobbyParticipants });

      callback?.({ success: true, message: 'Left Round 0 lobby' });
    } catch (error) {
      console.error('Round 0 leave (socket) error:', error);
      callback?.({ success: false, error: 'Failed to leave Round 0' });
    }
  };

  // Register socket event listeners
  socket.on('round0:join', joinLobby);
  socket.on('round0:leave', leaveLobby);

  const lobby = async() => {
    const allParticipantsRaw = await redis.hgetall(REDIS_KEY);
    const lobbyParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
      userId: uid,
      ...JSON.parse(value),
      }));
    io.emit('lobby', lobbyParticipants);
  
  }
  io.on('lobby',lobby);

  const nextQuestion = async(_,callback) =>{ 
    const userId = socket.user?.id;     
    const redisKeyQuestions = `round0:questions:${userId}`;
    const redisKeyCurrentIndex = `round0:currentIndex:${userId}`;

    const questionsJson = await redis.get(redisKeyQuestions);
    const questions = JSON.parse(questionsJson);
  
    let currentIndex = parseInt(await redis.get(redisKeyCurrentIndex)) || 0;
    currentIndex += 1;    

    if (currentIndex < questions.length) {
    await redis.set(redisKeyCurrentIndex, currentIndex);
    const nextQuestion = questions[currentIndex];
    socket.emit('nextQuestion', { question: nextQuestion, questionIndex: currentIndex });
    if (callback) callback({ success: true, question: nextQuestion });
  } 
  else {
    if (callback) callback({ success: false, error: 'No more questions' });
  }
}


  io.on('nextQuestion', nextQuestion);

const reconnectRound0 = async (payload, callback) => {
    try {
      const userId = socket.user?.id;

      // Fetch user-specific game state from Redis
      // Assuming game state stored under keys like: round0:state:<userId>
      const gameStateRaw = await redis.get(`round0:state:${userId}`);

      if (!gameStateRaw) {
        return callback?.({ success: false, error: "No game state found" });
      }

      const gameState = JSON.parse(gameStateRaw);

      // Gamestate must be like:-
      // {
      //   questions: [...],
      //   currentQuestionIndex: number,
      //   timeRemaining: number (seconds)
      // }

      // Emit only to the reconnected user the full game state so they can resume
      socket.emit('round0:reconnect', gameState);

      // Optionally acknowledge success to the client
      
      if (callback) {
        callback?.({ success: true, gameState });
      }


    } catch (error) {
        console.error("Error in round0:reconnect", error);
        
        if (callback) {
          callback({ success: false, error: error.message });
        }
    }
  };

  // Reconnect event listener
  socket.on('round0:reconnect', reconnectRound0);



};


