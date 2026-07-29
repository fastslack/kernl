# Multi-User Support

## Current Status

Kernl v1.0 includes the user management infrastructure:
- `users` table with password hashing (SHA-256 + salt)
- JWT token generation and verification
- UserService (create, authenticate, find)
- Default admin user auto-creation

## What's Implemented
- User CRUD (create, find by username/ID, authenticate)
- Password hashing with per-user salt
- JWT signing and verification (HS256, configurable expiry)

## What's Planned (Future Versions)
- Add `user_id` column to core tables (tasks, contacts, reminders, etc.)
- Row-level security (filter queries by authenticated user)
- User registration endpoint
- JWT-based auth flow (login -> token -> API access)
- Per-user dashboard data isolation
- User management UI in dashboard

## Architecture Notes

When `user_id` is added to tables, the migration path will be:
1. Add `user_id TEXT DEFAULT 'default'` to each table (non-breaking)
2. Assign existing data to the admin user
3. Update services to filter by `ctx.userId`
4. Update tools to pass user context
