const DOC_TYPES = [
  { type: 'Póliza', patterns: [/p[oó]liza/i, /poliza/i] },
  { type: 'Recibo de Pago', patterns: [/recibo/i, /recibocaja/i] },
  { type: 'Soporte de Pago', patterns: [/soporte.*pago/i, /r\s*pago/i, /pago/i] },
  { type: 'Otrosí', patterns: [/otro\s*s[ií]/i, /otrosi/i] },
  { type: 'Adenda', patterns: [/adenda/i, /addendum/i] },
  { type: 'Anexo', patterns: [/anexo/i, /annex/i] },
  { type: 'Acuerdo', patterns: [/acuerdo/i, /confidencialidad/i] },
  { type: 'Oferta Mercantil', patterns: [/oferta/i, /propuesta/i] },
  { type: 'Carta', patterns: [/carta/i] },
  { type: 'Certificado', patterns: [/certificad/i, /certificaci[oó]n/i] },
  { type: 'Orden de Compra', patterns: [/orden.*compra/i, /orden\b/i] },
  { type: 'Slip / Cotización', patterns: [/slip/i, /cotizaci[oó]n/i] },
  { type: 'Factura', patterns: [/factura/i, /invoice/i] },
  { type: 'Acta', patterns: [/\bacta\b/i] },
  { type: 'Licitación', patterns: [/licitaci[oó]n/i] },
  { type: 'Presentación', patterns: [/presentaci[oó]n/i] },
  { type: 'Informe / Resumen', patterns: [/informe/i, /resumen/i, /summary/i] },
  { type: 'Contrato', patterns: [/contrato/i, /contract/i] },
];

export function classifyDocument(fileName, folderPath = '') {
  // PRIMERO: clasificar SOLO por nombre de archivo (tiene prioridad absoluta)
  for (const { type, patterns } of DOC_TYPES) {
    for (const pattern of patterns) {
      if (pattern.test(fileName)) {
        return type;
      }
    }
  }

  // SEGUNDO: si el nombre no dice nada, mirar la carpeta inmediata (no toda la ruta)
  const immediateFolder = folderPath.split('/').pop() || '';
  for (const { type, patterns } of DOC_TYPES) {
    for (const pattern of patterns) {
      if (pattern.test(immediateFolder)) {
        return type;
      }
    }
  }

  return 'Otro';
}

export function getMainCategory(folderPath) {
  if (!folderPath) return 'Sin categoría';
  return folderPath.split('/')[0] || 'Sin categoría';
}

export function getClientFromFolder(folderPath) {
  if (!folderPath) return null;
  const parts = folderPath.split('/');
  return parts.length >= 2 ? parts[1] : null;
}

export { DOC_TYPES };
