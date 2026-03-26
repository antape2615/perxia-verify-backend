import { getDb } from '../database.js';
import { extractTextFromPdf, extractImagesFromPdf, scanDocuments } from './pdfService.js';
import { analyzeContract, analyzeContractVision, analyzeContractHybrid, analyzeFolderSummary } from './anthropicService.js';
import { classifyDocument, getMainCategory, getClientFromFolder } from './classifier.js';
import path from 'path';

// --- Stats ---
export function getStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM documents').get();
  const processed = db.prepare("SELECT COUNT(*) as count FROM documents WHERE status = 'processed'").get();
  const pending = db.prepare("SELECT COUNT(*) as count FROM documents WHERE status = 'pending'").get();
  const failed = db.prepare("SELECT COUNT(*) as count FROM documents WHERE status = 'error'").get();

  const docTypes = db
    .prepare('SELECT doc_type, COUNT(*) as count FROM documents GROUP BY doc_type ORDER BY count DESC')
    .all();

  const mainCategories = db
    .prepare(
      `SELECT main_category, COUNT(*) as total,
        SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed
       FROM documents WHERE main_category IS NOT NULL GROUP BY main_category ORDER BY total DESC`
    )
    .all();

  const clients = db
    .prepare(
      `SELECT client_name, main_category, COUNT(*) as doc_count
       FROM documents WHERE client_name IS NOT NULL AND client_name != ''
       GROUP BY client_name, main_category ORDER BY main_category, client_name`
    )
    .all();

  const recentDocs = db
    .prepare(
      `SELECT id, file_name, folder, doc_type, client_name, main_category, client, contract_number, value, currency, status 
       FROM documents ORDER BY processed_at DESC NULLS LAST LIMIT 10`
    )
    .all();

  return {
    total: total.count,
    processed: processed.count,
    pending: pending.count,
    failed: failed.count,
    docTypes,
    mainCategories,
    clients,
    recentDocs,
  };
}

// --- Category breakdown ---
export function getCategoryBreakdown(category) {
  const db = getDb();

  const clients = db
    .prepare(
      `SELECT client_name, COUNT(*) as doc_count,
        SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed
       FROM documents WHERE main_category = ? AND client_name IS NOT NULL
       GROUP BY client_name ORDER BY client_name`
    )
    .all(category);

  const docTypes = db
    .prepare(
      `SELECT doc_type, COUNT(*) as count
       FROM documents WHERE main_category = ?
       GROUP BY doc_type ORDER BY count DESC`
    )
    .all(category);

  const total = db.prepare('SELECT COUNT(*) as count FROM documents WHERE main_category = ?').get(category);
  const processed = db.prepare("SELECT COUNT(*) as count FROM documents WHERE main_category = ? AND status = 'processed'").get(category);

  return {
    category,
    total: total.count,
    processed: processed.count,
    clients,
    docTypes,
  };
}

export function getClientBreakdown(clientName, category) {
  const db = getDb();

  let where = 'client_name = ?';
  const params = [clientName];
  if (category) {
    where += ' AND main_category = ?';
    params.push(category);
  }

  const docTypes = db
    .prepare(`SELECT doc_type, COUNT(*) as count FROM documents WHERE ${where} GROUP BY doc_type ORDER BY count DESC`)
    .all(...params);

  const docs = db
    .prepare(
      `SELECT id, file_name, folder, doc_type, client, contract_number, value, currency, 
              start_date, end_date, summary, status
       FROM documents WHERE ${where} ORDER BY doc_type, file_name`
    )
    .all(...params);

  return { clientName, category, docTypes, documents: docs };
}

// --- Folder Hierarchy ---
export function getFolderTree() {
  const db = getDb();
  const folders = db
    .prepare(
      `SELECT f.*, 
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) as doc_count,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.status = 'processed') as processed_count
       FROM folders f ORDER BY f.path`
    )
    .all();

  const map = {};
  const roots = [];
  for (const f of folders) map[f.path] = { ...f, children: [] };
  for (const f of folders) {
    const node = map[f.path];
    if (f.parent_path && map[f.parent_path]) map[f.parent_path].children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function getFolderById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
}

export function getFolderDetail(folderId) {
  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
  if (!folder) return null;

  const documents = db
    .prepare(
      `SELECT id, file_name, folder, doc_type, client, contract_number, contract_type, 
              start_date, end_date, value, currency, summary, status, processed_at
       FROM documents WHERE folder_id = ? ORDER BY doc_type, file_name`
    )
    .all(folderId);

  const subfolders = db
    .prepare(
      `SELECT f.*, 
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) as doc_count,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.status = 'processed') as processed_count
       FROM folders f WHERE f.parent_path = ? ORDER BY f.name`
    )
    .all(folder.path);

  const docTypeCounts = db
    .prepare('SELECT doc_type, COUNT(*) as count FROM documents WHERE folder_id = ? GROUP BY doc_type ORDER BY count DESC')
    .all(folderId);

  return { folder, documents, subfolders, docTypeCounts };
}

// --- Documents CRUD ---
export function getAllDocuments(page = 1, limit = 20, filters = {}) {
  const db = getDb();
  const offset = (page - 1) * limit;

  let where = '1=1';
  const params = {};

  if (filters.client) { where += ' AND (client LIKE @client OR client_name LIKE @client)'; params.client = `%${filters.client}%`; }
  if (filters.status) { where += ' AND status = @status'; params.status = filters.status; }
  if (filters.docType) { where += ' AND doc_type = @docType'; params.docType = filters.docType; }
  if (filters.folder) { where += ' AND folder LIKE @folder'; params.folder = `%${filters.folder}%`; }
  if (filters.folderId) { where += ' AND folder_id = @folderId'; params.folderId = Number(filters.folderId); }
  if (filters.mainCategory) { where += ' AND main_category = @mainCategory'; params.mainCategory = filters.mainCategory; }
  if (filters.clientName) { where += ' AND client_name = @clientName'; params.clientName = filters.clientName; }

  const countResult = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE ${where}`).get(params);

  const documents = db
    .prepare(
      `SELECT id, file_name, folder, doc_type, main_category, client_name, client, contract_number,
              start_date, end_date, value, currency, summary, status, processed_at
       FROM documents WHERE ${where}
       ORDER BY main_category, client_name, doc_type, file_name
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  return {
    documents,
    total: countResult.count,
    page,
    totalPages: Math.ceil(countResult.count / limit),
  };
}

export function getDocumentById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

export function searchDocuments(query) {
  const db = getDb();
  const ftsQuery = query.split(/\s+/).map((t) => `"${t}"*`).join(' OR ');

  try {
    return db
      .prepare(
        `SELECT d.id, d.file_name, d.folder, d.doc_type, d.main_category, d.client_name,
                d.client, d.contract_number, d.value, d.currency, d.summary, d.status, rank
         FROM docs_fts fts JOIN documents d ON d.id = fts.rowid
         WHERE docs_fts MATCH @query ORDER BY rank LIMIT 50`
      )
      .all({ query: ftsQuery });
  } catch {
    return db
      .prepare(
        `SELECT id, file_name, folder, doc_type, main_category, client_name,
                client, contract_number, value, currency, summary, status
         FROM documents 
         WHERE file_name LIKE @q OR client LIKE @q OR contract_number LIKE @q 
               OR summary LIKE @q OR terms LIKE @q OR folder LIKE @q
         LIMIT 50`
      )
      .all({ q: `%${query}%` });
  }
}

// --- Document Registration ---
export function registerDocuments(contractsPath) {
  const db = getDb();
  const docs = scanDocuments(contractsPath);

  const folderSet = new Set();
  for (const doc of docs) {
    let cur = doc.folder;
    while (cur && cur !== '.' && cur !== 'root') {
      folderSet.add(cur);
      cur = path.dirname(cur);
      if (cur === '.') break;
    }
  }

  const insertFolder = db.prepare(
    'INSERT OR IGNORE INTO folders (path, name, parent_path, level, main_category, client_name) VALUES (?, ?, ?, ?, ?, ?)'
  );

  db.transaction(() => {
    for (const fp of [...folderSet].sort()) {
      const name = path.basename(fp);
      const parent = path.dirname(fp);
      const parentPath = parent === '.' ? null : parent;
      const level = fp.split(path.sep).length - 1;
      const mainCat = getMainCategory(fp);
      const clientName = getClientFromFolder(fp);
      insertFolder.run(fp, name, parentPath, level, mainCat, clientName);
    }
  })();

  const folderMap = {};
  db.prepare('SELECT id, path FROM folders').all().forEach((f) => { folderMap[f.path] = f.id; });

  const insertDoc = db.prepare(
    `INSERT OR IGNORE INTO documents (file_path, file_name, folder, folder_id, doc_type, main_category, client_name, status) 
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  );

  const inserted = db.transaction((items) => {
    let count = 0;
    for (const doc of items) {
      const folderId = folderMap[doc.folder] || null;
      const docType = classifyDocument(doc.fileName, doc.folder);
      const mainCat = getMainCategory(doc.folder);
      const clientName = getClientFromFolder(doc.folder);
      const r = insertDoc.run(doc.fullPath, doc.fileName, doc.folder, folderId, docType, mainCat, clientName);
      if (r.changes > 0) count++;
    }
    return count;
  })(docs);

  // Count types
  const typeCounts = db.prepare('SELECT doc_type, COUNT(*) as count FROM documents GROUP BY doc_type ORDER BY count DESC').all();

  return { total: docs.length, newlyRegistered: inserted, folders: folderSet.size, docTypes: typeCounts };
}

// --- Process document ---
export async function processDocument(filePath, fileName, folder) {
  const db = getDb();

  const existing = db.prepare('SELECT id, status FROM documents WHERE file_path = ?').get(filePath);
  if (existing && existing.status === 'processed') return { skipped: true, id: existing.id };

  try {
    let text = '';
    let numPages = 0;
    try {
      const extracted = await extractTextFromPdf(filePath);
      text = extracted.text;
      numPages = extracted.numPages;
    } catch {
      text = '';
    }

    const hasGoodText = text && text.trim().length > 100;
    let analysis;

    if (hasGoodText) {
      analysis = await analyzeContract(text, fileName, folder || '');
    } else {
      console.log(`[Vision] ${fileName} - texto insuficiente (${(text || '').trim().length} chars), intentando imágenes...`);
      let images = [];
      try {
        images = await extractImagesFromPdf(filePath, Math.min(numPages || 5, 8));
      } catch (imgErr) {
        const isPasswordProtected = /password|encrypted|decrypt/i.test(imgErr.message);
        if (isPasswordProtected) {
          console.log(`[Protegido] ${fileName} - PDF protegido con contraseña, analizando solo con nombre/carpeta`);
        } else {
          console.log(`[Vision Img Error] ${fileName}: ${imgErr.message}`);
        }
        images = [];
      }

      if (images.length > 0) {
        try {
          if (text && text.trim().length > 20) {
            analysis = await analyzeContractHybrid(text, images, fileName, folder || '');
          } else {
            analysis = await analyzeContractVision(images, fileName, folder || '');
          }
        } catch (aiErr) {
          console.error(`[Vision AI Error] ${fileName}:`, aiErr.message);
          analysis = await analyzeContract(
            `[Documento sin texto extraíble. Nombre del archivo: ${fileName}. Carpeta: ${folder}. Analiza basándote en el contexto disponible.]`,
            fileName, folder || ''
          );
        }
      } else {
        try {
          analysis = await analyzeContract(
            `[Documento sin texto extraíble (posiblemente protegido o escaneado sin OCR). Nombre: ${fileName}. Carpeta: ${folder}. Extrae lo que puedas del nombre y la ruta.]`,
            fileName, folder || ''
          );
        } catch (fallbackErr) {
          console.error(`[Fallback Error] ${fileName}:`, fallbackErr.message);
          const id = upsertDocument(db, filePath, fileName, folder, text, { summary: 'Documento protegido o sin contenido extraíble.' }, 'no_text');
          return { id, status: 'no_text' };
        }
      }
    }

    const id = upsertDocument(db, filePath, fileName, folder, text, analysis, 'processed');

    db.prepare("INSERT INTO processing_log (file_path, folder_path, status) VALUES (?, ?, 'success')").run(filePath, folder);
    return { id, status: 'processed', analysis };
  } catch (error) {
    console.error(`Error procesando ${fileName}:`, error.message);
    db.prepare("INSERT INTO processing_log (file_path, folder_path, status, error) VALUES (?, ?, 'error', ?)").run(filePath, folder, error.message);
    upsertDocument(db, filePath, fileName, folder, null, null, 'error');
    return { status: 'error', error: error.message };
  }
}

export async function processFolderDocuments(folderId, onProgress) {
  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
  if (!folder) throw new Error('Carpeta no encontrada');

  const pending = db
    .prepare("SELECT * FROM documents WHERE folder_id = ? AND status IN ('pending', 'error') ORDER BY file_name")
    .all(folderId);

  const results = { processed: 0, errors: 0, skipped: 0, total: pending.length };

  for (let i = 0; i < pending.length; i++) {
    const doc = pending[i];
    if (onProgress) onProgress(i, pending.length, doc.file_name);
    try {
      const result = await processDocument(doc.file_path, doc.file_name, doc.folder);
      if (result.skipped) results.skipped++;
      else if (result.status === 'processed') results.processed++;
      else results.errors++;
    } catch { results.errors++; }

    if (i < pending.length - 1) await new Promise((r) => setTimeout(r, 1000));
  }

  try {
    const processedDocs = db.prepare("SELECT * FROM documents WHERE folder_id = ? AND status = 'processed'").all(folderId);
    if (processedDocs.length > 0) {
      const summary = await analyzeFolderSummary(folder.path, processedDocs);
      db.prepare("UPDATE folders SET ai_summary = ?, updated_at = datetime('now') WHERE id = ?").run(summary, folderId);
    }
  } catch (err) {
    console.error(`Error generando resumen de carpeta:`, err.message);
  }

  return results;
}

function toStr(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return val.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join('; ');
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function upsertDocument(db, filePath, fileName, folder, rawText, analysis, status) {
  const existing = db.prepare('SELECT id FROM documents WHERE file_path = ?').get(filePath);
  const a = analysis || {};

  if (existing) {
    db.prepare(
      `UPDATE documents SET 
        file_name=?, folder=?, client=?, contract_number=?, contract_type=?,
        start_date=?, end_date=?, value=?, currency=?, terms=?, agreements=?,
        parties=?, obligations=?, penalties=?, guarantees=?, scope=?,
        payment_terms=?, renewal_clause=?, termination_clause=?,
        summary=?, raw_text=?, ai_analysis=?, status=?, 
        processed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`
    ).run(
      fileName, folder,
      toStr(a.client), toStr(a.contract_number), toStr(a.contract_type),
      toStr(a.start_date), toStr(a.end_date), toStr(a.value),
      toStr(a.currency), toStr(a.terms), toStr(a.agreements),
      toStr(a.parties), toStr(a.obligations), toStr(a.penalties),
      toStr(a.guarantees), toStr(a.scope),
      toStr(a.payment_terms), toStr(a.renewal_clause), toStr(a.termination_clause),
      toStr(a.summary), rawText,
      analysis ? JSON.stringify(analysis) : null,
      status, existing.id
    );
    return existing.id;
  }

  const folderRow = db.prepare('SELECT id FROM folders WHERE path = ?').get(folder);
  const docType = classifyDocument(fileName, folder);
  const mainCat = getMainCategory(folder);
  const clientName = getClientFromFolder(folder);

  const result = db.prepare(
    `INSERT INTO documents (file_path, file_name, folder, folder_id, doc_type, main_category, client_name,
      client, contract_number, contract_type, start_date, end_date, value, currency, terms, agreements,
      parties, obligations, penalties, guarantees, scope, payment_terms,
      renewal_clause, termination_clause, summary, raw_text, ai_analysis, status, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    filePath, fileName, folder, folderRow?.id || null, docType, mainCat, clientName,
    toStr(a.client), toStr(a.contract_number), toStr(a.contract_type),
    toStr(a.start_date), toStr(a.end_date), toStr(a.value),
    toStr(a.currency), toStr(a.terms), toStr(a.agreements),
    toStr(a.parties), toStr(a.obligations), toStr(a.penalties),
    toStr(a.guarantees), toStr(a.scope),
    toStr(a.payment_terms), toStr(a.renewal_clause), toStr(a.termination_clause),
    toStr(a.summary), rawText,
    analysis ? JSON.stringify(analysis) : null, status
  );

  return result.lastInsertRowid;
}

export function getDocsSummaryForChat(limit = 100) {
  const db = getDb();

  let output = '=== RESUMEN POR CATEGORÍA ===\n';
  const cats = db.prepare(
    `SELECT main_category, COUNT(*) as total,
      SUM(CASE WHEN status='processed' THEN 1 ELSE 0 END) as processed
     FROM documents GROUP BY main_category ORDER BY total DESC`
  ).all();

  for (const c of cats) {
    output += `\n📂 ${c.main_category} (${c.total} docs, ${c.processed} procesados)\n`;
    const types = db.prepare(
      'SELECT doc_type, COUNT(*) as count FROM documents WHERE main_category=? GROUP BY doc_type ORDER BY count DESC'
    ).all(c.main_category);
    for (const t of types) output += `   ${t.doc_type}: ${t.count}\n`;
  }

  output += '\n=== DOCUMENTOS PROCESADOS ===\n';
  const docs = db
    .prepare(
      `SELECT file_name, folder, doc_type, client, contract_number, value, currency,
              start_date, end_date, summary
       FROM documents WHERE status='processed' ORDER BY main_category, client_name, doc_type LIMIT ?`
    )
    .all(limit);

  let curFolder = '';
  for (const d of docs) {
    if (d.folder !== curFolder) { curFolder = d.folder; output += `\n--- 📁 ${curFolder} ---\n`; }
    output += `  📄 [${d.doc_type}] ${d.file_name} | ${d.client || 'N/A'} | ${d.value || 'N/A'} ${d.currency || ''} | ${d.start_date || '?'}-${d.end_date || '?'}\n`;
    if (d.summary) output += `     ${d.summary.slice(0, 150)}\n`;
  }

  return output;
}

// --- Category Overview con Vigencias ---

function classifyVigencia(endDate) {
  if (!endDate) return 'sin_fecha';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  if (isNaN(end.getTime())) return 'sin_fecha';

  const diffDays = Math.floor((end - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'vencido';
  if (diffDays <= 90) return 'proximo_vencer';
  return 'vigente';
}

function diasRestantes(endDate) {
  if (!endDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  if (isNaN(end.getTime())) return null;
  return Math.floor((end - today) / (1000 * 60 * 60 * 24));
}

export function getCategoryOverview(category) {
  const db = getDb();

  const totalDocs = db.prepare('SELECT COUNT(*) as c FROM documents WHERE main_category = ?').get(category).c;
  const processed = db.prepare("SELECT COUNT(*) as c FROM documents WHERE main_category = ? AND status = 'processed'").get(category).c;

  const clients = db.prepare(
    `SELECT client_name, COUNT(*) as doc_count FROM documents 
     WHERE main_category = ? AND client_name IS NOT NULL 
     GROUP BY client_name ORDER BY client_name`
  ).all(category);

  const docTypes = db.prepare(
    'SELECT doc_type, COUNT(*) as count FROM documents WHERE main_category = ? GROUP BY doc_type ORDER BY count DESC'
  ).all(category);

  // Documentos con fecha de vencimiento procesados
  const docsWithDates = db.prepare(
    `SELECT id, file_name, client_name, client, doc_type, contract_number, value, currency,
            start_date, end_date, summary, status
     FROM documents 
     WHERE main_category = ? AND status = 'processed' AND end_date IS NOT NULL AND end_date != ''
     ORDER BY end_date`
  ).all(category);

  let vigentes = 0, vencidos = 0, proximoVencer = 0, sinFecha = 0;
  const alertas = [];

  for (const doc of docsWithDates) {
    const estado = classifyVigencia(doc.end_date);
    const dias = diasRestantes(doc.end_date);
    if (estado === 'vigente') vigentes++;
    else if (estado === 'vencido') vencidos++;
    else if (estado === 'proximo_vencer') {
      proximoVencer++;
      alertas.push({ ...doc, dias_restantes: dias, vigencia_estado: 'proximo_vencer' });
    }
  }

  const totalSinFecha = db.prepare(
    `SELECT COUNT(*) as c FROM documents 
     WHERE main_category = ? AND status = 'processed' AND (end_date IS NULL OR end_date = '')`
  ).get(category).c;
  sinFecha = totalSinFecha;

  // Próximos a vencer (ordenados por urgencia)
  alertas.sort((a, b) => (a.dias_restantes || 0) - (b.dias_restantes || 0));

  // Vencidos recientes (últimos 10)
  const vencidosRecientes = docsWithDates
    .filter(d => classifyVigencia(d.end_date) === 'vencido')
    .map(d => ({ ...d, dias_vencido: Math.abs(diasRestantes(d.end_date) || 0), vigencia_estado: 'vencido' }))
    .sort((a, b) => a.dias_vencido - b.dias_vencido)
    .slice(0, 15);

  // Vigentes con más detalle
  const vigentesDetalle = docsWithDates
    .filter(d => classifyVigencia(d.end_date) === 'vigente')
    .map(d => ({ ...d, dias_restantes: diasRestantes(d.end_date), vigencia_estado: 'vigente' }))
    .sort((a, b) => (a.dias_restantes || 0) - (b.dias_restantes || 0))
    .slice(0, 20);

  // Resumen por cliente con vigencias
  const clientesResumen = clients.map(cl => {
    const clientDocs = db.prepare(
      `SELECT end_date, doc_type, value, currency FROM documents 
       WHERE main_category = ? AND client_name = ? AND status = 'processed'`
    ).all(category, cl.client_name);

    let clVigentes = 0, clVencidos = 0, clProximos = 0, clSinFecha = 0;
    for (const d of clientDocs) {
      const e = classifyVigencia(d.end_date);
      if (e === 'vigente') clVigentes++;
      else if (e === 'vencido') clVencidos++;
      else if (e === 'proximo_vencer') clProximos++;
      else clSinFecha++;
    }

    return {
      ...cl,
      vigentes: clVigentes,
      vencidos: clVencidos,
      proximo_vencer: clProximos,
      sin_fecha: clSinFecha,
    };
  });

  return {
    category,
    totalDocs,
    processed,
    clientCount: clients.length,
    docTypes,
    vigencia: { vigentes, vencidos, proximo_vencer: proximoVencer, sin_fecha: sinFecha },
    alertas,
    vencidosRecientes,
    vigentesDetalle,
    clientes: clientesResumen,
  };
}

export function getCategoryClientDetail(category, clientName) {
  const db = getDb();

  const docs = db.prepare(
    `SELECT id, file_name, folder, doc_type, client, contract_number, contract_type,
            start_date, end_date, value, currency, summary, status
     FROM documents WHERE main_category = ? AND client_name = ?
     ORDER BY doc_type, end_date DESC`
  ).all(category, clientName);

  const enriched = docs.map(d => ({
    ...d,
    vigencia_estado: classifyVigencia(d.end_date),
    dias_restantes: diasRestantes(d.end_date),
  }));

  const docTypes = {};
  let vigentes = 0, vencidos = 0, proximos = 0, sinFecha = 0;
  for (const d of enriched) {
    docTypes[d.doc_type] = (docTypes[d.doc_type] || 0) + 1;
    if (d.vigencia_estado === 'vigente') vigentes++;
    else if (d.vigencia_estado === 'vencido') vencidos++;
    else if (d.vigencia_estado === 'proximo_vencer') proximos++;
    else sinFecha++;
  }

  return {
    category,
    clientName,
    totalDocs: docs.length,
    docTypes: Object.entries(docTypes).map(([type, count]) => ({ doc_type: type, count })),
    vigencia: { vigentes, vencidos, proximo_vencer: proximos, sin_fecha: sinFecha },
    documents: enriched,
  };
}
