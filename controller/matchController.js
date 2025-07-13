import prisma from "../config/prisma.js";

export async function GetProblems(
  noOfProblems,
  difficulty,
  categories = [],
  randomize = true
) {
  console.log("🔍 GetProblems called with:", {
    noOfProblems,
    difficulty,
    categories,
    randomize,
  });

  try {
    // Input validation with detailed logging
    if (!noOfProblems || noOfProblems <= 0) {
      console.error("❌ Invalid number of problems:", noOfProblems);
      throw new Error("Invalid number of problems");
    }

    if (!difficulty) {
      console.error("❌ Difficulty is required");
      throw new Error("Difficulty level is required");
    }

    const validDifficulties = ["EASY", "MEDIUM", "HARD"];
    const normalizedDifficulty = difficulty.toUpperCase();

    if (!validDifficulties.includes(normalizedDifficulty)) {
      console.error("❌ Invalid difficulty level:", difficulty);
      throw new Error("Invalid difficulty level");
    }

    console.log("✅ Input validation passed");

    // Test database connection first
    try {
      await prisma.$connect();
      console.log("✅ Database connection successful");
    } catch (connectionError) {
      console.error("❌ Database connection failed:", connectionError);
      throw new Error("Database connection failed");
    }

    // Prepare base query options
    const whereClause = {
      difficulty: normalizedDifficulty,
      ...(categories &&
        categories.length > 0 && {
          categories: {
            some: {
              name: {
                in: categories,
                mode: "insensitive",
              },
            },
          },
        }),
    };

    console.log("🔍 Query WHERE clause:", JSON.stringify(whereClause, null, 2));

    // First, check if any problems exist with the criteria
    let totalProblems;
    try {
      totalProblems = await prisma.problem.count({
        where: whereClause,
      });
      console.log(`📊 Total problems found: ${totalProblems}`);
    } catch (countError) {
      console.error("❌ Failed to count problems:", countError);
      throw new Error("Failed to count problems in database");
    }

    if (totalProblems === 0) {
      console.error("❌ No problems found with criteria:", whereClause);

      // Let's also check what problems exist in general
      let allProblemsCount;
      try {
        allProblemsCount = await prisma.problem.count();
        console.log(`📊 Total problems in database: ${allProblemsCount}`);
      } catch (error) {
        console.error("❌ Failed to get total problem count:", error);
        allProblemsCount = 0;
      }

      if (allProblemsCount === 0) {
        throw new Error("No problems found in database");
      }

      // Check what difficulties exist
      let availableDifficulties = [];
      try {
        availableDifficulties = await prisma.problem.findMany({
          select: { difficulty: true },
          distinct: ["difficulty"],
        });
        console.log("📊 Available difficulties:", availableDifficulties);
      } catch (error) {
        console.error("❌ Failed to get available difficulties:", error);
      }

      // Check what categories exist
      let availableCategories = [];
      try {
        availableCategories = await prisma.category.findMany({
          select: { name: true },
        });
        console.log("📊 Available categories:", availableCategories);
      } catch (error) {
        console.error("❌ Failed to get available categories:", error);
      }

      throw new Error(
        `No problems found with difficulty: ${normalizedDifficulty} and categories: ${categories.join(
          ", "
        )}`
      );
    }

    // Prepare query options
    const queryOptions = {
      where: whereClause,
      take: Math.min(Number(noOfProblems), totalProblems),
      include: {
        categories: true,
      },
    };

    // Add randomization if requested
    if (randomize && totalProblems > noOfProblems) {
      const maxSkip = Math.max(0, totalProblems - noOfProblems);
      const randomSkip = Math.floor(Math.random() * maxSkip);
      queryOptions.skip = randomSkip;
      console.log(
        `🎲 Randomization: skip ${randomSkip} of ${totalProblems} problems`
      );
    }

    console.log(
      "🔍 Final query options:",
      JSON.stringify(queryOptions, null, 2)
    );

    // Execute the query
    let problems;
    try {
      problems = await prisma.problem.findMany(queryOptions);
      console.log(`✅ Problems fetched: ${problems.length}`);
    } catch (queryError) {
      console.error("❌ Failed to fetch problems:", queryError);
      throw new Error("Failed to fetch problems from database");
    }

    if (!problems || problems.length === 0) {
      console.error("❌ No problems returned from query");
      throw new Error("No problems found with the specified criteria");
    }

    // Format the problems with all required fields
    const formattedProblems = problems.map((p) => {
      const formatted = {
        id: p.id,
        title: p.title,
        description: p.description,
        difficulty: p.difficulty,
        constraints: p.constraints || [],
        hints: p.hints || [],
        boilerplate: p.boilerplate || {
          python: "",
          cpp: "",
          java: "",
          c: "",
          javascript: "",
        },
        sampleTestCases: p.sampleTestCases || [],
        categories: p.categories?.map((c) => c.name) || [],
        avgTimeComplexity: p.avgTimeComplexity || "O(n)",
        avgSpaceComplexity: p.avgSpaceComplexity || "O(n)",
      };

      console.log(`📝 Formatted problem ${p.id}:`, {
        title: formatted.title,
        difficulty: formatted.difficulty,
        categories: formatted.categories,
        hasDescription: !!formatted.description,
        hasBoilerplate: !!formatted.boilerplate,
        testCasesCount: formatted.sampleTestCases.length,
      });

      return formatted;
    });

    console.log("✅ Problems formatted successfully");
    return formattedProblems;
  } catch (error) {
    console.error("❌ Error in GetProblems:", error);
    console.error("❌ Error stack:", error.stack);

    // Provide more specific error messages
    if (error.message.includes("connect")) {
      throw new Error(
        "Database connection failed. Please check your database configuration."
      );
    } else if (error.message.includes("No problems found")) {
      throw error; // Re-throw with original message
    } else {
      throw new Error(`Failed to fetch problems: ${error.message}`);
    }
  } finally {
    // Always disconnect from the database
    try {
      await prisma.$disconnect();
    } catch (disconnectError) {
      console.error("❌ Error disconnecting from database:", disconnectError);
    }
  }
}

// Helper function to check database health
export async function checkDatabaseHealth() {
  try {
    await prisma.$connect();

    const problemsCount = await prisma.problem.count().catch(() => 0);
    const categoriesCount = await prisma.category.count().catch(() => 0);

    console.log("🏥 Database Health Check:");
    console.log(`  Problems: ${problemsCount}`);
    console.log(`  Categories: ${categoriesCount}`);

    await prisma.$disconnect();

    return {
      healthy: true,
      problemsCount,
      categoriesCount,
    };
  } catch (error) {
    console.error("❌ Database health check failed:", error);
    return {
      healthy: false,
      error: error.message,
    };
  }
}

// Helper function to get available topics and difficulties
export async function getAvailableOptions() {
  try {
    await prisma.$connect();

    const difficulties = await prisma.problem
      .findMany({
        select: { difficulty: true },
        distinct: ["difficulty"],
      })
      .catch(() => []);

    const categories = await prisma.category
      .findMany({
        select: { name: true },
      })
      .catch(() => []);

    await prisma.$disconnect();

    return {
      difficulties: difficulties.map((d) => d.difficulty),
      categories: categories.map((c) => c.name),
    };
  } catch (error) {
    console.error("❌ Error getting available options:", error);
    await prisma.$disconnect();
    throw error;
  }
}
