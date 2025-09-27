import redis from "./config/redis.js";

/**
 * Clears all Redis keys associated with Round 0.
 * * This script identifies and deletes the following keys:
 * - The global lobby hash ('round0:lobby')
 * - The global timer ('round0:timer:global')
 * - The stored problems ('round0:problems')
 * - All user-specific state keys (pattern: 'round0:state:*')
 * - All user-specific progress keys (pattern: 'round0:progress:*')
 * - All user-specific presence keys (pattern: 'round0:user:*')
 */
async function clearRound0RedisState() {
    try {
        console.log("🧹 Clearing Redis state for Round 0...");

        // Define static keys and patterns for dynamic keys
        const staticKeys = [
            "round0:lobby",
            "round0:timer:global",
            "round0:problems"
        ];
        
        const keyPatterns = [
            "round0:state:*",
            "round0:progress:*",
            "round0:user:*"
        ];

        // Fetch all keys matching the patterns
        let dynamicKeys = [];
        for (const pattern of keyPatterns) {
            const keys = await redis.keys(pattern);
            dynamicKeys = dynamicKeys.concat(keys);
        }

        // Combine all keys to be deleted
        const allKeysToDelete = [...staticKeys, ...dynamicKeys];

        if (allKeysToDelete.length === staticKeys.length && dynamicKeys.length === 0) {
            console.log("ℹ️  No dynamic user keys found. Checking for static keys only.");
        }

        console.log(`📝 Found ${allKeysToDelete.length} keys to delete:`);
        allKeysToDelete.forEach(key => console.log(`   - ${key}`));

        if (allKeysToDelete.length > 0) {
            // Delete all the found keys
            const deletedCount = await redis.del(allKeysToDelete);
            console.log(`✅ Successfully deleted ${deletedCount} Redis keys for Round 0`);
        } else {
            console.log("ℹ️  No Round 0 keys found in Redis to delete.");
        }

        // --- Verification Step ---
        console.log("\n🔍 Verifying deletion...");
        let allVerified = true;
        for (const key of staticKeys) {
            const exists = await redis.exists(key);
            if (exists) {
                console.log(`   - ${key}: ❌ Still exists`);
                allVerified = false;
            } else {
                console.log(`   - ${key}: ✅ Deleted`);
            }
        }
        const remainingDynamicKeys = await redis.keys("round0:*");
        if (remainingDynamicKeys.length > 0) {
            console.log("   - Dynamic keys: ❌ Some dynamic keys still exist:", remainingDynamicKeys);
            allVerified = false;
        } else {
            console.log("   - Dynamic keys (round0:*): ✅ All deleted");
        }

        if (allVerified) {
            console.log("\n🎉 Round 0 Redis state cleared successfully!");
        } else {
            console.log("\n⚠️  Verification failed. Some keys were not deleted.");
        }

    } catch (error) {
        console.error("❌ Error clearing Round 0 Redis state:", error);
    } finally {
        // Close the Redis connection
        await redis.quit();
        console.log("🔐 Redis connection closed");
    }
}

// Execute the script
clearRound0RedisState();