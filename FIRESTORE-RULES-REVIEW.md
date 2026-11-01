# Firestore rules review — POS(5)

## Result

The original `firestore.rules` in POS(5) was **not fully aligned** with the current client code. It would deny the multi-room tenant flow already implemented in `tenantAssignments.ts`, and `rentBills.ts` did not write a room/month lock required by the rules.

The included updated `firestore.rules` corrects those mismatches.

## Key alignment changes

1. `validCurrentTenantAssignmentPair` now validates the assignment and its room-specific `currentTenantByRoom/{roomId}` index. It no longer requires a single `currentRoomByTenant/{tenantId}` document.
2. `currentRoomByTenant` is retained as a legacy reverse pointer for backward compatibility. Move-out rules allow that pointer to be removed when it points to the ending assignment, or preserved when it points to another verified current room assignment.
3. `rentBills.ts` now validates current occupancy from the room index only. It no longer rejects a tenant who has overlapping dates in another room.
4. Rent bill creation creates `rentBills/{assignmentId__month}` and `rentBillRoomMonthLocks/{roomId__month}` atomically. The lock matcher and client write fields now match.
5. Rent-rate creation, rent-bill creation, and both lock types use the authenticated actor UID required by the existing rules.
6. Historical `rentBillRoomMonthLocks` are backfilled from existing issued bills before monthly bill generation. Rate usage locks are also backfilled from existing bill rate snapshots.
7. Manual backup, restore, and controlled reset lists include the room/month and rate-usage lock collections.

## What remains unchanged

- Tenant IDs, room IDs, meter IDs, assignment IDs, and existing document paths.
- Immutable issued rent bills and payment allocation records.
- The room-specific uniqueness constraint: a room can have only one current tenant.
- The room/month uniqueness constraint: a room can receive at most one issued rent bill per billing month.
- The rate usage lock: a rate referenced by an issued bill cannot be deleted.
- `currentRoomByTenant` documents are not mass-deleted or migrated; they remain readable and are cleaned up safely when their referenced legacy assignment ends.

## Validation limitation

Client TS/TSX syntax transpilation and rule delimiter/structure checks were completed. Firebase CLI / Rules Emulator compilation and authorization tests were not available in the working environment. Deploy to a non-production Firebase project first and test the six scenarios listed in `INSTALLATION.txt` before production deployment.
