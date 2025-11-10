# Sync Functions Documentation

This document explains when to use each synchronization function in the system.

## Overview

The system has **3 main sync functions**, each designed for specific use cases:

| Function | Purpose | When to Use | Execution Time |
|----------|---------|-------------|----------------|
| **backfill-sync** | Bulk shadow creation | Initial setup, recovering from data loss | ~5 minutes for 24K records |
| **enterprise-sync** | Full bidirectional sync | Regular scheduled syncs, bulk updates | ~2 minutes for 500 records |
| **smart-sync** | Incremental targeted sync | Small updates, specific emails, real-time changes | ~10 seconds for 100 emails |

---

## 1. backfill-sync (Bulk Initialization)

### Purpose
Creates shadow snapshots for ALL crosswalk entries in bulk. This is the **foundation** that must run first before other syncs can work properly.

### When to Use
- ✅ **First-time setup**: When initializing the sync system
- ✅ **Recovery**: After data migration or corruption
- ✅ **Gap filling**: When shadow table has missing records

### Key Features
- Fetches all crosswalks at once
- Bulk operations for database and MailerLite API
- Processes in batches of 500 records
- Creates shadows with both Supabase client data and MailerLite subscriber data
- Handles rate limiting (120 req/min)
- Background task execution via EdgeRuntime.waitUntil()
- Updates consolidated `sync_status` in `sync_state` table

### Expected Performance
- **24,222 records**: ~3-5 minutes (down from 58 minutes in old version)
- **Memory efficient**: Processes 500 records at a time
- **Rate limited**: Respects MailerLite API limits

### How to Run
```typescript
// From UI: Click "Force Resume" button in Enterprise Sync Dashboard

// From API:
const { data } = await supabase.functions.invoke('backfill-sync', {
  body: { autoContinue: true }
});
```

### Database Updates
Updates `sync_state.sync_status`:
```json
{
  "backfill": {
    "status": "running|completed|failed|paused",
    "phase": "Bulk processing crosswalks",
    "currentBatch": 5,
    "totalBatches": 49,
    "shadowsCreated": 2500,
    "errors": 0,
    "startedAt": "2024-01-15T10:00:00Z",
    "lastUpdatedAt": "2024-01-15T10:03:45Z"
  }
}
```

---

## 2. enterprise-sync (Full Bidirectional Sync)

### Purpose
Performs **full bidirectional synchronization** between Supabase and MailerLite. Processes records in batches with time-bounded execution.

### When to Use
- ✅ **Scheduled syncs**: Daily/hourly full synchronization
- ✅ **Bulk updates**: When many records need syncing
- ✅ **Data consistency**: Ensuring both systems are aligned
- ✅ **New subscriber imports**: Bringing in MailerLite subscribers

### Key Features
- **Bidirectional**: Syncs both `MailerLite → Supabase` AND `Supabase → MailerLite`
- **Time-bounded**: Max 120 seconds execution (prevents timeouts)
- **Cursor-based pagination**: Resumes from last position
- **Conflict detection**: Identifies and logs data conflicts
- **Advisory locks**: Prevents concurrent processing of same email
- **Group management**: Syncs MailerLite group memberships
- **Partner data sync**: Handles partner information

### Sync Directions
```typescript
// Both directions (default)
direction: 'both' 

// One direction only
direction: 'mailerlite-to-supabase'
direction: 'supabase-to-mailerlite'
```

### Expected Performance
- **500 records**: ~2 minutes
- **Max records per run**: Configurable (default: 300)
- **Resumable**: Uses cursor for continuation

### How to Run
```typescript
// From UI: Click "Run Sync" button in Full Sync dashboard

// From API:
const { data } = await supabase.functions.invoke('enterprise-sync', {
  body: {
    direction: 'both',
    maxRecords: 500,
    dryRun: false,
    maxDurationMs: 120000
  }
});
```

### Response Format
```json
{
  "recordsProcessed": 450,
  "conflictsDetected": 3,
  "updatesApplied": 127,
  "errors": 0,
  "done": true,
  "nextCursor": "eyJpZCI6MTIzfQ==",
  "message": "Sync completed successfully"
}
```

---

## 3. smart-sync (Incremental Targeted Sync)

### Purpose
**Incremental sync** for specific emails or small batches. Optimized for speed and resource efficiency with advanced protection mechanisms.

### When to Use
- ✅ **Real-time updates**: When a user updates their profile
- ✅ **Specific emails**: Syncing 1-100 specific records
- ✅ **Frequent syncs**: Small updates throughout the day
- ✅ **API-triggered syncs**: Webhook handlers, user actions

### Key Features
- **Email-specific**: Only syncs requested emails
- **Incremental**: Uses last sync timestamp to minimize work
- **Resource protected**:
  - Circuit breaker (stops after 3 errors in 10 min)
  - Concurrent sync prevention
  - Daily record limit (5,000 max)
  - Database health checks
- **Token bucket rate limiter**: Persistent state across invocations
- **Managed groups**: Only modifies specific MailerLite groups
- **Repair mode**: Can fix specific data issues

### Sync Modes
```typescript
// Supabase → MailerLite only
mode: 'AtoB'

// MailerLite → Supabase only  
mode: 'BtoA'

// Both directions
mode: 'bidirectional'

// Full sync (no incremental filter)
mode: 'full'
```

### Expected Performance
- **100 emails**: ~10 seconds
- **1 email**: ~100-200ms
- **Max per day**: 5,000 records (safety limit)

### How to Run
```typescript
// From UI: Use Email Sync dashboard with email list

// From API:
const { data } = await supabase.functions.invoke('smart-sync', {
  body: {
    mode: 'bidirectional',
    emails: ['user1@example.com', 'user2@example.com'],
    dryRun: false,
    repair: false
  }
});
```

### Response Format
```json
{
  "ok": true,
  "count": 2,
  "out": [
    {
      "email": "user1@example.com",
      "changed": true,
      "b_id": "ml_subscriber_123"
    },
    {
      "email": "user2@example.com",
      "skipped": true,
      "reason": "no changes detected"
    }
  ]
}
```

---

## Recommended Workflow

### Initial Setup (Day 1)
1. **Run backfill-sync** to create all shadow snapshots
   - Takes ~5 minutes for 24K records
   - Creates foundation for conflict detection

2. **Verify completion** in Enterprise Sync Dashboard
   - Check "Shadows Created" count matches crosswalk count

### Regular Operations (Ongoing)

#### Option A: Scheduled Full Syncs
- Run **enterprise-sync** daily at off-peak hours
- Direction: `both` (bidirectional)
- Max records: 500-1000
- Use cron job or scheduled task

#### Option B: Real-time Updates
- Use **smart-sync** for immediate user updates
- Trigger on profile edits, subscription changes
- Mode: `bidirectional`
- Process 1-100 emails at a time

#### Option C: Hybrid (Recommended)
- **smart-sync** for real-time user actions (instant)
- **enterprise-sync** nightly for bulk consistency (scheduled)
- **backfill-sync** monthly for validation (maintenance)

---

## Database State Management

### sync_state Table Structure

After Phase 1 consolidation, all sync state is stored in a **single** `sync_status` key:

```sql
SELECT value FROM sync_state WHERE key = 'sync_status';
```

```json
{
  "backfill": {
    "status": "completed",
    "phase": "Completed",
    "currentBatch": 49,
    "totalBatches": 49,
    "shadowsCreated": 24222,
    "errors": 0,
    "startedAt": "2024-01-15T10:00:00Z",
    "lastUpdatedAt": "2024-01-15T10:04:32Z",
    "completedAt": "2024-01-15T10:04:32Z",
    "paused": false
  },
  "fullSync": {
    "lastCompletedAt": "2024-01-15T11:00:00Z",
    "totalProcessed": 450,
    "totalUpdated": 127,
    "status": "completed"
  },
  "lastSync": {
    "timestamp": "2024-01-15T11:00:00Z",
    "recordsProcessed": 450
  },
  "statistics": {
    "recordsProcessed": 5234,
    "updatesApplied": 1456,
    "conflicts": 12,
    "lastUpdated": "2024-01-15T11:00:00Z"
  }
}
```

---

## Troubleshooting

### "Backfill stuck at XX%"
- Check `sync_status.backfill.lastUpdatedAt`
- If stale (>90 seconds), click "Force Resume"
- Check Edge Function logs for errors

### "Sync conflicts detected"
- View conflicts in Conflicts dashboard
- Use conflict resolution UI to resolve
- Conflicts don't block future syncs

### "Rate limit errors"
- MailerLite allows 120 req/min
- All functions have rate limiting built-in
- Reduce `maxRecords` if hitting limits consistently

### "Database timeout errors"
- Reduce batch size in functions
- Check database connection pool
- Verify RLS policies aren't causing slow queries

---

## Performance Optimization Tips

1. **Use appropriate function for task size**:
   - 1-100 records → smart-sync
   - 100-1000 records → enterprise-sync
   - 1000+ records → backfill-sync (if shadows missing)

2. **Schedule wisely**:
   - Run enterprise-sync during low-traffic hours
   - Use smart-sync for immediate user actions

3. **Monitor rate limits**:
   - Check `token_bucket_state` in sync_state
   - Adjust batch sizes if hitting limits

4. **Keep shadows fresh**:
   - Shadows older than 30 days should be regenerated
   - Run periodic backfill validation

---

## Migration Notes

### Deprecated Functions
- ~~sync-mailerlite~~ (deleted in Phase 3) - Use enterprise-sync instead

### Phase 1 Changes (Completed)
- ✅ Fixed `integration_crosswalk.a_id` from TEXT to UUID
- ✅ Added foreign key constraints
- ✅ Added performance indexes
- ✅ Consolidated sync state into `sync_status`

### Phase 2 Changes (Completed)
- ✅ Redesigned backfill-sync for bulk operations
- ✅ Reduced execution time from 58min → 5min
- ✅ Added background task support

### Phase 3 Changes (Completed)
- ✅ Deleted deprecated sync-mailerlite function
- ✅ Documented all sync functions
- ✅ Clarified use cases for each function

---

## Support

For issues or questions:
1. Check Edge Function logs in Supabase dashboard
2. Review sync_log table for detailed operation history
3. Check sync_conflicts table for unresolved conflicts
4. Verify sync_status for current system state
