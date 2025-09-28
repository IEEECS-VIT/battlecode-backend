import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "./config/prisma.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse CSV file and return array of objects
 * @param {string} filePath - Path to CSV file
 * @returns {Array} Array of user objects
 */
function parseCSV(filePath) {
  try {
    const csvContent = fs.readFileSync(filePath, "utf-8");
    const lines = csvContent.trim().split("\n");

    if (lines.length < 2) {
      throw new Error(
        "CSV file must have at least a header row and one data row"
      );
    }

    // Parse header row
    const headers = lines[0]
      .split(",")
      .map((header) => header.replace(/"/g, "").trim());

    // Parse data rows
    const users = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length !== headers.length) {
        console.warn(
          `Row ${i + 1} has ${values.length} columns but expected ${
            headers.length
          }. Skipping...`
        );
        continue;
      }

      const user = {};
      headers.forEach((header, index) => {
        user[header] = values[index];
      });

      users.push(user);
    }

    return users;
  } catch (error) {
    console.error("Error parsing CSV file:", error.message);
    throw error;
  }
}

/**
 * Parse a single CSV line handling quoted values with commas
 * @param {string} line - CSV line to parse
 * @returns {Array} Array of values
 */
function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

/**
 * Transform CSV user data to match database schema
 * @param {Object} csvUser - User data from CSV
 * @returns {Object} Transformed user data for database
 */
function transformUser(csvUser) {
  // Map common CSV column names to database fields
  const columnMappings = {
    id: "id",
    email: "id", // Use email as id if no id column
    name: "name",
    full_name: "name",
    fullName: "name",
    regNo: "regNo",
    registrationNumber: "regNo",
    registration_number: "regNo",
    reg_no: "regNo",
    username: "username",
    role: "role",
  };

  const user = {
    role: "PLAYER", // Default role
    eventScore: 0, // Default event score
    currentRound: 0, // Default current round
  };

  // Apply column mappings
  Object.entries(csvUser).forEach(([csvKey, value]) => {
    const dbKey = columnMappings[csvKey.toLowerCase()];
    if (dbKey && value && value.trim() !== "") {
      if (dbKey === "role") {
        // Validate role
        const validRoles = ["ADMIN", "PLAYER"];
        user[dbKey] = validRoles.includes(value.toUpperCase())
          ? value.toUpperCase()
          : "PLAYER";
      } else {
        user[dbKey] = value.trim();
      }
    }
  });

  // Validate required fields
  if (!user.id) {
    throw new Error("User must have an id (or email that can be used as id)");
  }
  if (!user.name) {
    throw new Error("User must have a name");
  }
  if (!user.regNo) {
    // If no regNo provided, generate one or use empty string
    user.regNo = user.id; // Use id as regNo if not provided
  }

  return user;
}

/**
 * Add users to the database
 * @param {Array} users - Array of user objects
 * @returns {Object} Summary of operation
 */
async function addUsers(users) {
  const summary = {
    total: users.length,
    added: 0,
    skipped: 0,
    errors: [],
  };

  for (let i = 0; i < users.length; i++) {
    const csvUser = users[i];

    try {
      const user = transformUser(csvUser);

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { id: user.id },
      });

      if (existingUser) {
        summary.skipped++;
        continue;
      }

      // Create user
      await prisma.user.create({
        data: user,
      });

      console.log(`✅ Added user: ${user.id} (${user.name})`);
      summary.added++;
    } catch (error) {
      const errorMsg = `Error processing user at row ${i + 2}: ${
        error.message
      }`;
      console.error(`❌ ${errorMsg}`);
      summary.errors.push({
        row: i + 2,
        user: csvUser,
        error: error.message,
      });
    }
  }

  return summary;
}

/**
 * Main function to run the script
 */
async function main() {
  try {
    // Get CSV file path from command line arguments
    const csvFilePath = process.argv[2];

    if (!csvFilePath) {
      console.error("❌ Please provide a CSV file path as an argument");
      process.exit(1);
    }

    // Check if file exists
    if (!fs.existsSync(csvFilePath)) {
      console.error(`❌ File not found: ${csvFilePath}`);
      process.exit(1);
    }

    // Parse CSV file
    const users = parseCSV(csvFilePath);

    // Show expected CSV format
    if (users.length === 0) {
      console.log("⚠️  No users to process");
      return;
    }

    // Show sample user for confirmation
    console.log("\n🔍 Sample user from CSV:");
    console.log(JSON.stringify(users[0], null, 2));

    // Add users to database
    const summary = await addUsers(users);

    if (summary.errors.length > 0) {
      console.log("\n❌ Errors encountered:");
      summary.errors.forEach((error) => {
        console.log(`Row ${error.row}: ${error.error}`);
      });
    }

    if (summary.added > 0) {
      console.log(
        `\n🎉 Successfully added ${summary.added} new users to the database!`
      );
    }
  } catch (error) {
    console.error("❌ Fatal error:", error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { parseCSV, transformUser, addUsers };
