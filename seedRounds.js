import prisma from "./config/prisma.js";

async function seedRounds() {
  try {
    console.log("Seeding rounds...");

    // Create or upsert the 4 rounds
    const rounds = [
      { roundNumber: 0, status: 'IN_PROGRESS' }, // Qualifier - currently active for testing
      { roundNumber: 1, status: 'LOCKED' },     // Head to Head
      { roundNumber: 2, status: 'LOCKED' },     // Elite Bounties  
      { roundNumber: 3, status: 'LOCKED' }      // The Final Hack
    ];

    for (const round of rounds) {
      const result = await prisma.round.upsert({
        where: { roundNumber: round.roundNumber },
        update: { status: round.status },
        create: {
          roundNumber: round.roundNumber,
          status: round.status
        }
      });
      console.log(`Round ${result.roundNumber} created/updated with status: ${result.status}`);
    }

    console.log("Rounds seeded successfully!");
  } catch (error) {
    console.error("Error seeding rounds:", error);
    throw error;
  }
}

// Run the seed function
seedRounds()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
