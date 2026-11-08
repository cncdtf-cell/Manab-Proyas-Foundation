/**
 * মানব প্রয়াস ফাউন্ডেশন — Google Drive মিডিয়া আপলোড স্ক্রিপ্ট (Google Apps Script)
 *
 * কী করে:
 *  - অ্যাডমিন প্যানেল (admin.html) থেকে ছবি/PDF আপলোড নেয় → আপনার Drive-এর "ManabProyas-Media" ফোল্ডারে রাখে
 *    → "Anyone with the link" ভিউ-শেয়ারিং দেয় → লিংক ফেরত পাঠায়
 *  - ভিডিওর জন্য Drive-এর resumable upload সেশন খুলে দেয় (ব্রাউজার সরাসরি Drive-এ পাঠায়)
 *  - ছবি/ভিডিও "মুছুন/বদলান" হলে পুরনো ফাইল Drive-এর ট্র্যাশে পাঠায় (৩০ দিন ফেরত আনা যায়)
 *
 * নিরাপত্তা:
 *  - প্রতিটি অনুরোধে Firebase লগইন-টোকেন যাচাই হয়, এবং Firestore-এর admins/{uid} ডকুমেন্ট থাকলেই কাজ হয়।
 *    অর্থাৎ শুধু আপনার অ্যাডমিন অ্যাকাউন্টই এই স্ক্রিপ্ট ব্যবহার করতে পারে। কোনো গোপন পাসওয়ার্ড এখানে নেই।
 *  - ট্র্যাশ শুধু "ManabProyas-Media" ফোল্ডারের ভেতরের ফাইলেই কাজ করে; আপনার Drive-এর অন্য ফাইল ছুঁতে পারে না।
 */

var CONFIG = {
  API_KEY: 'AIzaSyB-P0cvt6LXZbVLvczUJDEUdQFqvN8iZpI',   // Firebase apiKey (গোপন নয়)
  PROJECT_ID: 'manabproyas',
  ROOT_FOLDER_NAME: 'ManabProyas-Media',
  FOLDERS: ['projects', 'gallery', 'news', 'team', 'stories', 'site', 'reports', 'videos', 'misc'],
  UPLOAD_MIMES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
  MAX_UPLOAD_BYTES: 20 * 1024 * 1024
};

/* ----- একবার ম্যানুয়ালি Run করুন (অনুমতি দিতে + ফোল্ডার বানাতে) ----- */
function setup() {
  var root = root_();
  UrlFetchApp.fetch('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest', { muteHttpExceptions: true }); // external_request অনুমতির জন্য
  CONFIG.FOLDERS.forEach(function (f) { sub_(root, f); });
  Logger.log('প্রস্তুত! Drive ফোল্ডার: ' + root.getUrl());
}

function doGet() { return json_({ ok: true, service: 'manabproyas-drive', note: 'POST only' }); }

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    verify_(req.token);
    switch (req.action) {
      case 'upload':    return json_(upload_(req));
      case 'initVideo': return json_(initVideo_(req));
      case 'finalize':  return json_(finalize_(req));
      case 'trash':     return json_(trash_(req));
      default: throw new Error('Unknown action');
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------- নিরাপত্তা: Firebase টোকেন + admins/{uid} ---------- */
function verify_(idToken) {
  if (!idToken) throw new Error('লগইন টোকেন নেই');
  var cache = CacheService.getScriptCache();
  var key = 'ok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  if (cache.get(key)) return cache.get(key);
  var r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + CONFIG.API_KEY, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('লগইন টোকেন সঠিক নয় বা মেয়াদ শেষ — আবার লগইন করুন');
  var uid = JSON.parse(r.getContentText()).users[0].localId;
  var f = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/projects/' + CONFIG.PROJECT_ID + '/databases/(default)/documents/admins/' + uid, {
    headers: { Authorization: 'Bearer ' + idToken }, muteHttpExceptions: true
  });
  if (f.getResponseCode() !== 200) throw new Error('এই অ্যাকাউন্ট অ্যাডমিন নয়');
  cache.put(key, uid, 300);
  return uid;
}

/* ---------- ফোল্ডার ---------- */
function root_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ROOT_ID');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    id = props.getProperty('ROOT_ID');
    if (id) { try { var g = DriveApp.getFolderById(id); if (!g.isTrashed()) return g; } catch (e) {} }
    var it = DriveApp.getFoldersByName(CONFIG.ROOT_FOLDER_NAME);
    var root = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
    props.setProperty('ROOT_ID', root.getId());
    return root;
  } finally { lock.releaseLock(); }
}
function sub_(root, name) {
  if (CONFIG.FOLDERS.indexOf(name) < 0) name = 'misc';
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}
function inRoot_(file) {
  var rid = root_().getId(), cur = [file];
  for (var depth = 0; depth < 6; depth++) {
    var next = [];
    for (var i = 0; i < cur.length; i++) {
      var it = cur[i].getParents();
      while (it.hasNext()) { var p = it.next(); if (p.getId() === rid) return true; next.push(p); }
    }
    if (!next.length) return false;
    cur = next;
  }
  return false;
}
function clean_(name) { return String(name || 'file').replace(/[\\\/:*?"<>|\r\n]+/g, '_').slice(0, 120); }
function share_(file) { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
function viewUrl_(id) { return 'https://drive.google.com/file/d/' + id + '/view'; }

/* ---------- ছবি / PDF আপলোড (base64) ---------- */
function upload_(req) {
  var mime = String(req.mime || '');
  if (CONFIG.UPLOAD_MIMES.indexOf(mime) < 0) throw new Error('এই ধরনের ফাইল অনুমোদিত নয়');
  var bytes = Utilities.base64Decode(req.data || '');
  if (!bytes.length) throw new Error('ফাইল খালি');
  if (bytes.length > CONFIG.MAX_UPLOAD_BYTES) throw new Error('ফাইল অনেক বড়');
  var folder = sub_(root_(), req.folder);
  var file = folder.createFile(Utilities.newBlob(bytes, mime, Utilities.formatDate(new Date(), 'Asia/Dhaka', 'yyyyMMdd-HHmmss') + '_' + clean_(req.name)));
  share_(file);
  return { ok: true, id: file.getId(), url: viewUrl_(file.getId()) };
}

/* ---------- ভিডিও: resumable সেশন (ফাইল ব্রাউজার থেকে সরাসরি Drive-এ যায়) ---------- */
function initVideo_(req) {
  var mime = String(req.mime || '');
  if (mime.indexOf('video/') !== 0) throw new Error('শুধু ভিডিও ফাইল');
  var size = Number(req.size) || 0;
  if (!size || size > 300 * 1024 * 1024) throw new Error('ভিডিও ৩০০ MB-এর মধ্যে হতে হবে');
  var origin = String(req.origin || '');
  if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(origin)) throw new Error('সাইটের ঠিকানা (origin) বোঝা যায়নি — সাইট হোস্ট করে খুলুন');
  var folder = sub_(root_(), 'videos');
  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size), Origin: origin },
    payload: JSON.stringify({ name: Utilities.formatDate(new Date(), 'Asia/Dhaka', 'yyyyMMdd-HHmmss') + '_' + clean_(req.name), mimeType: mime, parents: [folder.getId()] })
  });
  var h = res.getHeaders(), loc = h['Location'] || h['location'];
  if (res.getResponseCode() !== 200 || !loc) throw new Error('ভিডিও আপলোড সেশন খোলা যায়নি (' + res.getResponseCode() + ')');
  return { ok: true, session: loc };
}
function finalize_(req) {
  var file = DriveApp.getFileById(String(req.id));
  if (!inRoot_(file)) throw new Error('ফাইলটি মিডিয়া ফোল্ডারে নেই');
  share_(file);
  return { ok: true, id: file.getId(), url: viewUrl_(file.getId()) };
}

/* ---------- ট্র্যাশ (শুধু আমাদের ফোল্ডারের ফাইল) ---------- */
function trash_(req) {
  var ids = (req.ids || []).slice(0, 50), trashed = [], skipped = [];
  ids.forEach(function (id) {
    try {
      var f = DriveApp.getFileById(String(id));
      if (inRoot_(f)) { f.setTrashed(true); trashed.push(id); } else skipped.push(id);
    } catch (e) { skipped.push(id); }
  });
  return { ok: true, trashed: trashed, skipped: skipped };
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
