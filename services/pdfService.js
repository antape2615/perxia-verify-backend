import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';

export async function extractTextFromPdf(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Archivo no encontrado: ${absolutePath}`);
  }

  const buffer = fs.readFileSync(absolutePath);
  const data = await pdfParse(buffer);

  return {
    text: data.text,
    numPages: data.numpages,
    info: data.info,
  };
}

export async function extractImagesFromPdf(filePath, maxPages = 5) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Archivo no encontrado: ${absolutePath}`);
  }

  const { pdf } = await import('pdf-to-img');
  const buffer = fs.readFileSync(absolutePath);

  const images = [];
  let pageNum = 0;

  const document = await pdf(buffer, { scale: 2.0 });
  for await (const page of document) {
    if (pageNum >= maxPages) break;
    const base64 = Buffer.from(page).toString('base64');
    images.push({
      page: pageNum + 1,
      base64,
      mimeType: 'image/png',
    });
    pageNum++;
  }

  return images;
}

export function scanDocuments(contractsPath) {
  const documents = [];

  function walk(dir, relativePath = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relativePath, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        documents.push({
          fullPath,
          relativePath: relPath,
          fileName: entry.name,
          folder: relativePath || 'root',
          size: fs.statSync(fullPath).size,
        });
      }
    }
  }

  walk(contractsPath);
  return documents;
}
