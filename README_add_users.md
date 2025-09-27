# Add Users Script

This script allows you to bulk add users to the battlecode database from a CSV file.

## Usage

```bash
node add_users.js <path-to-csv-file>
```

### Example
```bash
node add_users.js ./users.csv
node add_users.js ../users_data.csv
```

## CSV Format

The CSV file should have a header row with the following columns (case insensitive):

### Required Columns
- **id** or **email** - Unique identifier for the user (will be used as the user ID)
- **name** or **full_name** or **fullName** - User's full name

### Optional Columns
- **regNo** or **registrationNumber** or **registration_number** or **reg_no** - Registration number
- **username** - Username (must be unique if provided)
- **role** - User role (ADMIN or PLAYER, defaults to PLAYER)

### Example CSV Format
```csv
id,name,regNo,username,role
john.doe@example.com,John Doe,REG001,johndoe,PLAYER
jane.smith@example.com,Jane Smith,REG002,janesmith,PLAYER
admin@example.com,Admin User,ADMIN001,admin,ADMIN
```

## Features

- ✅ **Duplicate Detection**: Skips users that already exist in the database
- ✅ **Error Handling**: Continues processing even if some rows have errors
- ✅ **Flexible CSV Format**: Accepts various column name variations
- ✅ **Validation**: Validates required fields and data types
- ✅ **Summary Report**: Shows detailed results after processing
- ✅ **Default Values**: Sets appropriate defaults for optional fields

## Default Values

When users are added, the following default values are set:
- `role`: PLAYER (if not specified or invalid)
- `eventScore`: 0
- `currentRound`: 0

## Error Messages

The script will show detailed error messages for:
- Missing required fields
- Duplicate users (skipped, not an error)
- Invalid CSV format
- Database connection issues

## Database Schema

Users are added to the `User` table with the following structure:
- `id` (String, Primary Key)
- `name` (String)
- `regNo` (String, Unique)
- `username` (String, Unique, Optional)
- `role` (Enum: ADMIN, PLAYER)
- `eventScore` (Int, default: 0)
- `currentRound` (Int, default: 0)

## Notes

- The script uses the existing Prisma configuration from `config/prisma.js`
- Make sure your database is running and accessible
- The script will not modify existing users, only add new ones
- Empty or whitespace-only values are treated as null/undefined
