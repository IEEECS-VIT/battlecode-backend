import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  log: ["warn", "error"], // Reduce logging to prevent noise
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  errorFormat: 'minimal',
});

// Global connection tracking
let isConnected = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 30;

// Add connection retry logic with exponential backoff
const connectWithRetry = async () => {
  if (isConnected) return;
  
  try {
    await prisma.$connect();
    console.log('Prisma connected successfully');
    isConnected = true;
    connectionAttempts = 0;
  } catch (error) {
    connectionAttempts++;
    console.error(`Failed to connect to database (attempt ${connectionAttempts}):`, error.message);
    
    if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
      const delay = Math.min(1000 * Math.pow(2, connectionAttempts), 30000); // Exponential backoff, max 30s
      console.log(`Retrying connection in ${delay/1000} seconds...`);
      setTimeout(connectWithRetry, delay);
    } else {
      console.error('Max connection attempts reached. Service may be degraded.');
    }
  }
};

// Health check function
const healthCheck = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    if (!isConnected) {
      isConnected = true;
      console.log('Database connection restored');
    }
    return true;
  } catch (error) {
    if (isConnected) {
      isConnected = false;
      console.error('Database connection lost:', error.message);
    }
    return false;
  }
};

// Initialize connection with retry
connectWithRetry();

// Periodic health check every 30 seconds
setInterval(async () => {
  if (!await healthCheck()) {
    console.log('Health check failed, attempting reconnection...');
    connectWithRetry();
  }
}, 30000);

// Handle graceful shutdown
const gracefulShutdown = async () => {
  console.log('Gracefully shutting down Prisma client...');
  try {
    await prisma.$disconnect();
    isConnected = false;
    console.log('Prisma client disconnected successfully');
  } catch (error) {
    console.error('Error during Prisma disconnect:', error);
  }
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Handle connection errors
prisma.$on('error', (e) => {
  console.error('Prisma client error:', e);
  isConnected = false;
});

// Add middleware to ensure connections are properly handled with retry logic
prisma.$use(async (params, next) => {
  let retries = 3;
  while (retries > 0) {
    try {
      const result = await next(params);
      return result;
    } catch (error) {
      retries--;
      console.error(`Database operation error (${retries} retries left):`, error.message);
      
      if (retries === 0) {
        console.error('Final database operation failed:', error.message);
        throw error;
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to reconnect if connection seems lost
      if (error.message.includes("Can't reach database server")) {
        isConnected = false;
        await connectWithRetry();
      }
    }
  }
});

export default prisma;
