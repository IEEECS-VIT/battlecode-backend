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

// Add connection retry logic
const connectWithRetry = async () => {
  try {
    await prisma.$connect();
    console.log('Prisma connected successfully');
  } catch (error) {
    console.error('Failed to connect to database:', error.message);
    console.log('Retrying connection in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};

// Initialize connection with retry
connectWithRetry();

// Handle graceful shutdown
const gracefulShutdown = async () => {
  console.log('Gracefully shutting down Prisma client...');
  try {
    await prisma.$disconnect();
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
});

// Add middleware to ensure connections are properly released
prisma.$use(async (params, next) => {
  try {
    const result = await next(params);
    return result;
  } catch (error) {
    console.error('Database operation error:', error.message);
    throw error;
  }
});

export default prisma;
