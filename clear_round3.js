import redis from "./config/redis.js";

async function clearRound3RedisState() {
    try {
        console.log("🧹 Clearing Redis state for Round 3...");

        // Define all Round 3 Redis keys based on the handler
        const round3Keys = [
            "round3:lobby",
            "round3:state",
            "round3:timer:global",
            "round3:problems"
        ];

        console.log("📝 The following keys will be targeted for deletion:");
        round3Keys.forEach(key => console.log(`   - ${key}`));

        // The 'del' command handles non-existent keys gracefully by ignoring them.
        // We can directly attempt to delete the list of keys.
        const deletedCount = await redis.del(...round3Keys);

        if (deletedCount > 0) {
             console.log(`\n✅ Successfully deleted ${deletedCount} Redis key(s) for Round 3.`);
        } else {
             console.log("\nℹ️ No Round 3 keys were found in Redis to delete.");
        }

        // Verify the deletion to be certain
        console.log("\n🔍 Verifying deletion:");
        for (const key of round3Keys) {
            const exists = await redis.exists(key);
            console.log(`   ${key}: ${exists ? '❌ Still exists' : '✅ Deleted'}`);
        }

        console.log("\n🎉 Round 3 Redis state cleared successfully!");

    } catch (error) {
        console.error("❌ Error clearing Round 3 Redis state:", error);
    } finally {
        // Close the Redis connection to allow the script to exit gracefully
        await redis.quit();
        console.log("🔐 Redis connection closed.");
    }
}

// Execute the function
clearRound3RedisState();