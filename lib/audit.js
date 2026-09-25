// Simple append-only audit trail. Call this from inside the same mutate() callback that
// makes the change, so the audit entry and the change it describes are written atomically
// together (or not at all, if something throws first).
function recordAudit(db, { userId, userName, companyId, action, detail }) {
  if (!db.auditLog) db.auditLog = [];
  db.auditLog.push({
    id: (db._counters.auditLog = (db._counters.auditLog || 0) + 1),
    at: new Date().toISOString(),
    userId, userName, companyId, action, detail: detail || ''
  });
  // Keep this bounded so a single JSON file doesn't grow forever; for real retention
  // requirements, ship this to a proper log store instead of trimming it.
  const MAX_ENTRIES = 5000;
  if (db.auditLog.length > MAX_ENTRIES) {
    db.auditLog = db.auditLog.slice(db.auditLog.length - MAX_ENTRIES);
  }
}

module.exports = { recordAudit };
