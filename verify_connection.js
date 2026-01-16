import prisma from './config/prisma.js';

async function main() {
    try {
        console.log('Testing database connection...');
        const result = await prisma.$queryRaw`SELECT 1 as result`;
        console.log('Connection successful:', result);
    } catch (error) {
        console.error('Connection failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
