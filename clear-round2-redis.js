import redis from "./config/redis.js";

async function clearRound2RedisState() {
    try {
        console.log("🧹 Clearing Redis state for Round 2...");
        
        // Use a pattern to find all keys related to Round 2
        const round2Keys = await redis.keys("round2:*");
        
        console.log(`📝 Found ${round2Keys.length} keys to delete:`);
        if (round2Keys.length < 20) { // Only print if the list is manageable
            round2Keys.forEach(key => console.log(`   - ${key}`));
        } else {
            console.log(`   (Too many keys to list, starting deletion...)`);
        }
        
        if (round2Keys.length > 0) {
            // Delete all keys found
            const deletedCount = await redis.del(round2Keys);
            console.log(`✅ Successfully deleted ${deletedCount} Redis keys for Round 2.`);
        } else {
            console.log("ℹ️  No Round 2 keys found in Redis.");
        }
        
        console.log("\n🎉 Round 2 Redis state cleared successfully!");
        
    } catch (error) {
        console.error("❌ Error clearing Round 2 Redis state:", error);
    } finally {
        // Close Redis connection
        await redis.quit();
        console.log("🔐 Redis connection closed.");
    }
}

clearRound2RedisState();