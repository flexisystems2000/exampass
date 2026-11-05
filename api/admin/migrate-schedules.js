const admin = require("firebase-admin");
const crypto = require("crypto");

const PROJECT_ID = "free-jamb-form-initiative";
const EXAM_DATE = "2026-11-28";
const TIME_ZONE = "Africa/Lagos";
const BATCHES = [
  { batch: "1st Batch", time: "11:00 AM", time24: "11:00" },
  { batch: "2nd Batch", time: "1:00 PM", time24: "13:00" },
  { batch: "3rd Batch", time: "3:00 PM", time24: "15:00" },
  { batch: "4th Batch", time: "5:00 PM", time24: "17:00" },
  { batch: "5th Batch", time: "7:00 PM", time24: "19:00" }
];

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
    const credentials = JSON.parse(raw);
    if (credentials.project_id !== PROJECT_ID) {
      throw new Error("Service account project_id does not match " + PROJECT_ID);
    }
    admin.initializeApp({ credential: admin.credential.cert(credentials) });
  }
  return admin.firestore();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function assignBatchSlot(regNo) {
  let hash = 0;
  for (let i = 0; i < regNo.length; i++) {
    hash = regNo.charCodeAt(i) + ((hash << 5) - hash);
  }
  return BATCHES[Math.abs(hash) % BATCHES.length];
}

function parseTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return { time24: String(hour).padStart(2, "0") + ":" + match[2] };
}

function toLagosTimestamp(time24) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time24 || ""));
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  // Lagos is UTC+1 on 28 November 2026; store the matching absolute instant.
  return admin.firestore.Timestamp.fromDate(
    new Date(Date.UTC(2026, 10, 28, hour - 1, minute, 0))
  );
}

function makeSchedule(slot) {
  const parsed = slot.time24 ? { time24: slot.time24 } : parseTime(slot.time);
  if (!parsed) return null;
  const scheduledAt = toLagosTimestamp(parsed.time24);
  if (!scheduledAt) return null;
  return {
    batch: slot.batch,
    time: slot.time,
    time24: parsed.time24,
    examDate: EXAM_DATE,
    timeZone: TIME_ZONE,
    scheduledAt,
    scheduleVersion: 1,
    scheduleSource: "server_migration",
    assignedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST required" });

  const secret = process.env.MIGRATION_SECRET;
  if (!secret || !safeEqual(req.headers["x-migration-token"], secret)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const mode = body.mode || "preview";
    if (!["preview", "apply", "verify"].includes(mode)) {
      return res.status(400).json({ ok: false, error: "mode must be preview, apply, or verify" });
    }
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 200);
    const db = getDb();
    let q = db.collection("jamb_registrations")
      .orderBy(admin.firestore.FieldPath.documentId()).limit(limit);
    if (body.cursor) q = q.startAfter(String(body.cursor));
    const snap = await q.get();

    let ready = 0, alreadySaved = 0, legacyPreserved = 0, missingRegistration = 0, invalidLegacy = 0;
    const pending = [], samples = [];

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const saved = data.examSchedule;
      if (saved && saved.batch && saved.time && saved.examDate) {
        alreadySaved++;
        continue;
      }

      let slot;
      if (data.batch && data.time) {
        const parsed = parseTime(data.time);
        if (!parsed) { invalidLegacy++; continue; }
        slot = { batch: data.batch, time: data.time, time24: parsed.time24 };
        legacyPreserved++;
      } else {
        const registrationNumber = String(data.registrationNumber || "").trim();
        if (!registrationNumber) { missingRegistration++; continue; }
        slot = assignBatchSlot(registrationNumber);
      }

      const schedule = makeSchedule(slot);
      if (!schedule) { invalidLegacy++; continue; }
      ready++;
      if (samples.length < 10) {
        samples.push({
          documentId: doc.id,
          registrationNumber: data.registrationNumber || null,
          fullName: data.fullName || null,
          batch: schedule.batch,
          time: schedule.time,
          examDate: schedule.examDate,
          timeZone: schedule.timeZone
        });
      }
      pending.push({ ref: doc.ref, schedule });
    }

    if (mode === "apply" && pending.length) {
      const batch = db.batch();
      for (const item of pending) batch.update(item.ref, { examSchedule: item.schedule });
      await batch.commit();
    }

    return res.status(200).json({
      ok: true, mode, collection: "jamb_registrations",
      scanned: snap.size, ready, alreadySaved, legacyPreserved,
      missingRegistration, invalidLegacy,
      written: mode === "apply" ? pending.length : 0,
      nextCursor: snap.size === limit ? snap.docs[snap.docs.length - 1].id : null,
      samples
    });
  } catch (error) {
    console.error("Schedule migration failed:", error);
    return res.status(500).json({ ok: false, error: "Migration request failed", detail: error.message });
  }
};
