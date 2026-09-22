/**
 * Bridge di sincronizzazione BancoPosta -> Firestore.
 *
 * Distribuire come Web app:
 * - Esegui come: utente che esegue il deployment
 * - Accesso: chiunque
 *
 * Proprietà script obbligatoria:
 * - ALLOWED_UID: UID Firebase del proprietario dell'app
 *
 * Il bridge accetta esclusivamente token monouso creati dall'utente autenticato
 * nella raccolta users/{uid}/syncSessions/{sessionId}. Nessun segreto è incluso
 * in questo file o nel repository.
 */

const CONFIG = Object.freeze({
  projectId: 'budget-bancoposta',
  databaseId: '(default)',
  purpose: 'poste-import-v1',
  maxPayloadBytes: 2 * 1024 * 1024,
  maxMovements: 2000,
  maxSessionMinutes: 15,
  writesPerCommit: 150,
  allowedCategories: [
    'income', 'groceries', 'fuel', 'bills', 'subscriptions', 'home',
    'health', 'family', 'leisure', 'cash', 'savings', 'transfer', 'other'
  ]
});

function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'budget-bancoposta-sync',
    version: 1,
    acceptsFinancialOperations: false
  });
}

function doPost(e) {
  try {
    const request = parseRequest_(e);
    const result = withImportLock_(function () {
      return importSnapshot_(request);
    });
    return jsonResponse_({ ok: true, result: result });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return jsonResponse_({
      ok: false,
      error: safeErrorMessage_(error)
    });
  }
}

function withImportLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Sincronizzazione già in corso. Riprova tra poco.');
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function parseRequest_(e) {
  if (!e || !e.postData) throw new Error('Richiesta POST mancante.');
  const raw = String(e.postData.contents || '');
  if (!raw || raw.length > CONFIG.maxPayloadBytes) throw new Error('Payload assente o troppo grande.');

  let body;
  if (/application\/json/i.test(String(e.postData.type || ''))) {
    body = JSON.parse(raw);
  } else {
    const params = e.parameter || {};
    body = {
      uid: params.uid,
      sessionId: params.sessionId,
      token: params.token,
      payload: params.payload
    };
  }

  const uid = requirePattern_(body.uid, /^[A-Za-z0-9:_-]{6,160}$/, 'UID non valido.');
  const sessionId = requirePattern_(body.sessionId, /^[A-Za-z0-9_-]{16,100}$/, 'Sessione non valida.');
  const token = requirePattern_(body.token, /^[A-Za-z0-9_-]{32,200}$/, 'Token non valido.');
  const payload = typeof body.payload === 'string' ? JSON.parse(body.payload) : body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Dati di sincronizzazione non validi.');
  return { uid: uid, sessionId: sessionId, token: token, payload: payload };
}

function importSnapshot_(request) {
  assertAllowedUid_(request.uid);
  const sessionPath = 'users/' + request.uid + '/syncSessions/' + request.sessionId;
  const sessionDocument = getDocument_(sessionPath);
  const session = decodeFields_(sessionDocument.fields || {});
  validateSession_(session, request.token);

  const normalized = normalizePayload_(request.payload);
  const existingDocuments = listDocuments_('users/' + request.uid + '/movements');
  const reconciliation = reconcileMovements_(existingDocuments, normalized.movements, request.uid);
  const now = new Date().toISOString();

  commitWrites_(reconciliation.writes);
  commitWrites_([
    mergeWrite_(documentName_('users/' + request.uid + '/budget/current'), {
      balance: normalized.balance,
      balanceDate: normalized.balanceDate,
      lastSync: new Date(now),
      updatedAt: new Date(now)
    }),
    mergeWrite_(documentName_(sessionPath), {
      used: true,
      status: 'completed',
      completedAt: new Date(now),
      imported: reconciliation.imported,
      excluded: normalized.excluded,
      duplicates: normalized.duplicates + reconciliation.duplicates
    })
  ]);

  return {
    imported: reconciliation.imported,
    excluded: normalized.excluded,
    duplicates: normalized.duplicates + reconciliation.duplicates,
    balanceDate: normalized.balanceDate
  };
}

function assertAllowedUid_(uid) {
  const allowed = String(PropertiesService.getScriptProperties().getProperty('ALLOWED_UID') || '').trim();
  if (!allowed) throw new Error('Bridge non configurato: ALLOWED_UID mancante.');
  if (!constantTimeEqual_(uid, allowed)) throw new Error('Utente non autorizzato.');
}

function validateSession_(session, token) {
  if (!session || session.purpose !== CONFIG.purpose) throw new Error('Sessione non riconosciuta.');
  if (session.used === true || session.status === 'completed') throw new Error('Token già utilizzato.');
  if (!session.tokenHash || !constantTimeEqual_(session.tokenHash, sha256Hex_(token))) throw new Error('Token non valido.');

  const expiresAt = session.expiresAt instanceof Date ? session.expiresAt : new Date(session.expiresAt);
  const createdAt = session.createdAt instanceof Date ? session.createdAt : new Date(session.createdAt);
  const now = Date.now();
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now) throw new Error('Token scaduto.');
  if (expiresAt.getTime() - now > CONFIG.maxSessionMinutes * 60000) throw new Error('Scadenza della sessione non valida.');
  if (Number.isFinite(createdAt.getTime()) && createdAt.getTime() > now + 60000) throw new Error('Data della sessione non valida.');
}

function normalizePayload_(payload) {
  const balance = requireFiniteNumber_(payload.balance, 'Saldo non valido.');
  if (Math.abs(balance) > 1000000000) throw new Error('Saldo fuori intervallo.');
  const balanceDate = requireIsoDate_(payload.balanceDate, 'Data saldo non valida.');
  const input = Array.isArray(payload.movements) ? payload.movements : [];
  if (input.length > CONFIG.maxMovements) throw new Error('Troppi movimenti nel payload.');

  const kept = [];
  let excluded = 0;
  let duplicates = 0;
  input.forEach(function (raw) {
    const movement = normalizeMovement_(raw);
    if (isInternalMovement_(movement)) {
      excluded += 1;
      return;
    }
    const duplicate = kept.some(function (candidate) { return movementsMatch_(candidate, movement); });
    if (duplicate) {
      duplicates += 1;
      return;
    }
    kept.push(movement);
  });
  return { balance: balance, balanceDate: balanceDate, movements: kept, excluded: excluded, duplicates: duplicates };
}

function normalizeMovement_(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Movimento non valido.');
  const operationDate = optionalIsoDate_(raw.operationDate || raw.date || raw.accountingDate);
  const accountingDate = optionalIsoDate_(raw.accountingDate);
  if (!operationDate && !accountingDate) throw new Error('Movimento senza data valida.');
  const sortDate = optionalDateTime_(raw.sortDate) || new Date((operationDate || accountingDate) + 'T12:00:00.000Z');
  const statusText = cleanText_(raw.status, 40).toLowerCase();
  const pending = raw.pending === true || raw.accounted === false || statusText === 'pending' || /non contabil|da contabil|in attesa/.test(statusText);
  const category = CONFIG.allowedCategories.indexOf(raw.category) >= 0 ? raw.category : guessCategory_(raw);
  const sourceId = cleanText_(raw.id, 150).replace(/[^A-Za-z0-9_-]/g, '');
  const fingerprint = [operationDate || accountingDate, requireFiniteNumber_(raw.amount, 'Importo non valido.').toFixed(2), cleanText_(raw.description || raw.type, 250).toLowerCase()].join('|');
  const id = sourceId || ('poste_' + sha256Hex_(fingerprint).slice(0, 32));
  return {
    id: id,
    amount: requireFiniteNumber_(raw.amount, 'Importo non valido.'),
    description: cleanText_(raw.description, 250),
    type: cleanText_(raw.type, 120),
    details: cleanText_(raw.details, 500),
    operationDate: operationDate || accountingDate,
    accountingDate: accountingDate || '',
    sortDate: sortDate,
    status: pending ? 'pending' : 'accounted',
    pending: pending,
    accounted: !pending,
    category: category,
    source: 'poste'
  };
}

function reconcileMovements_(documents, incoming, uid) {
  const writes = [];
  const active = [];
  let duplicates = 0;
  const basePath = 'users/' + uid + '/movements/';

  documents.forEach(function (document) {
    const movement = decodeFields_(document.fields || {});
    movement.id = document.name.split('/').pop();
    movement._documentName = document.name;
    if (movement.split === true) {
      active.push(movement);
      return;
    }
    if (isPending_(movement) || isInternalMovement_(movement)) {
      writes.push({ delete: document.name });
      return;
    }
    const duplicate = active.find(function (candidate) {
      return candidate.split !== true && movementsMatch_(candidate, movement);
    });
    if (duplicate) {
      const keepCurrent = manualScore_(movement) > manualScore_(duplicate);
      writes.push({ delete: keepCurrent ? duplicate._documentName : document.name });
      if (keepCurrent) {
        const index = active.indexOf(duplicate);
        active[index] = movement;
      }
      duplicates += 1;
      return;
    }
    active.push(movement);
  });

  incoming.forEach(function (movement) {
    if (splitGroupMatches_(active, movement)) {
      duplicates += 1;
      return;
    }
    const matched = active.find(function (candidate) {
      return candidate.split !== true && movementsMatch_(candidate, movement);
    });
    if (matched) {
      if (movement.pending && !isPending_(matched)) {
        duplicates += 1;
        return;
      }
      writes.push(mergeWrite_(matched._documentName, movementForWrite_(movement, matched)));
      Object.assign(matched, movement);
      duplicates += 1;
      return;
    }
    const documentName = documentName_(basePath + movement.id);
    writes.push(mergeWrite_(documentName, movementForWrite_(movement, null)));
    active.push(Object.assign({ _documentName: documentName }, movement));
  });

  return { writes: writes, imported: incoming.length, duplicates: duplicates };
}

function movementForWrite_(movement, existing) {
  const result = {
    amount: movement.amount,
    description: movement.description,
    type: movement.type,
    details: movement.details,
    operationDate: movement.operationDate,
    accountingDate: movement.accountingDate,
    sortDate: movement.sortDate,
    status: movement.status,
    pending: movement.pending,
    accounted: movement.accounted,
    category: movement.category,
    source: 'poste'
  };
  if (existing && existing.editedAt) delete result.category;
  return result;
}

function splitGroupMatches_(existing, incoming) {
  const candidates = existing.filter(function (movement) {
    return movement.split === true && movementDate_(movement) === movementDate_(incoming) &&
      Math.sign(Number(movement.amount)) === Math.sign(Number(incoming.amount)) &&
      descriptionsSimilar_(movement, incoming);
  });
  if (candidates.length < 2) return false;
  const total = candidates.reduce(function (sum, movement) { return sum + Number(movement.amount); }, 0);
  return Math.abs(total - Number(incoming.amount)) < 0.005;
}

function movementsMatch_(a, b) {
  if (movementDate_(a) !== movementDate_(b)) return false;
  if (Number(a.amount).toFixed(2) !== Number(b.amount).toFixed(2)) return false;
  return descriptionsSimilar_(a, b);
}

function descriptionsSimilar_(a, b) {
  const aWords = significantWords_(a.description || a.type);
  const bWords = significantWords_(b.description || b.type);
  if (!aWords.length || !bWords.length) return cleanText_(a.description || a.type, 250).toLowerCase() === cleanText_(b.description || b.type, 250).toLowerCase();
  const common = aWords.filter(function (word) { return bWords.indexOf(word) >= 0; }).length;
  return common >= 2 || aWords.every(function (word) { return bWords.indexOf(word) >= 0; }) || bWords.every(function (word) { return aWords.indexOf(word) >= 0; });
}

function movementDate_(movement) {
  const value = movement.operationDate || movement.accountingDate || movement.date || movement.sortDate;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function significantWords_(value) {
  return cleanText_(value, 300).toLowerCase().replace(/[^a-z0-9à-ù ]/g, ' ').split(/\s+/).filter(function (word) {
    return word.length > 3 && !/^\d+$/.test(word);
  });
}

function isPending_(movement) {
  return movement.pending === true || movement.accounted === false || /pending|non contabil|da contabil|in attesa/.test(String(movement.status || '').toLowerCase());
}

function isInternalMovement_(movement) {
  const category = movement.category || guessCategory_(movement);
  const text = [movement.description, movement.type, movement.details].join(' ').toLowerCase();
  return category === 'transfer' || category === 'savings' || /giro\s?fond|salvadanaio|trasferimento\s+(?:da|a|verso)\s+(?:un\s+)?(?:mio\s+)?conto|movimento interno/.test(text);
}

function guessCategory_(movement) {
  const text = [movement.description, movement.type].join(' ').toLowerCase();
  const amount = Number(movement.amount);
  if (amount > 0 && !/girofondo|trasferimento/.test(text)) return 'income';
  if (/salvadanaio|risparmi/.test(text)) return 'savings';
  if (/girofondo|trasferimento|bonifico.*(mio|conto)/.test(text)) return 'transfer';
  if (/eni|q8|esso|tamoil|ip |carbur|benz|diesel/.test(text)) return 'fuel';
  if (/netflix|youtube|spotify|google play|disney|prime video|dazn|abbonamento|ricorrente/.test(text)) return 'subscriptions';
  if (/conad|coop|lidl|eurospin|penny|md |supermerc|aliment|market|panific|ortofrutta/.test(text)) return 'groceries';
  if (/enel|energia|gas|acqua|tim|vodafone|wind|iliad|kena|bollett/.test(text)) return 'bills';
  if (/leroy|brico|ferrament|mobil|arredo|casa/.test(text)) return 'home';
  if (/farmac|medic|sanit|ospedal/.test(text)) return 'health';
  if (/prelievo|atm/.test(text)) return 'cash';
  if (/ristor|bar |pizzeria|friggitoria|pasticceria|cinema/.test(text)) return 'leisure';
  if (/scuola|cartotecn|cartoler|bambin|ovs kids|famigl/.test(text)) return 'family';
  return 'other';
}

function manualScore_(movement) {
  return (movement.note ? 4 : 0) + (movement.editedAt ? 2 : 0) + (movement.hidden ? 1 : 0) + (movement.excluded ? 1 : 0);
}

function getDocument_(path) {
  const response = firestoreFetch_(documentUrl_(path), { method: 'get' });
  if (response.getResponseCode() === 404) throw new Error('Sessione non trovata.');
  assertSuccessful_(response);
  return JSON.parse(response.getContentText());
}

function listDocuments_(collectionPath) {
  const documents = [];
  let pageToken = '';
  do {
    const url = documentUrl_(collectionPath) + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const response = firestoreFetch_(url, { method: 'get' });
    assertSuccessful_(response);
    const body = JSON.parse(response.getContentText() || '{}');
    (body.documents || []).forEach(function (document) { documents.push(document); });
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return documents;
}

function commitWrites_(writes) {
  for (let offset = 0; offset < writes.length; offset += CONFIG.writesPerCommit) {
    const chunk = writes.slice(offset, offset + CONFIG.writesPerCommit);
    const response = firestoreFetch_(firestoreBase_() + '/documents:commit', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ writes: chunk })
    });
    assertSuccessful_(response);
  }
}

function mergeWrite_(name, object) {
  const fields = encodeFields_(object);
  return {
    update: { name: name, fields: fields },
    updateMask: { fieldPaths: Object.keys(fields) }
  };
}

function firestoreFetch_(url, options) {
  const request = Object.assign({}, options || {}, {
    muteHttpExceptions: true,
    headers: Object.assign({}, (options && options.headers) || {}, {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
    })
  });
  return UrlFetchApp.fetch(url, request);
}

function assertSuccessful_(response) {
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    let message = 'Errore Firestore (' + status + ').';
    try {
      const body = JSON.parse(response.getContentText());
      if (body && body.error && body.error.message) message += ' ' + body.error.message;
    } catch (ignored) {}
    throw new Error(message);
  }
}

function firestoreBase_() {
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(CONFIG.projectId) + '/databases/' + encodeURIComponent(CONFIG.databaseId);
}

function documentUrl_(path) {
  return firestoreBase_() + '/documents/' + path.split('/').map(encodeURIComponent).join('/');
}

function documentName_(path) {
  return 'projects/' + CONFIG.projectId + '/databases/' + CONFIG.databaseId + '/documents/' + path;
}

function encodeFields_(object) {
  const result = {};
  Object.keys(object).forEach(function (key) {
    if (object[key] !== undefined) result[key] = encodeValue_(object[key]);
  });
  return result;
}

function encodeValue_(value) {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Valore numerico non valido.');
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue_) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeFields_(value) } };
  throw new Error('Tipo di dato non supportato.');
}

function decodeFields_(fields) {
  const result = {};
  Object.keys(fields || {}).forEach(function (key) { result[key] = decodeValue_(fields[key]); });
  return result;
}

function decodeValue_(value) {
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return new Date(value.timestampValue);
  if (value.arrayValue) return (value.arrayValue.values || []).map(decodeValue_);
  if (value.mapValue) return decodeFields_(value.mapValue.fields || {});
  return undefined;
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8).map(function (byte) {
    return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

function constantTimeEqual_(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index % Math.max(1, left.length)) || 0) ^ (right.charCodeAt(index % Math.max(1, right.length)) || 0);
  }
  return difference === 0;
}

function requirePattern_(value, pattern, message) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) throw new Error(message);
  return text;
}

function requireFiniteNumber_(value, message) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(message);
  return number;
}

function requireIsoDate_(value, message) {
  const date = optionalIsoDate_(value);
  if (!date) throw new Error(message);
  return date;
}

function optionalIsoDate_(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const parsed = new Date(text + 'T12:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : '';
}

function optionalDateTime_(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function cleanText_(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeErrorMessage_(error) {
  const message = cleanText_(error && error.message ? error.message : 'Errore di sincronizzazione.', 300);
  return message || 'Errore di sincronizzazione.';
}

function jsonResponse_(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}
