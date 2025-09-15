import redis from "./config/redis.js";

async function clearRound1RedisState() {
    try {
        console.log("🧹 Clearing Redis state for Round 1...");
        
        // Define all Round 1 Redis keys based on the handler
        const round1Keys = [
            "round1:participants",
            "round1:readyQueue", 
            "round1:matches",
            "round1:status",
            "round1:startTime"
        ];
        
        // Get all keys that match round1:user:* pattern (user presence keys)
        const userPresenceKeys = await redis.keys("round1:user:*");
        
        // Combine all keys to delete
        const allKeysToDelete = [...round1Keys, ...userPresenceKeys];
        
        console.log(`📝 Found ${allKeysToDelete.length} keys to delete:`);
        allKeysToDelete.forEach(key => console.log(`   - ${key}`));
        
        if (allKeysToDelete.length > 0) {
            // Delete all keys
            const deletedCount = await redis.del(...allKeysToDelete);
            console.log(`✅ Successfully deleted ${deletedCount} Redis keys for Round 1`);
        } else {
            console.log("ℹ️  No Round 1 keys found in Redis");
        }
        
        // Verify deletion
        console.log("\n🔍 Verifying deletion:");
        for (const key of round1Keys) {
            const exists = await redis.exists(key);
            console.log(`   ${key}: ${exists ? '❌ Still exists' : '✅ Deleted'}`);
        }
        
        console.log("\n🎉 Round 1 Redis state cleared successfully!");
        
    } catch (error) {
        console.error("❌ Error clearing Round 1 Redis state:", error);
    } finally {
        // Close Redis connection
        await redis.quit();
        console.log("🔐 Redis connection closed");
    }
}

clearRound1RedisState();
