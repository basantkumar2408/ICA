require('dotenv').config();
const express = require('express');
const path    = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const cloudinary = require('cloudinary').v2;

const PORT         = process.env.PORT || 3000;
const MONGODB_URI  = process.env.MONGODB_URI;
const MONGODB_DB   = process.env.MONGODB_DB  || 'ica_school';
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@123';
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY    = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!MONGODB_URI) { console.error('❌  MONGODB_URI not set'); process.exit(1); }

if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
  });
}

// ── MongoDB connection (persistent across requests) ──
let _db = null;
async function getDb() {
  if (_db) return _db;
  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
  } catch (e) {
    // Log the REAL reason so it's visible in the terminal instead of a generic 500.
    console.error('❌  MongoDB connection failed:', e.message);
    if (e.message && e.message.includes('bad auth')) {
      console.error('   → Username/password in MONGODB_URI is wrong (check Atlas → Database Access).');
    } else if (e.message && e.message.toLowerCase().includes('timed out')) {
      console.error('   → Most likely your current IP is NOT whitelisted in Atlas → Network Access,');
      console.error('     or the cluster is paused. Add 0.0.0.0/0 (or your IP) in Network Access.');
    }
    throw e;
  }
  _db = client.db(MONGODB_DB);
  console.log(`✅  Connected to MongoDB: ${MONGODB_DB}`);
  return _db;
}

// ── Helpers ──
function mapDoc(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id ? _id.toString() : undefined, ...rest };
}
function mapDocs(arr) { return (arr || []).map(mapDoc); }

function toOid(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

function nowIso() { return new Date().toISOString(); }

// ── Academic grading engine (FA1 + FA2 + FA3 + End Term) ──
// FA = Formative Assessment. Grade bands: <33% Fail, 33-59% Grade C,
// 60-74% Grade B, 75-89% Grade A, 90-100% Grade A+.
function gradeFor(percent) {
  const p = Number(percent) || 0;
  if (p < 33) return 'F';
  if (p < 60) return 'C';
  if (p < 75) return 'B';
  if (p < 90) return 'A';
  return 'A+';
}
function computeAcademicResult(subjects) {
  let totalObtained = 0, totalMax = 0, anyFail = false;
  const computed = (Array.isArray(subjects) ? subjects : []).filter(s => s && s.name).map(s => {
    const hasFA = s.fa1 !== undefined || s.fa2 !== undefined || s.fa3 !== undefined || s.endterm !== undefined;
    let marks, max, fa1 = 0, fa2 = 0, fa3 = 0, endterm = 0, fa1_max = 0, fa2_max = 0, fa3_max = 0, endterm_max = 0;
    if (hasFA) {
      fa1 = Number(s.fa1) || 0; fa2 = Number(s.fa2) || 0; fa3 = Number(s.fa3) || 0; endterm = Number(s.endterm) || 0;
      fa1_max = Number(s.fa1_max) || 10; fa2_max = Number(s.fa2_max) || 10; fa3_max = Number(s.fa3_max) || 10; endterm_max = Number(s.endterm_max) || 70;
      marks = fa1 + fa2 + fa3 + endterm; max = fa1_max + fa2_max + fa3_max + endterm_max;
    } else {
      marks = Number(s.marks) || 0; max = Number(s.max) || 100;
    }
    const pct = max ? (marks / max) * 100 : 0;
    const status = pct < 33 ? 'Fail' : 'Pass';
    if (status === 'Fail') anyFail = true;
    totalObtained += marks; totalMax += max;
    return {
      name: s.name, fa1, fa2, fa3, endterm, fa1_max, fa2_max, fa3_max, endterm_max, has_fa: hasFA,
      marks, max, percentage: max ? Math.round((marks / max) * 10000) / 100 : 0, status
    };
  });
  const overallPct = totalMax ? Math.round((totalObtained / totalMax) * 10000) / 100 : 0;
  return {
    subjects: computed, total_marks: totalObtained, max_marks: totalMax,
    percentage: overallPct, grade: gradeFor(overallPct),
    result_status: computed.length ? (anyFail ? 'Fail' : 'Pass') : 'Pending'
  };
}
async function getAdminPassword(db) {
  const row = await db.collection('settings')
    .findOne({ key: 'admin_password' });

  return row?.value || ADMIN_PASSWORD;
}
async function getAdminId(db) {
  const row = await db.collection('settings').findOne({ key: 'admin_id' });
  return (row && row.value) || ADMIN_ID;
}
// Password policy: at least 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special character.
// Applies everywhere a new login password is created/changed (Admin, Accounts Panel, Staff/Student logins).
function isStrongPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  if (!/[^A-Za-z0-9]/.test(pw)) return false;
  return true;
}
const PASSWORD_RULE_MSG = 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.';
// Generate a unique N-digit numeric ID that does not already exist in the given
// collection's given field (used for 6-digit Staff ID / 3-digit Student ID).
async function generateUniqueNumericId(db, collection, field, digits) {
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = String(Math.floor(min + Math.random() * (max - min + 1)));
    const exists = await db.collection(collection).findOne({ [field]: candidate });
    if (!exists) return candidate;
  }
  // Extremely unlikely fallback: sequential scan
  const counter = await db.collection('app_counters').findOneAndUpdate(
    { form_key: collection + '_' + field + '_seq' },
    { $inc: { last_number: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return String((counter && counter.last_number) || 1).padStart(digits, '0');
}
function isAdmin(req) {
  const token =
    req.headers['x-admin-token'] ||
    req.headers['authorization'] ||
    '';

  return token === ADMIN_TOKEN;
}
async function isAccountsAuthorized(req, db) {
  const token = req.headers['x-accounts-token'] || '';
  if (!token) return false;
  const row = await db.collection('settings').findOne({ key: 'accounts_token' });
  return !!(row && row.value && row.value === token);
}
async function requireAccounts(req, res, db) {
  if (isAdmin(req)) return true;
  if (await isAccountsAuthorized(req, db)) return true;
  err(res, 'Unauthorized', 401);
  return false;
}
function ok(res, data)  { res.json({ success: true,  ...data }); }
function err(res, msg, code) { res.status(code || 400).json({ success: false, error: msg }); }

async function uploadDoc(input, folder, filename) {
  if (!input || typeof input !== 'string') return '';
  const isData = input.startsWith('data:');
  const isHttp = input.startsWith('http://') || input.startsWith('https://');
  if (!isData && !isHttp) return '';
  if (!CLOUDINARY_CLOUD_NAME) return '';
  try {
    const res = await cloudinary.uploader.upload(input, {
      folder: 'ica-school/' + folder,
      public_id: filename,
      resource_type: 'auto',
      overwrite: true,
      unique_filename: false
    });
    return res.secure_url;
  } catch (e) {
    console.error('Cloudinary error:', e.message);
    return '';
  }
}

// ── Express setup ──
const app = express();
app.use(express.json({ limit: '20mb' }));        // 20 MB for base64 file uploads
app.use(express.urlencoded({ extended: true }));

// CORS (useful if you host frontend separately)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve static files (index.html, images, css etc.)
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════
//  API Routes — all under /api?action=...
// ══════════════════════════════════════════
app.all('/api', async (req, res) => {
  const action = req.query.action || '';
  const body   = req.body || {};
  let db;
  try { db = await getDb(); }
  catch (e) { return err(res, 'Database connection failed.', 500); }

  try {
    // ── PUBLIC ────────────────────────────────────────────────
    if (action === 'admin_login' && req.method === 'POST') {

  const { adminId, password } = body;

  const currentPassword =
      await getAdminPassword(db);
  const currentAdminId =
      await getAdminId(db);

  if (
      adminId === currentAdminId &&
      password === currentPassword
  ) {
      return ok(res, {
          token: ADMIN_TOKEN,
          admin: adminId
      });
  }

  return err(
      res,
      'Invalid credentials',
      401
  );
}
    if (action === 'accounts_login' && req.method === 'POST') {
      const { accountsId, password } = body;
      const [idRow, pwRow, tokenRow] = await Promise.all([
        db.collection('settings').findOne({ key: 'accounts_id' }),
        db.collection('settings').findOne({ key: 'accounts_password' }),
        db.collection('settings').findOne({ key: 'accounts_token' })
      ]);
      if (!idRow || !pwRow || !tokenRow) {
        return err(res, 'Accounts Panel login has not been created yet. Ask the Admin to set it up from Admin Panel → Accounts Access.', 403);
      }
      if (accountsId === idRow.value && password === pwRow.value) {
        return ok(res, { token: tokenRow.value, accountsId });
      }
      return err(res, 'Invalid Accounts Panel credentials', 401);
    }
    if (action === 'get_notices' && req.method === 'GET') {
      const data = await db.collection('notices').find({}).sort({ created_at: -1 }).limit(10).toArray();
      return ok(res, { data: mapDocs(data) });
    }

    if (action === 'admission_status' && req.method === 'GET') {
      const row = await db.collection('settings').findOne({ key: 'admission_open' });
      return ok(res, { open: row ? row.value === 'true' : false });
    }

    if (action === 'get_settings' && req.method === 'GET') {
      const rows = await db.collection('settings').find({}).toArray();
      const map = {};
      rows.forEach(r => { map[r.key] = r.value; });
      return ok(res, { data: map });
    }

    if (action === 'get_form_schema' && req.method === 'GET') {

  const formKey = req.query.form_key;

  let query = { is_active: true };

  if(formKey){
      query.form_key = formKey;
  }

  const data = await db.collection('form_schema')
      .find(query)
      .sort({ updated_at: -1 })
      .toArray();

  return ok(res,{
      data: mapDocs(data)
  });
}
    if (action === 'get_active_forms' && req.method === 'GET') {
      const data = await db.collection('form_schema')
        .find({ is_active: true, form_key: { $ne: 'admission' } })
        .project({ form_key: 1, title: 1, updated_at: 1 })
        .sort({ updated_at: -1 }).toArray();
      return ok(res, { data: mapDocs(data) });
    }

    if (action === 'submit_form' && req.method === 'POST') {
      const { form_key, data: formData } = body;
      if (!form_key || !formData) return err(res, 'Missing form data');
      const schema = await db.collection('form_schema').findOne({ form_key });
      if (!schema || !schema.is_active) return err(res, 'This form is not accepting responses.', 403);

      // Generate a unique application number for every submission (career/custom forms too)
      const year = String(new Date().getFullYear());
      let appNumber = '';
      try {
        const counter = await db.collection('app_counters').findOneAndUpdate(
          { academic_year: year, form_key },
          { $inc: { last_number: 1 } },
          { upsert: true, returnDocument: 'after' }
        );
        const nextNum = counter && counter.last_number ? counter.last_number : 1;
        const prefix = form_key === 'admission' ? 'ICA' : 'ICA-' + form_key.slice(0, 4).toUpperCase();
        appNumber = prefix + '/' + year + '/' + String(nextNum).padStart(4, '0');
      } catch { appNumber = 'ICA/' + year + '/' + Date.now().toString().slice(-6); }

      // Upload any file/photo fields (base64 data URLs) to Cloudinary, keep rest as-is
      const cleanData = {};
      const folderSlug = 'forms/' + form_key + '/' + appNumber.replace(/[^A-Za-z0-9]+/g, '-');
      for (const [k, v] of Object.entries(formData)) {
        if (typeof v === 'string' && v.startsWith('data:')) {
          const url = await uploadDoc(v, folderSlug, k.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          cleanData[k] = url || '';
        } else {
          cleanData[k] = v;
        }
      }

      const doc = {
        form_key, data_json: cleanData, application_number: appNumber,
        status: 'New', created_at: nowIso()
      };
      const r = await db.collection('form_submissions').insertOne(doc);
      return ok(res, { data: mapDoc({ ...doc, _id: r.insertedId }) });
    }

    // Applicant self-service: check status / result / offer letter using Application No + DOB
    if (action === 'track_application' && req.method === 'POST') {
      const appNumber = String(body.application_number || '').trim();
      const rollNo = String(body.roll_no || '').trim();
      const dob = String(body.dob || '').trim();
      if (!dob || (!appNumber && !rollNo)) return err(res, 'Please provide your Roll Number (or Application Number) and Date of Birth.');

      // Student academic result — looked up by Roll No + DOB (not Application Number).
      // A student can now have MULTIPLE marksheets (one per Exam Name, e.g. Half-Yearly,
      // Annual) — fetch all of them so the student can pick which exam's marksheet to view.
      if (rollNo && !appNumber) {
        const allResults = await db.collection('results').find({ roll_no: rollNo, dob, category: 'academic' }).sort({ class_name: 1 }).toArray();
        if (allResults.length) {
          const safeList = allResults.map(r => { const { dob: _d, ref_no: _r, ...safe } = r; return safe; });
          return ok(res, { found: true, type: 'result', data: mapDoc(safeList[0]), letters: mapDocs(safeList), form_data: null });
        }
        return err(res, 'No result found. Please check your Roll Number and Date of Birth.', 404);
      }

      const result = await db.collection('results').findOne({ application_number: appNumber, dob });
      if (result) {
        const { dob: _d, ...safe } = result;
        if (safe.category !== 'hiring') delete safe.ref_no; // academic result print must not show a reference number
        let letters = [safe];
        let formData = null;
        if (safe.category === 'hiring') {
          // Fetch every letter (offer / appointment) issued for this application number
          const all = await db.collection('results').find({ application_number: appNumber }).sort({ letter_type: 1 }).toArray();
          letters = all.map(x => { const { dob: _d2, ...s } = x; return mapDoc(s); });
          const sub = await db.collection('form_submissions').findOne({ application_number: appNumber });
          if (sub) formData = mapDoc(sub);
        } else {
          // Academic — same student may have multiple exam marksheets (Half-Yearly, Annual, etc.)
          const all = await db.collection('results').find({ application_number: appNumber, category: 'academic' }).sort({ class_name: 1 }).toArray();
          letters = all.map(x => { const { dob: _d2, ref_no: _r2, ...s } = x; return mapDoc(s); });
        }
        return ok(res, { found: true, type: 'result', data: mapDoc(safe), letters: mapDocs(letters), form_data: formData });
      }

      const admission = await db.collection('admissions').findOne({ application_number: appNumber, dob });
      if (admission) {
        const { dob: _d, aadhaar: _a, ...safe } = admission;
        return ok(res, { found: true, type: 'admission', data: mapDoc(safe) });
      }

      const submission = await db.collection('form_submissions').findOne({ application_number: appNumber });
      if (submission) {
        const data = submission.data_json || {};
        const dobField = Object.entries(data).find(([k]) => /dob|birth/i.test(k));
        if (dobField && String(dobField[1]).trim() === dob) {
          return ok(res, { found: true, type: 'form_submission', data: mapDoc(submission) });
        }
      }

      return err(res, 'No record found. Please check your Application Number and Date of Birth.', 404);
    }

    // Applicant self-service edit — only allowed when Admin has flipped
    // `edit_allowed: true` on that specific submission from the admin panel.
    if (action === 'update_own_submission' && req.method === 'POST') {
      const appNumber = String(body.application_number || '').trim();
      const dob = String(body.dob || '').trim();
      const formData = body.data || {};
      if (!appNumber || !dob) return err(res, 'Application number and date of birth are required.');

      const sub = await db.collection('form_submissions').findOne({ application_number: appNumber });
      if (!sub) return err(res, 'Application not found.', 404);
      if (!sub.edit_allowed) return err(res, 'Editing is not enabled for this application. Please contact the HR / Admin office.', 403);

      const existing = sub.data_json || {};
      const dobField = Object.entries(existing).find(([k]) => /dob|birth/i.test(k));
      if (dobField && String(dobField[1]).trim() !== dob) return err(res, 'Date of birth does not match our records.', 401);

      const cleanData = { ...existing };
      const folderSlug = 'forms/' + sub.form_key + '/' + appNumber.replace(/[^A-Za-z0-9]+/g, '-');
      for (const [k, v] of Object.entries(formData)) {
        if (typeof v === 'string' && v.startsWith('data:')) {
          const url = await uploadDoc(v, folderSlug, k.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          cleanData[k] = url || cleanData[k] || '';
        } else {
          cleanData[k] = v;
        }
      }
      await db.collection('form_submissions').updateOne({ _id: sub._id }, { $set: { data_json: cleanData, updated_at: nowIso(), edit_allowed: false } });
      return ok(res, { data: mapDoc({ ...sub, data_json: cleanData }) });
    }


    if (action === 'submit_enquiry' && req.method === 'POST') {
      const { parent_name, child_name, phone, class: cls, area, enquiry_type, message } = body;
      if (!parent_name || !child_name || !phone || !cls) return err(res, 'Required fields missing');
      if (!/^\d{10}$/.test(phone)) return err(res, 'Phone must be 10 digits');
      const doc = {
        parent_name, child_name, phone, class: cls, area: area || '',
        enquiry_type: enquiry_type || 'New Admission',
        message: message || '', status: 'New', created_at: nowIso()
      };
      const r = await db.collection('enquiries').insertOne(doc);
      return ok(res, { data: mapDoc({ ...doc, _id: r.insertedId }) });
    }

    if (action === 'submit_admission' && req.method === 'POST') {
      const setting = await db.collection('settings').findOne({ key: 'admission_open' });
      if (!setting || setting.value !== 'true') return err(res, 'Admissions are currently closed.', 403);
      if (!body.student_name || !body.contact_phone || !body.applying_class) return err(res, 'Required fields missing');

      const yearSetting = await db.collection('settings').findOne({ key: 'admission_year' });
      const academicYear = (yearSetting && yearSetting.value) || String(new Date().getFullYear());
      const yearPrefix = academicYear.split('-')[0];

      let appNumber = '';
      try {
        const counter = await db.collection('app_counters').findOneAndUpdate(
          { academic_year: academicYear },
          { $inc: { last_number: 1 } },
          { upsert: true, returnDocument: 'after' }
        );
        const nextNum = counter && counter.last_number ? counter.last_number : 1;
        appNumber = 'ICA/' + yearPrefix + '/' + String(nextNum).padStart(4, '0');
      } catch { appNumber = 'ICA/' + yearPrefix + '/' + Date.now().toString().slice(-4); }

      // Auto-generate a unique, searchable admission receipt number
      let receiptNo = '';
      try {
        const rc = await db.collection('app_counters').findOneAndUpdate(
          { academic_year: academicYear, form_key: 'receipt' },
          { $inc: { last_number: 1 } },
          { upsert: true, returnDocument: 'after' }
        );
        const rn = rc && rc.last_number ? rc.last_number : 1;
        receiptNo = 'ICA/RCPT/' + yearPrefix + '/' + String(rn).padStart(4, '0');
      } catch { receiptNo = 'RCPT-' + Date.now().toString().slice(-6); }

      const folderSlug = 'admissions/' + (body.student_name || 'student').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + Date.now();
      const [photoUrl, birthUrl, markUrl, tcUrl, aadUrl] = await Promise.all([
        uploadDoc(body.photo_url,       folderSlug, 'photo'),
        uploadDoc(body.doc_birth_cert,  folderSlug, 'birth_cert'),
        uploadDoc(body.doc_marksheet,   folderSlug, 'marksheet'),
        uploadDoc(body.doc_tc,          folderSlug, 'tc'),
        uploadDoc(body.doc_aadhaar,     folderSlug, 'aadhaar')
      ]);

      const doc = {
        student_name: body.student_name || '', dob: body.dob || '',
        gender: body.gender || '', applying_class: body.applying_class || '',
        blood_group: body.blood_group || '', religion: body.religion || '',
        category: body.category || '', aadhaar: body.aadhaar || '',
        nationality: body.nationality || 'Indian',
        father_name: body.father_name || '', father_occupation: body.father_occupation || '',
        father_phone: body.father_phone || '', father_email: body.father_email || '',
        mother_name: body.mother_name || '', mother_occupation: body.mother_occupation || '',
        mother_phone: body.mother_phone || '', contact_phone: body.contact_phone || '',
        family_income: body.family_income || '', previous_school: body.previous_school || '',
        previous_class: body.previous_class || '', previous_percent: body.previous_percent || '',
        passing_year: body.passing_year || '', medium: body.medium || '',
        achievements: body.achievements || '', medical: body.medical || '',
        address: body.address || '', village: body.village || '',
        block: body.block || '', district: body.district || '',
        state: body.state || '', pincode: body.pincode || '',
        distance: body.distance || '', transport: body.transport || '',
        emergency_contact: body.emergency_contact || '',
        photo_url: photoUrl || '',
        doc_birth_cert: birthUrl || '',
        doc_marksheet: markUrl || '',
        doc_tc: tcUrl || '',
        doc_aadhaar: aadUrl || '',
        photo_file_url: photoUrl || '', birth_cert_url: birthUrl || '',
        marksheet_url: markUrl || '', tc_url: tcUrl || '', aadhaar_url: aadUrl || '',
        application_number: appNumber, receipt_no: receiptNo, academic_year: academicYear,
        status: 'Pending', created_at: nowIso()
      };
      const r = await db.collection('admissions').insertOne(doc);
      return ok(res, { data: mapDoc({ ...doc, _id: r.insertedId }) });
    }

    if (action === 'get_gallery' && req.method === 'GET') {
      const cat = req.query.category;
      const q = cat && cat !== 'All' ? { category: cat } : {};
      const data = await db.collection('gallery').find(q).sort({ created_at: -1 }).toArray();
      return ok(res, { data: mapDocs(data) });
    }

    if (action === 'get_testimonials' && req.method === 'GET') {
      const data = await db.collection('testimonials')
        .find({ is_active: { $ne: false } })
        .sort({ created_at: -1 }).toArray();
      return ok(res, { data: mapDocs(data) });
    }

    // ── ADMIN ONLY ────────────────────────────────────────────
if (
  action === 'change_password' &&
  req.method === 'POST'
) {

  const {
      oldPassword,
      newPassword
  } = body;

  const currentPassword =
      await getAdminPassword(db);

  if (
      oldPassword !== currentPassword
  ) {
      return err(
          res,
          'Old password incorrect',
          401
      );
  }

  if (!isStrongPassword(newPassword)) {
      return err(res, PASSWORD_RULE_MSG, 400);
  }

  await db.collection('settings')
      .updateOne(
          {
              key: 'admin_password'
          },
          {
              $set: {
                  key: 'admin_password',
                  value: newPassword
              }
          },
          {
              upsert: true
          }
      );

  return ok(res, {
      message:
          'Password changed successfully'
  });
}
    // Change Admin ID (login username) — requires current password for confirmation.
    if (action === 'change_admin_id' && req.method === 'POST') {
      if (!isAdmin(req)) return err(res, 'Unauthorized', 401);
      const { currentPassword, newAdminId } = body;
      const storedPassword = await getAdminPassword(db);
      if (currentPassword !== storedPassword) return err(res, 'Current password is incorrect', 401);
      const cleanId = String(newAdminId || '').trim();
      if (cleanId.length < 4) return err(res, 'Admin ID must be at least 4 characters.', 400);
      await db.collection('settings').updateOne({ key: 'admin_id' }, { $set: { key: 'admin_id', value: cleanId } }, { upsert: true });
      return ok(res, { message: 'Admin ID updated successfully', adminId: cleanId });
    }
    if (!isAdmin(req) && !action.startsWith('acc_')) return err(res, 'Unauthorized', 401);

    // Auto-fill helper: given an Application Number, find the applicant's
    // name / photo / DOB / category from whichever collection has it
    // (admissions, hiring/custom form_submissions, or an existing result row).
    if (action === 'lookup_application' && req.method === 'GET') {
      const appNumber = String(req.query.application_number || '').trim();
      if (!appNumber) return err(res, 'Missing application_number');

      const adm = await db.collection('admissions').findOne({ application_number: appNumber });
      if (adm) {
        // Prefer the fee_students record for class/section — it reflects the LATEST
        // class/section (e.g. after a Transfer), while admissions holds the original
        // applying_class only.
        const fs = await db.collection('fee_students').findOne({ application_number: appNumber });
        return ok(res, { source: 'admission', data: {
          name: adm.student_name || '', photo_url: adm.photo_file_url || adm.photo_url || '',
          dob: adm.dob || '', category: 'academic',
          class_name: (fs && fs.applying_class) || adm.applying_class || '',
          section: (fs && fs.section) || '',
          father_name: adm.father_name || '',
          roll_no: (fs && (fs.exam_roll_no || fs.class_roll_no)) || ''
        }});
      }

      const sub = await db.collection('form_submissions').findOne({ application_number: appNumber });
      if (sub) {
        const data = sub.data_json || {};
        const keys = Object.keys(data);
        const nameKey  = keys.find(k => /name/i.test(k) && !/father|mother|guardian|company|school/i.test(k));
        const photoKey = keys.find(k => /photo|picture|image|passport/i.test(k) && typeof data[k] === 'string' && data[k].startsWith('http'));
        const dobKey   = keys.find(k => /dob|birth/i.test(k));
        return ok(res, { source: 'form_submission', data: {
          name: nameKey ? data[nameKey] : '', photo_url: photoKey ? data[photoKey] : '',
          dob: dobKey ? data[dobKey] : '', category: 'hiring', form_key: sub.form_key || ''
        }});
      }

      const existing = await db.collection('results').findOne({ application_number: appNumber });
      if (existing) {
        return ok(res, { source: 'result', data: {
          name: existing.student_name || '', photo_url: existing.photo_url || '',
          dob: existing.dob || '', category: existing.category || 'academic',
          class_name: existing.class_name || '', section: existing.section || '',
          father_name: existing.father_name || '', roll_no: existing.roll_no || ''
        }});
      }

      return err(res, 'No application found with this number.', 404);
    }

    // Generic asset uploader used by Site Settings (school stamp/seal,
    // principal photo, office & principal signatures, etc.)
    if (action === 'upload_asset' && req.method === 'POST') {
      const { data_url, folder, filename } = body;
      if (!data_url) return err(res, 'Missing data_url');
      const url = await uploadDoc(data_url, 'site/' + (folder || 'assets'), filename || ('asset-' + Date.now()));
      if (!url) return err(res, 'Upload failed. Check Cloudinary configuration.', 500);
      return ok(res, { url });
    }

    if (action === 'get_stats' && req.method === 'GET') {
      const today = nowIso().split('T')[0];
      const [enqs, adms, noticeCount] = await Promise.all([
        db.collection('enquiries').find({}, { projection: { status: 1, created_at: 1 } }).toArray(),
        db.collection('admissions').find({}, { projection: { status: 1, created_at: 1 } }).toArray(),
        db.collection('notices').countDocuments({})
      ]);
      const months = [];
      const now = new Date();
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: d.toLocaleDateString('en-IN', { month: 'short' }), enq: 0, adm: 0 });
      }
      const mIdx = {};
      months.forEach((m, i) => { mIdx[m.key] = i; });
      enqs.forEach(e => { const k = String(e.created_at || '').slice(0, 7); if (mIdx[k] !== undefined) months[mIdx[k]].enq++; });
      adms.forEach(a => { const k = String(a.created_at || '').slice(0, 7); if (mIdx[k] !== undefined) months[mIdx[k]].adm++; });
      return ok(res, { data: {
        enq_total: enqs.length, enq_new: enqs.filter(e => e.status === 'New').length,
        adm_total: adms.length, adm_pending: adms.filter(a => a.status === 'Pending').length,
        adm_confirmed: adms.filter(a => a.status === 'Confirmed').length,
        adm_today: adms.filter(a => (a.created_at || '').startsWith(today)).length,
        notices: noticeCount, trend: months
      }});
    }

    if (action === 'get_enquiries'  && req.method === 'GET') {
      return ok(res, { data: mapDocs(await db.collection('enquiries').find({}).sort({ created_at: -1 }).toArray()) });
    }
    if (action === 'update_enquiry' && req.method === 'POST') {
      const { id, ...updates } = body;
      const oid = toOid(id); if (!oid) return err(res, 'Missing id');
      await db.collection('enquiries').updateOne({ _id: oid }, { $set: updates });
      return ok(res, {});
    }
    if (action === 'delete_enquiry' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('enquiries').deleteOne({ _id: oid });
      return ok(res, {});
    }

    if (action === 'get_admissions'  && req.method === 'GET') {
      return ok(res, { data: mapDocs(await db.collection('admissions').find({}).sort({ created_at: -1 }).toArray()) });
    }
    if (action === 'update_admission' && req.method === 'POST') {
      const { id, ...updates } = body;
      const oid = toOid(id); if (!oid) return err(res, 'Missing id');
      await db.collection('admissions').updateOne({ _id: oid }, { $set: updates });

      // Auto-sync into the Accounts panel the moment admission is Confirmed
      if (updates.status === 'Confirmed') {
        const adm = await db.collection('admissions').findOne({ _id: oid });
        if (adm) {
          const feeMap = await db.collection('settings').findOne({ key: 'class_fees' });
          let feesConfig = {};
          try { feesConfig = feeMap && feeMap.value ? JSON.parse(feeMap.value) : {}; } catch { feesConfig = {}; }
          const heads = feesConfig[adm.applying_class] || {};
          const fee_breakdown = {
            tuition: Number(heads.tuition) || 0,
            computer: Number(heads.computer) || 0,
            library: Number(heads.library) || 0,
            van: Number(heads.van) || 0,
            annual: Number(heads.annual) || 0,
            other: Number(heads.other) || 0,
            other_label: heads.other_label || 'Other Fee',
            custom: Array.isArray(heads.custom) ? heads.custom : [] // admin-defined extra fee fields (e.g. "Facility Fee")
          };
          // Van & Other are optional per-student (not every student takes the bus, etc.)
          // — off by default; Accountant switches them on per student in Fee Students panel.
          // Custom fee fields are always applied to every student in the class by default.
          const customTotal = fee_breakdown.custom.reduce((s, c) => s + (Number(c.amount) || 0), 0);
          const monthlyFee = fee_breakdown.tuition + fee_breakdown.computer + fee_breakdown.library + customTotal;
          const existingFS = await db.collection('fee_students').findOne({ application_number: adm.application_number });
          // School-level Student ID — a unique 3-digit number, assigned once from enrollment (Confirmed admission).
          const studentId = (existingFS && existingFS.student_id) || await generateUniqueNumericId(db, 'fee_students', 'student_id', 3);
          await db.collection('fee_students').updateOne(
            { application_number: adm.application_number },
            { $set: {
                application_number: adm.application_number, admission_id: oid.toString(),
                student_name: adm.student_name, applying_class: adm.applying_class,
                father_name: adm.father_name || '', contact_phone: adm.contact_phone || '',
                photo_url: adm.photo_file_url || adm.photo_url || '',
                address: adm.address || '', blood_group: adm.blood_group || '',
                section: existingFS ? (existingFS.section || '') : '',
                class_roll_no: existingFS ? (existingFS.class_roll_no || '') : '',
                exam_roll_no: existingFS ? (existingFS.exam_roll_no || '') : '',
                exam_allowed: existingFS && existingFS.exam_allowed !== undefined ? existingFS.exam_allowed : true,
                student_id: studentId,
                fee_breakdown,
                van_applicable: existingFS ? !!existingFS.van_applicable : false,
                other_applicable: existingFS ? !!existingFS.other_applicable : false,
                monthly_fee: existingFS && existingFS.monthly_fee !== undefined ? existingFS.monthly_fee : monthlyFee,
                academic_year: adm.academic_year || '',
                updated_at: nowIso()
              },
              $setOnInsert: { created_at: nowIso() }
            },
            { upsert: true }
          );
        }
      }
      return ok(res, {});
    }
    // Transfer one or more students to a different Class and/or Section (individual or bulk).
    if (action === 'student_transfer' && req.method === 'POST') {
      const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
      if (!ids.length) return err(res, 'No students selected.');
      const newClass = body.applying_class;
      const newSection = body.section;
      if (!newClass && newSection === undefined) return err(res, 'Provide a new Class and/or Section.');
      const oids = ids.map(toOid).filter(Boolean);
      if (!oids.length) return err(res, 'Invalid student id(s).');
      const setFields = { updated_at: nowIso() };
      if (newClass) setFields.applying_class = newClass;
      if (newSection !== undefined) setFields.section = String(newSection || '').trim();
      const result = await db.collection('fee_students').updateMany({ _id: { $in: oids } }, { $set: setFields });
      return ok(res, { transferred: result.modifiedCount });
    }
    if (action === 'delete_admission' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('admissions').deleteOne({ _id: oid });
      return ok(res, {});
    }

    if (action === 'add_notice' && req.method === 'POST') {
      const { title, category, content } = body;
      if (!title) return err(res, 'Title required');
      const doc = { title, category: category || 'Announcement', content: content || '', created_at: nowIso() };
      const r = await db.collection('notices').insertOne(doc);
      return ok(res, { data: mapDoc({ ...doc, _id: r.insertedId }) });
    }
    if (action === 'delete_notice' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('notices').deleteOne({ _id: oid });
      return ok(res, {});
    }

    if (action === 'add_gallery' && req.method === 'POST') {
      const { caption, category } = body;
      let { image_url } = body;
      if (!caption) return err(res, 'Caption required');
      if (image_url && image_url.startsWith('data:')) {
        const slug = caption.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + Date.now();
        image_url = await uploadDoc(image_url, 'gallery', slug);
      }
      const doc = { caption, category: category || 'Events', image_url: image_url || '', created_at: nowIso() };
      const r = await db.collection('gallery').insertOne(doc);
      return ok(res, { data: mapDoc({ ...doc, _id: r.insertedId }) });
    }
    if (action === 'delete_gallery' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('gallery').deleteOne({ _id: oid });
      return ok(res, {});
    }

    if (action === 'list_testimonials' && req.method === 'GET') {
      return ok(res, { data: mapDocs(await db.collection('testimonials').find({}).sort({ created_at: -1 }).toArray()) });
    }
    if (action === 'add_testimonial' && req.method === 'POST') {
      const { name, role, message, rating, photo_url } = body;
      if (!name || !message) return err(res, 'Name and message required');
      let photo = photo_url || '';
      if (photo && photo.startsWith('data:')) {
        photo = await uploadDoc(photo, 'testimonials', name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) + '-' + Date.now());
      }
      const doc = { name, role: role || 'Parent', message, rating: Math.min(5, Math.max(1, parseInt(rating) || 5)), photo_url: photo, is_active: true, created_at: nowIso() };
      const r = await db.collection('testimonials').insertOne(doc);
      return ok(res, { data: mapDoc({ ...doc, _id: r.insertedId }) });
    }
    if (action === 'toggle_testimonial' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('testimonials').updateOne({ _id: oid }, { $set: { is_active: !!body.is_active } });
      return ok(res, {});
    }
    if (action === 'delete_testimonial' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('testimonials').deleteOne({ _id: oid });
      return ok(res, {});
    }

    if (action === 'toggle_admission' && req.method === 'POST') {
      const { open } = body;
      await db.collection('settings').updateOne({ key: 'admission_open' }, { $set: { key: 'admission_open', value: open ? 'true' : 'false' } }, { upsert: true });
      return ok(res, { open });
    }
    if (action === 'update_setting' && req.method === 'POST') {
      const { key, value } = body;
      if (!key) return err(res, 'Missing key');
      await db.collection('settings').updateOne({ key }, { $set: { key, value: String(value || '') } }, { upsert: true });
      return ok(res, {});
    }

    if (action === 'list_forms' && req.method === 'GET') {
      return ok(res, { data: mapDocs(await db.collection('form_schema').find({}).sort({ updated_at: -1 }).toArray()) });
    }
    if (action === 'get_form' && req.method === 'GET') {
      const oid = toOid(req.query.id); if (!oid) return err(res, 'Missing id');
      return ok(res, { data: mapDoc(await db.collection('form_schema').findOne({ _id: oid })) });
    }
    if (action === 'save_form' && req.method === 'POST') {
      const { id, form_key, title, schema_json, is_active } = body;
      if (!form_key || !title || !schema_json) return err(res, 'Missing form_key, title, or schema');
      const row = { form_key, title, schema_json, is_active: !!is_active, updated_at: nowIso() };
      if (id) {
        const oid = toOid(id); if (!oid) return err(res, 'Bad id');
        await db.collection('form_schema').updateOne({ _id: oid }, { $set: row });
        return ok(res, { data: mapDoc(await db.collection('form_schema').findOne({ _id: oid })) });
      } else {
        row.created_at = nowIso();
        const r = await db.collection('form_schema').insertOne(row);
        return ok(res, { data: mapDoc({ ...row, _id: r.insertedId }) });
      }
    }
    if (action === 'toggle_form' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('form_schema').updateOne({ _id: oid }, { $set: { is_active: !!body.is_active } });
      return ok(res, {});
    }
    if (action === 'delete_form' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('form_schema').deleteOne({ _id: oid });
      return ok(res, {});
    }
    if (action === 'get_form_submissions' && req.method === 'GET') {
      const formKey = req.query.form_key;
      const q = formKey ? { form_key: formKey } : {};
      return ok(res, { data: mapDocs(await db.collection('form_submissions').find(q).sort({ created_at: -1 }).toArray()) });
    }
    if (action === 'update_form_submission' && req.method === 'POST') {
      const { id, ...updates } = body;
      const oid = toOid(id); if (!oid) return err(res, 'Missing id');
      await db.collection('form_submissions').updateOne({ _id: oid }, { $set: updates });
      return ok(res, {});
    }
    if (action === 'delete_form_submission' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('form_submissions').deleteOne({ _id: oid });
      return ok(res, {});
    }

    // ── RESULTS & OFFER LETTERS (admin) ────────────────────────
    if (action === 'list_results' && req.method === 'GET') {
      return ok(res, { data: mapDocs(await db.collection('results').find({}).sort({ created_at: -1 }).toArray()) });
    }
    if (action === 'save_result' && req.method === 'POST') {
      const {
        id, application_number, dob, category, student_name, class_name, section, roll_no, father_name, exam_name,
        photo_url, subjects, total_marks, max_marks, percentage, grade,
        result_status, remarks, position, department, joining_date, salary,
        reporting_time, offer_note, letter_type, letter_body
      } = body;
      if (!application_number || !dob || !student_name) return err(res, 'Application number, DOB and name are required');

      let photo = photo_url || '';
      if (photo && photo.startsWith('data:')) {
        photo = await uploadDoc(photo, 'results/' + application_number.replace(/[^A-Za-z0-9]+/g, '-'), 'photo');
      }

      const isAcademic = (category || 'academic') !== 'hiring';
      const cleanExamName = String(exam_name || '').trim() || 'Annual Examination';

      // Keep the same reference number across edits AND across offer/appointment
      // letters that share the same Application Number (fixes: different ref no
      // being generated for Offer Letter vs Appointment Letter of the same candidate).
      // Reference number concept (changed): the hiring Ref No is simply the
      // candidate's own Application Number — no separate auto-incrementing
      // counter is generated anymore, so it always matches what the
      // candidate already has and never gets out of sync across letters.
      let existingDoc = null;
      const editOid = id ? toOid(id) : null;
      if (editOid) existingDoc = await db.collection('results').findOne({ _id: editOid });
      // For academic results (no id passed — e.g. a fresh "Add Result" for a student who
      // already has a marksheet for this same Class), match on Application No + Class so we
      // UPDATE that SAME marksheet (keeping the same Marksheet No) as FA1/FA2/FA3/Final marks
      // come in through the year — instead of creating a duplicate with a new Marksheet No.
      const cleanClassName = String(class_name || '').trim();
      if (!existingDoc && isAcademic && application_number && cleanClassName) {
        existingDoc = await db.collection('results').findOne({
          application_number: String(application_number).trim(), category: 'academic', class_name: cleanClassName
        });
      }
      let refNo = body.ref_no || (existingDoc && existingDoc.ref_no) || '';
      if (!refNo && !isAcademic && application_number) {
        refNo = String(application_number).trim();
      }
      // Marksheet No — one unique 6-digit number per (student + Class).
      // It stays IDENTICAL across FA1/FA2/FA3/End Term/any exam-name edits within that
      // SAME class (because we keep updating the same document above). Once the student
      // moves to a DIFFERENT class (new academic year), that's a new document and gets
      // its own fresh Marksheet No.
      let marksheetNo = (existingDoc && existingDoc.marksheet_no) || '';
      if (!marksheetNo && isAcademic) {
        marksheetNo = await generateUniqueNumericId(db, 'results', 'marksheet_no', 6);
      }

      // Academic results: always recompute totals/percentage/grade/pass-fail
      // server-side from FA1+FA2+FA3+End Term (or legacy marks/max) so the
      // published marksheet can never be out of sync with entered marks.
      let computedAcademic = null;
      if (isAcademic && Array.isArray(subjects) && subjects.length) {
        computedAcademic = computeAcademicResult(subjects);
      }

      const row = {
        application_number: String(application_number).trim(),
        dob: String(dob).trim(),
        category: category || 'academic', // 'academic' | 'hiring'
        student_name, class_name: class_name || '', section: section || '', roll_no: roll_no || '',
        father_name: father_name || '',
        exam_name: isAcademic ? cleanExamName : '',
        marksheet_no: marksheetNo,
        photo_url: photo,
        subjects: computedAcademic ? computedAcademic.subjects : (Array.isArray(subjects) ? subjects : []),
        total_marks: computedAcademic ? computedAcademic.total_marks : (total_marks || ''),
        max_marks: computedAcademic ? computedAcademic.max_marks : (max_marks || ''),
        percentage: computedAcademic ? computedAcademic.percentage : (percentage || ''),
        grade: computedAcademic ? computedAcademic.grade : (grade || ''),
        result_status: computedAcademic ? computedAcademic.result_status : (result_status || 'Pending'), remarks: remarks || '',
        position: position || '', department: department || '',
        joining_date: joining_date || '', salary: salary || '',
        reporting_time: reporting_time || '', offer_note: offer_note || '',
        letter_type: letter_type || 'result', // 'result' | 'offer' | 'appointment'
        letter_body: letter_body || '', ref_no: refNo,
        updated_at: nowIso()
      };
      if (existingDoc) {
        await db.collection('results').updateOne({ _id: existingDoc._id }, { $set: row });
        return ok(res, { data: mapDoc(await db.collection('results').findOne({ _id: existingDoc._id })) });
      } else {
        row.created_at = nowIso();
        const r = await db.collection('results').insertOne(row);
        return ok(res, { data: mapDoc({ ...row, _id: r.insertedId }) });
      }
    }
    // Bulk marks entry — admin uploads an Excel sheet (parsed client-side),
    // each row keyed by Application Number auto-creates/updates that
    // student's result using the same FA1+FA2+FA3+End Term grading engine.
    if (action === 'bulk_upload_results' && req.method === 'POST') {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return err(res, 'No rows to upload.');
      // Exam Name applies to the whole sheet unless a row overrides it (e.g. its own column).
      const sheetExamName = String(body.exam_name || '').trim() || 'Annual Examination';
      const outcomes = [];
      for (const row of rows) {
        const appNumber = String(row.application_number || '').trim();
        if (!appNumber) { outcomes.push({ application_number: '', ok: false, error: 'Missing application number' }); continue; }
        try {
          const examName = String(row.exam_name || sheetExamName).trim();
          const className = String(row.class_name || '').trim();
          let dob = String(row.dob || '').trim();
          let studentName = row.student_name || '';
          // Match the SAME student+Class existing marksheet (so re-uploading marks for
          // the same class updates it in place and keeps its Marksheet No unchanged).
          const existing = className
            ? await db.collection('results').findOne({ application_number: appNumber, category: 'academic', class_name: className })
            : await db.collection('results').findOne({ application_number: appNumber, category: 'academic' });
          if (!dob || !studentName) {
            const adm = await db.collection('admissions').findOne({ application_number: appNumber });
            if (adm) { dob = dob || adm.dob || ''; studentName = studentName || adm.student_name || ''; }
          }
          dob = dob || (existing && existing.dob) || '';
          studentName = studentName || (existing && existing.student_name) || '';
          if (!dob) { outcomes.push({ application_number: appNumber, ok: false, error: 'DOB not found for this Application Number. Add the student via Admissions first, or include a DOB column.' }); continue; }
          if (!studentName) { outcomes.push({ application_number: appNumber, ok: false, error: 'Student name not found.' }); continue; }

          const calc = computeAcademicResult(row.subjects);
          const marksheetNo = (existing && existing.marksheet_no) || await generateUniqueNumericId(db, 'results', 'marksheet_no', 6);

          const docRow = {
            application_number: appNumber, dob, category: 'academic',
            student_name: studentName,
            class_name: row.class_name || (existing && existing.class_name) || '',
            section: row.section || (existing && existing.section) || '',
            roll_no: row.roll_no || (existing && existing.roll_no) || '',
            father_name: row.father_name || (existing && existing.father_name) || '',
            exam_name: examName, marksheet_no: marksheetNo,
            photo_url: (existing && existing.photo_url) || '',
            subjects: calc.subjects, total_marks: calc.total_marks, max_marks: calc.max_marks,
            percentage: calc.percentage, grade: calc.grade, result_status: calc.result_status,
            remarks: row.remarks || (existing && existing.remarks) || '',
            letter_type: 'result', ref_no: '', updated_at: nowIso()
          };
          if (existing) {
            await db.collection('results').updateOne({ _id: existing._id }, { $set: docRow });
          } else {
            docRow.created_at = nowIso();
            await db.collection('results').insertOne(docRow);
          }
          outcomes.push({ application_number: appNumber, ok: true, percentage: calc.percentage, grade: calc.grade, status: calc.result_status });
        } catch (e) {
          outcomes.push({ application_number: appNumber, ok: false, error: e.message });
        }
      }
      return ok(res, { data: outcomes });
    }

    // Examination module — quick auto-fill: teacher enters Roll No (or Application No) + DOB
    // and student's Name/Class/Application No are pulled in automatically before marks entry.
    if (action === 'lookup_student_for_result' && req.method === 'GET') {
      const rollNo = String(req.query.roll_no || '').trim();
      const appNumber = String(req.query.application_number || '').trim();
      const dob = String(req.query.dob || '').trim();
      if (!dob || (!rollNo && !appNumber)) return err(res, 'Provide Roll No or Application Number, plus Date of Birth.');
      if (appNumber) {
        const adm = await db.collection('admissions').findOne({ application_number: appNumber, dob });
        if (adm) {
          const fs = await db.collection('fee_students').findOne({ application_number: appNumber });
          return ok(res, { data: {
            application_number: adm.application_number, student_name: adm.student_name,
            class_name: (fs && fs.applying_class) || adm.applying_class, section: (fs && fs.section) || '',
            father_name: adm.father_name || '', roll_no: (fs && (fs.exam_roll_no || fs.class_roll_no)) || '', dob
          }});
        }
        return err(res, 'No admission record found for that Application Number & DOB.', 404);
      }
      // Roll No is only assigned once a result has been published at least once — search existing results first.
      const existingResult = await db.collection('results').findOne({ roll_no: rollNo, dob, category: 'academic' });
      if (existingResult) {
        return ok(res, { data: {
          application_number: existingResult.application_number, student_name: existingResult.student_name,
          class_name: existingResult.class_name, section: existingResult.section || '',
          father_name: existingResult.father_name || '', roll_no: existingResult.roll_no, dob
        }});
      }
      return err(res, 'No student found with that Roll No & DOB yet. Use Application Number for a first-time entry.', 404);
    }

    // Examination — auto-generate Roll Numbers.
    // "exam" = school-wide Examination Roll No (one sequence across the whole school).
    // "class" = Class Roll No (separate sequence per class).
    if (action === 'generate_roll_no' && req.method === 'POST') {
      const { type, class_name, id } = body;
      if (type === 'class' && !class_name) return err(res, 'Class is required to generate a Class Roll No.');
      const key = type === 'exam' ? { form_key: 'exam_roll_no' } : { form_key: 'class_roll_no', class_name };
      const counter = await db.collection('app_counters').findOneAndUpdate(key, { $inc: { last_number: 1 } }, { upsert: true, returnDocument: 'after' });
      const rawNum = counter && counter.last_number ? counter.last_number : 1;
      // Examination Roll No (school-wide) is always a 4-digit number, e.g. 0001, 0002, ... 9999.
      const num = type === 'exam' ? String(rawNum).padStart(4, '0') : rawNum;
      const field = type === 'exam' ? 'exam_roll_no' : 'class_roll_no';
      if (id) {
        const oid = toOid(id);
        if (oid) await db.collection('fee_students').updateOne({ _id: oid }, { $set: { [field]: String(num), updated_at: nowIso() } });
      }
      return ok(res, { data: { number: num } });
    }

    // Examination — full student roster (used for the roll-no register and admit card generation).
    if (action === 'list_students' && req.method === 'GET') {
      const cls = req.query.class_name;
      const q = cls ? { applying_class: cls } : {};
      const data = await db.collection('fee_students').find(q).sort({ applying_class: 1, student_name: 1 }).toArray();
      return ok(res, { data: mapDocs(data) });
    }

    // Staff Duty / Shift Roster — which teacher is on duty in which class, which shift, which day.
    if (action === 'list_duty_roster' && req.method === 'GET') {
      const data = await db.collection('duty_roster').find({}).sort({ day: 1, shift: 1 }).toArray();
      return ok(res, { data: mapDocs(data) });
    }
    if (action === 'save_duty_assignment' && req.method === 'POST') {
      const { id, staff_application_number, staff_name, class_name, shift, day, note } = body;
      if (!staff_name || !class_name || !day) return err(res, 'Staff, Class and Day are required.');
      const row = { staff_application_number: staff_application_number || '', staff_name, class_name, shift: shift || 'Morning', day, note: note || '', updated_at: nowIso() };
      if (id) {
        const oid = toOid(id); if (!oid) return err(res, 'Invalid id');
        await db.collection('duty_roster').updateOne({ _id: oid }, { $set: row });
        return ok(res, { data: mapDoc({ ...row, _id: oid }) });
      }
      row.created_at = nowIso();
      const r = await db.collection('duty_roster').insertOne(row);
      return ok(res, { data: mapDoc({ ...row, _id: r.insertedId }) });
    }
    if (action === 'delete_duty_assignment' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('duty_roster').deleteOne({ _id: oid });
      return ok(res, {});
    }

    if (action === 'delete_result' && req.method === 'POST') {
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('results').deleteOne({ _id: oid });
      return ok(res, {});
    }

    // ── ACCOUNTS PANEL — credential management (Admin only) ────
    if (action === 'get_accounts_status' && req.method === 'GET') {
      const idRow = await db.collection('settings').findOne({ key: 'accounts_id' });
      return ok(res, { configured: !!idRow, accountsId: idRow ? idRow.value : '' });
    }
    if (action === 'set_accounts_credentials' && req.method === 'POST') {
      const { accountsId, accountsPassword } = body;
      if (!accountsId || !accountsPassword) return err(res, 'Accounts ID and Password required');
      if (!isStrongPassword(accountsPassword)) return err(res, PASSWORD_RULE_MSG, 400);
      const newToken = 'ACC_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      await db.collection('settings').updateOne({ key: 'accounts_id' }, { $set: { key: 'accounts_id', value: String(accountsId) } }, { upsert: true });
      await db.collection('settings').updateOne({ key: 'accounts_password' }, { $set: { key: 'accounts_password', value: String(accountsPassword) } }, { upsert: true });
      await db.collection('settings').updateOne({ key: 'accounts_token' }, { $set: { key: 'accounts_token', value: newToken } }, { upsert: true });
      return ok(res, { message: 'Accounts Panel login created / updated. Both Principal and Accountant can now log in with this ID & Password.' });
    }

    // ── ACCOUNTS PANEL — Fees & Salary (Principal + Accountant) ─
    if (action === 'acc_lookup_application' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const appNumber = String(req.query.application_number || '').trim();
      if (!appNumber) return err(res, 'Missing application_number');
      const existing = await db.collection('results').findOne({ application_number: appNumber, category: 'hiring' });
      if (existing) {
        return ok(res, { data: {
          name: existing.student_name || '', position: existing.position || '',
          department: existing.department || '', salary: existing.salary || ''
        }});
      }
      return err(res, 'No hiring record found for this Application Number.', 404);
    }

    // Search an admission receipt by Application No. or Receipt No.
    // (used for printing the admission receipt with seal + Principal/HR sign)
    if (action === 'acc_search_receipt' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const q = String(req.query.q || '').trim();
      if (!q) return err(res, 'Provide an Application Number or Receipt Number.');
      const adm = await db.collection('admissions').findOne({ $or: [{ application_number: q }, { receipt_no: q }] });
      if (!adm) return err(res, 'No admission record found for that number.', 404);
      return ok(res, { data: mapDoc(adm) });
    }

    if (action === 'acc_get_class_fees' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const row = await db.collection('settings').findOne({ key: 'class_fees' });
      let fees = {};
      try { fees = row && row.value ? JSON.parse(row.value) : {}; } catch { fees = {}; }
      return ok(res, { data: fees });
    }
    if (action === 'acc_set_class_fees' && req.method === 'POST') {
      if (!(await requireAccounts(req, res, db))) return;
      const fees = body.fees || {};
      await db.collection('settings').updateOne({ key: 'class_fees' }, { $set: { key: 'class_fees', value: JSON.stringify(fees) } }, { upsert: true });
      return ok(res, {});
    }

    if (action === 'acc_list_fee_students' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const cls = req.query.class_name;
      const q = cls ? { applying_class: cls } : {};
      const students = await db.collection('fee_students').find(q).sort({ student_name: 1 }).toArray();
      return ok(res, { data: mapDocs(students) });
    }
    if (action === 'acc_update_fee_student' && req.method === 'POST') {
      if (!(await requireAccounts(req, res, db))) return;
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      const student = await db.collection('fee_students').findOne({ _id: oid });
      if (!student) return err(res, 'Student not found.');
      const fb = student.fee_breakdown || {};
      const customTotal = Array.isArray(fb.custom) ? fb.custom.reduce((s, c) => s + (Number(c.amount) || 0), 0) : 0;
      const van_applicable = body.van_applicable !== undefined ? !!body.van_applicable : !!student.van_applicable;
      const other_applicable = body.other_applicable !== undefined ? !!body.other_applicable : !!student.other_applicable;
      let monthly_fee;
      if (body.monthly_fee !== undefined && body.monthly_fee !== '') {
        monthly_fee = Number(body.monthly_fee) || 0; // manual override wins if provided
      } else {
        monthly_fee = (Number(fb.tuition) || 0) + (Number(fb.computer) || 0) + (Number(fb.library) || 0) + customTotal
          + (van_applicable ? (Number(fb.van) || 0) : 0) + (other_applicable ? (Number(fb.other) || 0) : 0);
      }
      const setFields = { monthly_fee, van_applicable, other_applicable, updated_at: nowIso() };
      // Examination roster fields — Section, Class Roll No, Exam Roll No, exam eligibility flag
      ['section', 'class_roll_no', 'exam_roll_no'].forEach(f => { if (body[f] !== undefined) setFields[f] = String(body[f]).trim(); });
      if (body.exam_allowed !== undefined) setFields.exam_allowed = !!body.exam_allowed;
      await db.collection('fee_students').updateOne({ _id: oid }, { $set: setFields });
      return ok(res, {});
    }

    if (action === 'acc_list_fee_payments' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const appNumber = req.query.application_number;
      const q = appNumber ? { application_number: appNumber } : {};
      const data = await db.collection('fee_payments').find(q).sort({ created_at: -1 }).toArray();
      return ok(res, { data: mapDocs(data) });
    }
    if (action === 'acc_add_fee_payment' && req.method === 'POST') {
      if (!(await requireAccounts(req, res, db))) return;
      const { application_number, student_name, month, amount, mode, note, fee_type } = body;
      const isAnnual = fee_type === 'annual';
      if (!application_number || !amount) return err(res, 'Application number and amount are required.');
      if (!isAnnual && !month) return err(res, 'Month is required for a monthly fee payment.');
      const doc = {
        application_number, student_name: student_name || '',
        month: isAnnual ? 'ANNUAL' : month, fee_type: isAnnual ? 'annual' : 'monthly',
        amount: Number(amount) || 0, mode: mode || 'Cash', note: note || '', paid_on: nowIso(), created_at: nowIso()
      };
      const r = await db.collection('fee_payments').insertOne(doc);
      return ok(res, { data: mapDoc({ ...doc, _id: r.insertedId }) });
    }
    if (action === 'acc_delete_fee_payment' && req.method === 'POST') {
      if (!(await requireAccounts(req, res, db))) return;
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('fee_payments').deleteOne({ _id: oid });
      return ok(res, {});
    }

    if (action === 'acc_get_fee_summary' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const [students, payments] = await Promise.all([
        db.collection('fee_students').find({}).toArray(),
        db.collection('fee_payments').find({}).toArray()
      ]);
      const now = new Date();
      const curMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const curYear = String(now.getFullYear());
      const today = nowIso().slice(0, 10);

      const byClass = {};
      let totalDueThisMonth = 0, totalCollectedThisMonth = 0, totalCollectedThisYear = 0, totalCollectedToday = 0, totalAnnualCollected = 0;

      students.forEach(s => {
        const cls = s.applying_class || 'Unassigned';
        if (!byClass[cls]) byClass[cls] = { class_name: cls, students: 0, monthly_expected: 0, collected_this_month: 0, pending_this_month: 0 };
        byClass[cls].students++;
        byClass[cls].monthly_expected += (s.monthly_fee || 0);
        totalDueThisMonth += (s.monthly_fee || 0);
      });

      payments.forEach(p => {
        if (String(p.month) === curMonth) totalCollectedThisMonth += p.amount || 0;
        if (String(p.paid_on || '').startsWith(curYear)) totalCollectedThisYear += p.amount || 0; // by payment date, so Annual Fee counts too
        if (String(p.paid_on || '').startsWith(today)) totalCollectedToday += p.amount || 0;
        if (p.fee_type === 'annual') totalAnnualCollected += p.amount || 0;
      });

      // pending / collected per class for current month, and how many students have paid this month
      let studentsPaidThisMonth = 0;
      Object.values(byClass).forEach(c => {
        const classStudents = students.filter(s => (s.applying_class || 'Unassigned') === c.class_name);
        let collected = 0;
        classStudents.forEach(s => {
          const paid = payments.filter(p => p.application_number === s.application_number && String(p.month) === curMonth)
            .reduce((sum, p) => sum + (p.amount || 0), 0);
          collected += paid;
          if (paid > 0) studentsPaidThisMonth++;
        });
        c.collected_this_month = collected;
        c.pending_this_month = Math.max(0, c.monthly_expected - collected);
      });

      return ok(res, { data: {
        current_month: curMonth, total_students: students.length,
        total_due_this_month: totalDueThisMonth, total_collected_this_month: totalCollectedThisMonth,
        total_collected_this_year: totalCollectedThisYear, total_collected_today: totalCollectedToday,
        total_annual_collected: totalAnnualCollected,
        students_paid_this_month: studentsPaidThisMonth, students_pending_this_month: Math.max(0, students.length - studentsPaidThisMonth),
        by_class: Object.values(byClass)
      }});
    }

    // ── ACCOUNTS PANEL — Staff / Teacher Salary ─────────────────
    if (action === 'acc_list_staff' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const data = await db.collection('staff').find({}).sort({ name: 1 }).toArray();
      return ok(res, { data: mapDocs(data) });
    }
    if (action === 'acc_save_staff' && req.method === 'POST') {
      if (!(await requireAccounts(req, res, db))) return;
      const {
        id, application_number, name, position, department, monthly_salary, bank_details, basic_pay, hra, pf_percent,
        staff_type, father_name, blood_group, address
      } = body;
      if (!application_number || !name) return err(res, 'Application number and name are required.');

      let photo_url = body.photo_url || '';
      if (photo_url && photo_url.startsWith('data:')) {
        photo_url = await uploadDoc(photo_url, 'staff/' + String(application_number).replace(/[^A-Za-z0-9]+/g, '-'), 'photo');
      }

      const row = {
        application_number, name, position: position || '', department: department || '',
        monthly_salary: Number(monthly_salary) || 0, bank_details: bank_details || '',
        basic_pay: Number(basic_pay) || 0, hra: Number(hra) || 0, pf_percent: Number(pf_percent) || 0,
        updated_at: nowIso()
      };
      // ID Card / HR fields — only overwrite when provided so the Accounts (salary-only)
      // form and the Admin ID Card form can both save this same record safely.
      if (staff_type !== undefined) row.staff_type = staff_type === 'non_teaching' ? 'non_teaching' : 'teaching';
      if (father_name !== undefined) row.father_name = father_name || '';
      if (blood_group !== undefined) row.blood_group = blood_group || '';
      if (address !== undefined) row.address = address || '';
      if (photo_url) row.photo_url = photo_url;

      if (id) {
        const oid = toOid(id); if (!oid) return err(res, 'Bad id');
        const existing = await db.collection('staff').findOne({ _id: oid });
        // Generate the unique 6-digit Staff ID once, the first time it's missing.
        if (existing && !existing.staff_id) {
          row.staff_id = await generateUniqueNumericId(db, 'staff', 'staff_id', 6);
        }
        await db.collection('staff').updateOne({ _id: oid }, { $set: row });
        return ok(res, { data: mapDoc(await db.collection('staff').findOne({ _id: oid })) });
      } else {
        row.created_at = nowIso();
        if (row.status === undefined) row.status = 'active';
        // New staff confirmed/added via Application Number → auto-generate unique 6-digit Staff ID.
        row.staff_id = await generateUniqueNumericId(db, 'staff', 'staff_id', 6);
        const r = await db.collection('staff').insertOne(row);
        return ok(res, { data: mapDoc({ ...row, _id: r.insertedId }) });
      }
    }
    if (action === 'acc_delete_staff' && req.method === 'POST') {
      if (!(await requireAccounts(req, res, db))) return;
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('staff').deleteOne({ _id: oid });
      return ok(res, {});
    }
    // Block / Unblock / Remove / Restore a staff member (soft actions — record is kept, just flagged).
    if (action === 'staff_set_status' && req.method === 'POST') {
      if (!(await requireAccounts(req, res, db))) return;
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      const status = String(body.status || '').trim();
      if (!['active', 'blocked', 'removed'].includes(status)) return err(res, 'Invalid status. Use active, blocked, or removed.');
      await db.collection('staff').updateOne({ _id: oid }, { $set: { status, updated_at: nowIso() } });
      return ok(res, {});
    }

    if (action === 'acc_list_salary_payments' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const appNumber = req.query.application_number;
      const q = appNumber ? { application_number: appNumber } : {};
      const data = await db.collection('salary_payments').find(q).sort({ month: -1 }).toArray();
      return ok(res, { data: mapDocs(data) });
    }
    if (action === 'acc_add_salary_payment' && req.method === 'POST') {
      if (!(await requireAccounts(req, res, db))) return;
      const { application_number, name, month, mode, note } = body;
      if (!application_number || !month) return err(res, 'Application number and month are required.');
      const staff = await db.collection('staff').findOne({ application_number });
      // Basic/HRA/PF% default from the staff record but can be overridden per payment.
      const basic_pay = body.basic_pay !== undefined && body.basic_pay !== '' ? Number(body.basic_pay) : ((staff && staff.basic_pay) || 0);
      const hra = body.hra !== undefined && body.hra !== '' ? Number(body.hra) : ((staff && staff.hra) || 0);
      const pf_percent = body.pf_percent !== undefined && body.pf_percent !== '' ? Number(body.pf_percent) : ((staff && staff.pf_percent) || 0);
      const pf_amount = Math.round((basic_pay * pf_percent) / 100);
      const gross_pay = basic_pay + hra;
      // If a manual "amount" is given, use it as the final net pay; otherwise auto-calculate (Basic + HRA - PF).
      const netPay = (body.amount !== undefined && body.amount !== '') ? Number(body.amount) : Math.max(0, gross_pay - pf_amount);
      if (!netPay && !gross_pay) return err(res, 'Enter either an Amount, or Basic Pay/HRA to auto-calculate.');
      const doc = {
        application_number, name: name || (staff && staff.name) || '', month,
        basic_pay, hra, pf_percent, pf_amount, gross_pay,
        amount: netPay, mode: mode || 'Bank Transfer', note: note || '', paid_on: nowIso(), created_at: nowIso()
      };
      const r = await db.collection('salary_payments').insertOne(doc);
      return ok(res, { data: mapDoc({ ...doc, _id: r.insertedId }) });
    }

    // PF Record — side-panel search across all employees, filterable by month / employee
    if (action === 'acc_pf_records' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const month = req.query.month;
      const appNumber = req.query.application_number;
      const q = { pf_amount: { $gt: 0 } };
      if (month) q.month = month;
      if (appNumber) q.application_number = appNumber;
      const data = await db.collection('salary_payments').find(q).sort({ month: -1 }).toArray();
      const total_pf = data.reduce((s, p) => s + (p.pf_amount || 0), 0);
      return ok(res, { data: mapDocs(data), total_pf });
    }
    if (action === 'acc_delete_salary_payment' && req.method === 'POST') {
      if (!(await requireAccounts(req, res, db))) return;
      const oid = toOid(body.id); if (!oid) return err(res, 'Missing id');
      await db.collection('salary_payments').deleteOne({ _id: oid });
      return ok(res, {});
    }

    // Salary slip for one month OR a range (e.g. 6-month / 12-month slip)
    if (action === 'acc_salary_slip' && req.method === 'GET') {
      if (!(await requireAccounts(req, res, db))) return;
      const appNumber = String(req.query.application_number || '').trim();
      const fromMonth = String(req.query.from_month || '').trim();
      const toMonth = String(req.query.to_month || fromMonth).trim();
      if (!appNumber || !fromMonth) return err(res, 'Application number and month are required.');
      const staff = await db.collection('staff').findOne({ application_number: appNumber });
      if (!staff) return err(res, 'Staff member not found. Add them in Accounts → Staff first.', 404);
      const payments = await db.collection('salary_payments').find({
        application_number: appNumber, month: { $gte: fromMonth, $lte: toMonth }
      }).sort({ month: 1 }).toArray();
      const total = payments.reduce((s, p) => s + (p.amount || 0), 0);
      const total_pf = payments.reduce((s, p) => s + (p.pf_amount || 0), 0);
      const total_basic = payments.reduce((s, p) => s + (p.basic_pay || 0), 0);
      const total_hra = payments.reduce((s, p) => s + (p.hra || 0), 0);
      const slipNo = 'SLIP/' + appNumber.replace(/[^A-Za-z0-9]+/g, '-') + '/' + fromMonth + (toMonth !== fromMonth ? ('-' + toMonth) : '');
      return ok(res, { data: { staff: mapDoc(staff), payments: mapDocs(payments), total, total_pf, total_basic, total_hra, slip_no: slipNo, from_month: fromMonth, to_month: toMonth } });
    }

    return err(res, 'Unknown action', 404);

  } catch (e) {
    console.error('API error:', e);
    return err(res, 'Server error: ' + e.message, 500);
  }
});

// ── Public ID Card verification page (linked from the QR code on staff/student ID cards) ──
// SECURITY NOTE: this is a public, unauthenticated page (a security guard or anyone
// scanning the card needs to see it without logging in) — so it intentionally shows
// ONLY non-sensitive, verification-relevant fields (name, photo, class/designation,
// card number, active status). It NEVER exposes address, phone number, father's/
// guardian's name, blood group or date of birth, to protect student & staff privacy.
// It is looked up by the record's internal database ID (a long random ObjectId), not
// by the short 3-digit Student ID / 6-digit Staff ID printed on the card — this makes
// the link practically impossible to guess or enumerate, unlike a small numeric ID.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
app.get('/verify-id', async (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow'); // never let this page get indexed by search engines
  const type = String(req.query.type || '').trim();
  const idParam = String(req.query.id || '').trim();
  const oid = toOid(idParam);
  let html;
  try {
    const db = await getDb();
    let record = null;
    if (oid && type === 'staff') record = await db.collection('staff').findOne({ _id: oid });
    else if (oid && type === 'student') record = await db.collection('fee_students').findOne({ _id: oid });

    if (!record) {
      html = `<div class="vcard bad"><div class="vicon">&#10060;</div><h2>Invalid ID Card</h2><p>This QR code does not match any active record. If you believe this is an error, please contact the school office.</p></div>`;
    } else if (type === 'staff') {
      const status = record.status || 'active';
      const statusOk = status === 'active';
      html = `<div class="vcard ${statusOk ? 'good' : 'bad'}">
        ${record.photo_url ? `<img class="vphoto" src="${escHtml(record.photo_url)}"/>` : '<div class="vphoto vnoimg">No Photo</div>'}
        <h2>${escHtml(record.name)}</h2>
        <div class="vbadge ${statusOk ? 'ok' : 'no'}">${statusOk ? '&#9989; Active Staff ID' : '&#9888; ' + escHtml(status.toUpperCase())}</div>
        <table class="vtbl">
          <tr><td>Staff ID</td><td><b>${escHtml(record.staff_id || '-')}</b></td></tr>
          <tr><td>Type</td><td>${record.staff_type === 'non_teaching' ? 'Non-Teaching' : 'Teaching'}</td></tr>
          <tr><td>Designation</td><td>${escHtml(record.position || '-')}</td></tr>
          <tr><td>Department</td><td>${escHtml(record.department || '-')}</td></tr>
        </table>
      </div>`;
    } else {
      html = `<div class="vcard good">
        ${record.photo_url ? `<img class="vphoto" src="${escHtml(record.photo_url)}"/>` : '<div class="vphoto vnoimg">No Photo</div>'}
        <h2>${escHtml(record.student_name)}</h2>
        <div class="vbadge ok">&#9989; Enrolled Student</div>
        <table class="vtbl">
          <tr><td>Student ID</td><td><b>${escHtml(record.student_id || '-')}</b></td></tr>
          <tr><td>Class</td><td>${escHtml(record.applying_class || '-')}${record.section ? (' - ' + escHtml(record.section)) : ''}</td></tr>
          <tr><td>Roll No.</td><td>${escHtml(record.exam_roll_no || record.class_roll_no || '-')}</td></tr>
        </table>
      </div>`;
    }
  } catch (e) {
    html = `<div class="vcard bad"><div class="vicon">&#9888;</div><h2>Verification Unavailable</h2><p>Please try again in a moment.</p></div>`;
  }

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>ID Card Verification — Ideal Children Academy</title>
  <style>
    body{font-family:Arial,sans-serif;background:#0a1628;margin:0;padding:24px 16px;display:flex;min-height:100vh;align-items:center;justify-content:center;}
    .vwrap{max-width:360px;width:100%;text-align:center;}
    .vschool{color:#d4a62a;font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:14px;}
    .vcard{background:#fff;border-radius:16px;padding:28px 22px;box-shadow:0 10px 30px rgba(0,0,0,.3);}
    .vphoto{width:96px;height:96px;border-radius:50%;object-fit:cover;margin:0 auto 14px;display:block;border:3px solid #f1f3f7;}
    .vnoimg{display:flex;align-items:center;justify-content:center;background:#f1f3f7;color:#999;font-size:11px;}
    .vicon{font-size:40px;margin-bottom:10px;}
    h2{margin:6px 0 10px;color:#0a1628;font-size:19px;}
    .vbadge{display:inline-block;padding:6px 16px;border-radius:100px;font-weight:700;font-size:12.5px;margin-bottom:16px;}
    .vbadge.ok{background:#dcfce7;color:#166534;}
    .vbadge.no{background:#fee2e2;color:#991b1b;}
    .vtbl{width:100%;border-collapse:collapse;font-size:13px;text-align:left;}
    .vtbl td{padding:8px 4px;border-bottom:1px solid #eee;color:#333;}
    .vtbl td:first-child{color:#888;width:42%;}
    .vcard.bad h2{color:#991b1b;}
    .vcard p{color:#666;font-size:13px;line-height:1.6;}
    .vfoot{color:rgba(255,255,255,.5);font-size:11px;margin-top:16px;}
  </style></head><body>
    <div class="vwrap">
      <div class="vschool">Ideal Children Academy</div>
      ${html}
      <div class="vfoot">Scanned via school ID card QR verification</div>
    </div>
  </body></html>`);
});

// Fallback — serve index.html for any non-API route (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀  ICA School Website running on http://localhost:${PORT}`);
});
