import { AzureOpenAI } from 'openai';

let client;

function getClient() {
  if (!client) {
    client = new AzureOpenAI({
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    });
  }
  return client;
}

const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'openAIJack';

async function callWithRetry(fn, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error?.status || error?.statusCode || error?.code;
      const isRetryable = status === 429 || status === 529 || status === 500 || status === 503 || error?.code === 'ECONNRESET';
      if (!isRetryable || attempt === maxRetries) throw error;

      const baseDelay = Math.min(2000 * Math.pow(2, attempt), 60000);
      const delay = baseDelay + Math.random() * 1000;
      console.log(`[Retry ${attempt + 1}/${maxRetries}] Error ${status}, esperando ${Math.round(delay / 1000)}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const EXTRACTION_PROMPT = `Eres un experto analista legal y contractual. Analiza el documento proporcionado y extrae TODA la información relevante.

Responde EXCLUSIVAMENTE en formato JSON válido con la siguiente estructura (usa null si no encuentras la información):

{
  "client": "Nombre del cliente o empresa contratante",
  "contract_number": "Número o código del contrato/documento",
  "contract_type": "Tipo de documento (prestación de servicios, suministro, consultoría, marco, otrosí, póliza, recibo, etc.)",
  "start_date": "Fecha de inicio (formato YYYY-MM-DD si es posible)",
  "end_date": "Fecha de fin o vencimiento (formato YYYY-MM-DD si es posible)",
  "value": "Valor total (número)",
  "currency": "Moneda (COP, USD, etc.)",
  "terms": "Términos principales resumidos en detalle",
  "agreements": "Acuerdos clave entre las partes, detallados",
  "parties": "Partes involucradas (nombres completos, NIT/cédula y roles)",
  "obligations": "Obligaciones principales de cada parte, detalladas",
  "penalties": "Penalidades o cláusulas de incumplimiento",
  "guarantees": "Garantías o pólizas asociadas",
  "scope": "Objeto y alcance del contrato/documento",
  "payment_terms": "Condiciones y forma de pago",
  "renewal_clause": "Cláusulas de renovación o prórroga",
  "termination_clause": "Condiciones de terminación anticipada",
  "summary": "Resumen ejecutivo MUY COMPLETO en 4-6 párrafos que cubra: objeto, condiciones, plazos, valores, obligaciones, garantías, y cualquier aspecto relevante"
}

IMPORTANTE: 
- Responde SOLO con el JSON, sin texto adicional ni markdown.
- Extrae toda la información visible, incluyendo sellos, firmas, tablas, números.
- Los valores monetarios deben ser exactos.
- Las fechas deben ser lo más precisas posible.
- Sé extremadamente detallado.`;

// --- Análisis con texto ---
export async function analyzeContract(text, fileName, folderContext = '') {
  const ai = getClient();
  const truncatedText = text.slice(0, 120000);
  const contextInfo = folderContext ? `\nContexto de carpeta: ${folderContext}\n` : '';

  return callWithRetry(async () => {
    const response = await ai.chat.completions.create({
      model: DEPLOYMENT,
      max_tokens: 4096,
      temperature: 0.1,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: `${contextInfo}Nombre del archivo: ${fileName}\n\nTexto del documento:\n${truncatedText}` },
      ],
    });
    return parseJsonResponse(response.choices[0]?.message?.content || '');
  });
}

// --- Análisis con imágenes (visión) ---
export async function analyzeContractVision(images, fileName, folderContext = '') {
  const ai = getClient();
  const contextInfo = folderContext ? `Contexto de carpeta: ${folderContext}\n` : '';

  const imageContent = images.map((img) => ({
    type: 'image_url',
    image_url: {
      url: `data:${img.mimeType};base64,${img.base64}`,
      detail: 'high',
    },
  }));

  return callWithRetry(async () => {
    const response = await ai.chat.completions.create({
      model: DEPLOYMENT,
      max_tokens: 4096,
      temperature: 0.1,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${contextInfo}Nombre del archivo: ${fileName}\n\nAnaliza las siguientes ${images.length} página(s) del documento PDF y extrae toda la información:`,
            },
            ...imageContent,
          ],
        },
      ],
    });
    return parseJsonResponse(response.choices[0]?.message?.content || '');
  });
}

// --- Análisis mixto (texto + imágenes si el texto es pobre) ---
export async function analyzeContractHybrid(text, images, fileName, folderContext = '') {
  const ai = getClient();
  const contextInfo = folderContext ? `Contexto de carpeta: ${folderContext}\n` : '';
  const truncatedText = (text || '').slice(0, 60000);

  const content = [
    {
      type: 'text',
      text: `${contextInfo}Nombre del archivo: ${fileName}\n\nTexto extraído del documento (puede estar incompleto):\n${truncatedText}\n\nA continuación las imágenes de las páginas del PDF para complementar:`,
    },
    ...images.map((img) => ({
      type: 'image_url',
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
        detail: 'high',
      },
    })),
  ];

  return callWithRetry(async () => {
    const response = await ai.chat.completions.create({
      model: DEPLOYMENT,
      max_tokens: 4096,
      temperature: 0.1,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content },
      ],
    });
    return parseJsonResponse(response.choices[0]?.message?.content || '');
  });
}

function parseJsonResponse(content) {
  try {
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return {
      summary: content, client: null, contract_number: null, contract_type: null,
      start_date: null, end_date: null, value: null, currency: null,
      terms: null, agreements: null, parties: null, obligations: null,
      penalties: null, guarantees: null, scope: null, payment_terms: null,
      renewal_clause: null, termination_clause: null,
    };
  }
}

// --- Folder summary ---
export async function analyzeFolderSummary(folderPath, documentsInfo) {
  const ai = getClient();
  const docsText = documentsInfo
    .map((d, i) =>
      `[Doc ${i + 1}] ${d.file_name}\nCliente: ${d.client || 'N/A'}\nContrato: ${d.contract_number || 'N/A'}\nTipo: ${d.contract_type || 'N/A'}\nValor: ${d.value || 'N/A'} ${d.currency || ''}\nVigencia: ${d.start_date || '?'} - ${d.end_date || '?'}\nResumen: ${(d.summary || '').slice(0, 500)}`)
    .join('\n\n---\n\n');

  return callWithRetry(async () => {
    const response = await ai.chat.completions.create({
      model: DEPLOYMENT,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Eres un experto analista legal. Genera resúmenes ejecutivos de paquetes documentales.' },
        { role: 'user', content: `Analiza los documentos de la carpeta "${folderPath}" y genera un resumen ejecutivo.\n\nIncluye: resumen general, clientes, valores, vigencias, documentos clave vs soporte, observaciones.\n\nDocumentos:\n${docsText}` },
      ],
    });
    return response.choices[0]?.message?.content || '';
  });
}

// --- Chat ---
export async function chatAboutContract(contractData, chatHistory, userMessage) {
  const ai = getClient();

  const systemPrompt = `Eres un asistente legal experto que responde preguntas sobre documentos contractuales.
Información del documento:

Nombre: ${contractData.file_name}
Carpeta: ${contractData.folder || 'N/A'}
Cliente: ${contractData.client || 'No especificado'}
Número: ${contractData.contract_number || 'No especificado'}
Tipo: ${contractData.contract_type || 'No especificado'}
Fecha inicio: ${contractData.start_date || 'No especificada'}
Fecha fin: ${contractData.end_date || 'No especificada'}
Valor: ${contractData.value || 'No especificado'} ${contractData.currency || ''}
Términos: ${contractData.terms || 'No especificados'}
Acuerdos: ${contractData.agreements || 'No especificados'}
Partes: ${contractData.parties || 'No especificadas'}
Obligaciones: ${contractData.obligations || 'No especificadas'}
Penalidades: ${contractData.penalties || 'No especificadas'}
Resumen: ${contractData.summary || 'No disponible'}
Texto original: ${(contractData.raw_text || '').slice(0, 30000)}
Análisis IA: ${contractData.ai_analysis || 'No disponible'}

Responde de forma clara, precisa y en español.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.map((m) => ({ role: m.role, content: m.message })),
    { role: 'user', content: userMessage },
  ];

  return callWithRetry(async () => {
    const response = await ai.chat.completions.create({
      model: DEPLOYMENT, max_tokens: 4096, temperature: 0.3, messages,
    });
    return response.choices[0]?.message?.content || '';
  });
}

export async function globalChat(query, contractsSummary, chatHistory = []) {
  const ai = getClient();

  const systemPrompt = `Eres un asistente experto en gestión documental para PERXIA. Portafolio disponible:\n\n${contractsSummary}\n\nResponde siempre en español de forma clara y profesional.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.map((m) => ({ role: m.role, content: m.message })),
    { role: 'user', content: query },
  ];

  return callWithRetry(async () => {
    const response = await ai.chat.completions.create({
      model: DEPLOYMENT, max_tokens: 4096, temperature: 0.3, messages,
    });
    return response.choices[0]?.message?.content || '';
  });
}
