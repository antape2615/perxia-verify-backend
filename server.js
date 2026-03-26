import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from './database.js';
import {
  getStats,
  getAllDocuments,
  getDocumentById,
  searchDocuments,
  processDocument,
  registerDocuments,
  getDocsSummaryForChat,
  getFolderTree,
  getFolderDetail,
  processFolderDocuments,
  getCategoryBreakdown,
  getClientBreakdown,
  getCategoryOverview,
  getCategoryClientDetail,
} from './services/contractService.js';
import { chatAboutContract, globalChat } from './services/anthropicService.js';
import { classifyDocument } from './services/classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const CONTRACTS_PATH = path.resolve(process.env.CONTRACTS_PATH || path.join(__dirname, '..', 'Contratos'));

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, true);
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
getDb();

// --- Dashboard ---
app.get('/api/stats', (req, res) => {
  try { res.json(getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Pending Analysis ---
app.get('/api/pending-analysis', (req, res) => {
  try {
    const db = getDb();

    const pending = db.prepare(
      `SELECT id, file_name, folder, doc_type, main_category, client_name, status
       FROM documents WHERE status = 'pending' ORDER BY main_category, client_name, file_name`
    ).all();

    const noText = db.prepare(
      `SELECT id, file_name, folder, doc_type, main_category, client_name, status, summary
       FROM documents WHERE status = 'no_text' ORDER BY main_category, client_name, file_name`
    ).all();

    const errors = db.prepare(
      `SELECT id, file_name, folder, doc_type, main_category, client_name, status, summary
       FROM documents WHERE status = 'error' ORDER BY main_category, client_name, file_name`
    ).all();

    const passwordProtected = noText.filter(d =>
      d.summary && (/protegido|password|contraseña|encrypted/i.test(d.summary))
    );
    const noTextOther = noText.filter(d =>
      !d.summary || !(/protegido|password|contraseña|encrypted/i.test(d.summary))
    );

    // Also check processed docs that were marked as password-protected
    const processedPassword = db.prepare(
      `SELECT id, file_name, folder, doc_type, main_category, client_name, status, summary
       FROM documents WHERE status = 'processed'
       AND (summary LIKE '%protegido%' OR summary LIKE '%password%' OR summary LIKE '%contraseña%')
       ORDER BY main_category, client_name, file_name`
    ).all();

    const allPasswordDocs = [...passwordProtected, ...processedPassword];

    // Group pending by category
    const pendingByCategory = {};
    pending.forEach(d => {
      const cat = d.main_category || 'Sin categoría';
      if (!pendingByCategory[cat]) pendingByCategory[cat] = [];
      pendingByCategory[cat].push(d);
    });

    res.json({
      summary: {
        pending: pending.length,
        noText: noText.length,
        errors: errors.length,
        passwordProtected: allPasswordDocs.length,
        noTextOther: noTextOther.length,
      },
      pending,
      pendingByCategory,
      passwordProtected: allPasswordDocs,
      noTextOther,
      errors,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Download original PDF ---
app.get('/api/documents/:id/download', (req, res) => {
  try {
    const db = getDb();
    const doc = db.prepare('SELECT file_path, file_name FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

    const absolutePath = path.resolve(doc.file_path);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Archivo no encontrado en disco' });
    }
    res.download(absolutePath, doc.file_name);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Download ZIP of documents by filter ---
app.get('/api/documents/download-zip', (req, res) => {
  try {
    const db = getDb();
    const { status, ids } = req.query;

    let docs;
    if (ids) {
      const idList = ids.split(',').map(Number).filter(n => !isNaN(n));
      docs = db.prepare(`SELECT id, file_path, file_name, main_category, client_name FROM documents WHERE id IN (${idList.map(() => '?').join(',')})`).all(...idList);
    } else if (status) {
      docs = db.prepare('SELECT id, file_path, file_name, main_category, client_name FROM documents WHERE status = ?').all(status);
    } else {
      return res.status(400).json({ error: 'Se requiere parámetro status o ids' });
    }

    const existingDocs = docs.filter(d => fs.existsSync(path.resolve(d.file_path)));
    if (existingDocs.length === 0) return res.status(404).json({ error: 'No se encontraron archivos' });

    const tmpDir = path.join('/tmp', `perxia-zip-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    for (const d of existingDocs) {
      const subfolder = (d.client_name || d.main_category || 'otros').replace(/[/\\:*?"<>|]/g, '_');
      const destDir = path.join(tmpDir, subfolder);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(path.resolve(d.file_path), path.join(destDir, d.file_name));
    }

    const zipPath = `${tmpDir}.zip`;
    execSync(`cd "${tmpDir}" && zip -r "${zipPath}" . -q`);

    const label = status || 'seleccion';
    res.setHeader('Content-Disposition', `attachment; filename="documentos_${label}_${existingDocs.length}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const stream = fs.createReadStream(zipPath);
    stream.pipe(res);
    stream.on('end', () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(zipPath, { force: true });
    });
  } catch (e) {
    console.error('Error creando ZIP:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Export all documents ---
app.get('/api/export', (req, res) => {
  try {
    const db = getDb();
    const docs = db.prepare(
      `SELECT id, file_name, folder, doc_type, main_category, client_name,
              client, contract_number, contract_type, start_date, end_date,
              value, currency, terms, agreements, parties, obligations,
              penalties, guarantees, scope, payment_terms, renewal_clause,
              termination_clause, summary, status, processed_at
       FROM documents ORDER BY main_category, client_name, file_name`
    ).all();
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Category & Client breakdowns ---
app.get('/api/categories/:name', (req, res) => {
  try { res.json(getCategoryBreakdown(req.params.name)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clients/:name', (req, res) => {
  try {
    const { category } = req.query;
    res.json(getClientBreakdown(req.params.name, category));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Category Overview (vigencias, clientes, etc.) ---
app.get('/api/overview', (req, res) => {
  try {
    const db = getDb();
    const categories = db.prepare(
      `SELECT DISTINCT main_category FROM documents WHERE main_category IS NOT NULL ORDER BY main_category`
    ).all().map(r => r.main_category);
    const result = categories.map(cat => getCategoryOverview(cat));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/overview/:category', (req, res) => {
  try { res.json(getCategoryOverview(decodeURIComponent(req.params.category))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/overview/:category/client/:clientName', (req, res) => {
  try {
    res.json(getCategoryClientDetail(
      decodeURIComponent(req.params.category),
      decodeURIComponent(req.params.clientName)
    ));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Folder Hierarchy ---
app.get('/api/folders/tree', (req, res) => {
  try { res.json(getFolderTree()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/folders/:id', (req, res) => {
  try {
    const data = getFolderDetail(Number(req.params.id));
    if (!data) return res.status(404).json({ error: 'Carpeta no encontrada' });
    res.json(data);
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/folders', (req, res) => {
  try {
    const db = getDb();
    const folders = db.prepare(
      `SELECT f.*, 
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) as doc_count,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.status = 'processed') as processed_count
       FROM folders f ORDER BY f.path`
    ).all();
    res.json(folders);
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Process folder ---
let folderProcessing = {};

app.post('/api/folders/:id/process', async (req, res) => {
  const folderId = Number(req.params.id);
  if (folderProcessing[folderId]) {
    return res.json({ message: 'Ya se está procesando', progress: folderProcessing[folderId] });
  }
  folderProcessing[folderId] = { current: 0, total: 0, status: 'starting', currentFile: '' };
  res.json({ message: 'Procesamiento iniciado' });

  (async () => {
    try {
      await processFolderDocuments(folderId, (cur, total, file) => {
        folderProcessing[folderId] = { current: cur, total, status: 'processing', currentFile: file };
      });
      folderProcessing[folderId].status = 'completed';
    } catch (err) {
      folderProcessing[folderId].status = 'error';
      folderProcessing[folderId].error = err.message;
    }
    setTimeout(() => delete folderProcessing[folderId], 60000);
  })();
});

app.get('/api/folders/:id/process/status', (req, res) => {
  res.json(folderProcessing[Number(req.params.id)] || { status: 'idle' });
});

// --- Documents ---
app.get('/api/documents', (req, res) => {
  try {
    const { page = 1, limit = 20, client, status, docType, folder, folderId, mainCategory, clientName } = req.query;
    res.json(getAllDocuments(Number(page), Number(limit), { client, status, docType, folder, folderId, mainCategory, clientName }));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Keep /api/contracts as alias for backwards compat
app.get('/api/contracts', (req, res) => {
  try {
    const { page = 1, limit = 20, client, status, docType, folder, folderId, mainCategory, clientName } = req.query;
    res.json(getAllDocuments(Number(page), Number(limit), { client, status, docType, folder, folderId, mainCategory, clientName }));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/documents/:id', (req, res) => {
  try {
    const doc = getDocumentById(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
    res.json(doc);
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/contracts/:id', (req, res) => {
  try {
    const doc = getDocumentById(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
    res.json(doc);
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Search ---
app.get('/api/search', (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    res.json(searchDocuments(q));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Scanning & Processing ---
app.post('/api/scan', (req, res) => {
  try { res.json(registerDocuments(CONTRACTS_PATH)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

let processingActive = false;
let processingProgress = { current: 0, total: 0, totalPending: 0, status: 'idle', currentFile: '', currentFolder: '', processed: 0, errors: 0, skipped: 0 };

app.post('/api/process', async (req, res) => {
  if (processingActive) return res.json({ message: 'Ya hay un proceso en ejecución', progress: processingProgress });

  const { batchSize = 10, continuous = false } = req.body;
  processingActive = true;

  const db = getDb();
  const totalPending = db.prepare("SELECT COUNT(*) as c FROM documents WHERE status IN ('pending', 'error')").get().c;
  processingProgress = { current: 0, total: totalPending, totalPending, status: 'processing', currentFile: '', currentFolder: '', processed: 0, errors: 0, skipped: 0, startedAt: new Date().toISOString() };
  res.json({ message: `Procesando ${totalPending} documentos${continuous ? ' (modo continuo)' : ''}`, progress: processingProgress });

  (async () => {
    let globalCurrent = 0;
    while (true) {
      const batch = db.prepare("SELECT * FROM documents WHERE status IN ('pending', 'error') LIMIT ?").all(batchSize);
      if (batch.length === 0) break;

      for (const doc of batch) {
        if (!processingActive) break;
        processingProgress.currentFile = doc.file_name;
        processingProgress.currentFolder = doc.folder;
        try {
          const result = await processDocument(doc.file_path, doc.file_name, doc.folder);
          if (result.skipped) processingProgress.skipped++;
          else if (result.status === 'processed') processingProgress.processed++;
          else processingProgress.errors++;
        } catch (err) {
          console.error(`Error: ${doc.file_name}:`, err.message);
          processingProgress.errors++;
        }
        globalCurrent++;
        processingProgress.current = globalCurrent;
      }

      if (!continuous || !processingActive) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    processingProgress.status = 'completed';
    processingProgress.completedAt = new Date().toISOString();
    processingActive = false;
    console.log(`Procesamiento completado: ${processingProgress.processed} ok, ${processingProgress.errors} errores, ${processingProgress.skipped} omitidos`);
  })();
});

app.post('/api/reclassify', (req, res) => {
  try {
    const db = getDb();
    const all = db.prepare('SELECT id, file_name, folder FROM documents').all();
    const update = db.prepare('UPDATE documents SET doc_type = ? WHERE id = ?');
    const reclassify = db.transaction(() => {
      let changed = 0;
      for (const doc of all) {
        const newType = classifyDocument(doc.file_name, doc.folder);
        update.run(newType, doc.id);
        changed++;
      }
      return changed;
    });
    const changed = reclassify();
    const counts = db.prepare('SELECT doc_type, COUNT(*) as count FROM documents GROUP BY doc_type ORDER BY count DESC').all();
    res.json({ reclassified: changed, docTypes: counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/process/stop', (req, res) => {
  if (processingActive) {
    processingActive = false;
    processingProgress.status = 'stopped';
    res.json({ message: 'Procesamiento detenido' });
  } else {
    res.json({ message: 'No hay proceso activo' });
  }
});

app.get('/api/process/status', (req, res) => { res.json(processingProgress); });

app.post('/api/process/single/:id', async (req, res) => {
  try {
    const doc = getDocumentById(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
    res.json(await processDocument(doc.file_path, doc.file_name, doc.folder));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Chat ---
app.post('/api/chat/contract/:id', async (req, res) => {
  try {
    const doc = getDocumentById(Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
    const { message, history = [] } = req.body;
    const db = getDb();
    db.prepare('INSERT INTO chat_history (document_id, role, message) VALUES (?, ?, ?)').run(doc.id, 'user', message);
    const response = await chatAboutContract(doc, history, message);
    db.prepare('INSERT INTO chat_history (document_id, role, message) VALUES (?, ?, ?)').run(doc.id, 'assistant', response);
    res.json({ response });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat/global', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    const summary = getDocsSummaryForChat();
    res.json({ response: await globalChat(message, summary, history) });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chat/history/:docId', (req, res) => {
  try {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM chat_history WHERE document_id = ? ORDER BY created_at').all(Number(req.params.docId)));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Static ---
const frontendPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendPath));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PERXIA Verify → http://localhost:${PORT}`);
  console.log(`Documentos: ${CONTRACTS_PATH}`);
  console.log(`Modelo: Azure OpenAI (${process.env.AZURE_OPENAI_DEPLOYMENT})`);
});

process.on('SIGINT', () => { closeDb(); process.exit(0); });
