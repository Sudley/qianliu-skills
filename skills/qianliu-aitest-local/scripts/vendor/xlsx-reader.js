'use strict';

const fs = require('fs');
const zlib = require('zlib');

/**
 * Lightweight .xlsx reader using only Node.js built-ins.
 * Parses the first sheet of an xlsx file and returns an array of row objects.
 *
 * Usage:
 *   const { readXlsx } = require('./xlsx-reader');
 *   const rows = readXlsx('path/to/file.xlsx');
 *   // rows = [{ Header1: 'val1', Header2: 'val2', ... }, ...]
 */

// ─── ZIP parsing ────────────────────────────────────────────────────────────

function parseZip(buf) {
  // Find End of Central Directory record (EOCD)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Invalid ZIP: EOCD not found');

  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  const centralDirEntries = buf.readUInt16LE(eocdOffset + 10);

  const entries = {};
  let offset = centralDirOffset;

  for (let i = 0; i < centralDirEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;

    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const compressionMethod = buf.readUInt16LE(offset + 10);

    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');

    // Read local file header to find actual data offset
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

    const compressedData = buf.slice(dataOffset, dataOffset + compressedSize);

    let data;
    if (compressionMethod === 0) {
      // Stored (no compression)
      data = compressedData;
    } else if (compressionMethod === 8) {
      // Deflated
      try {
        data = zlib.inflateRawSync(compressedData);
      } catch (e) {
        // Skip entries that fail to decompress
        data = Buffer.alloc(0);
      }
    } else {
      data = Buffer.alloc(0);
    }

    entries[name] = data;
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// ─── XML helpers ────────────────────────────────────────────────────────────

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function extractTagContent(xml, tagName) {
  const results = [];
  const openTag = '<' + tagName;
  const closeTag = '</' + tagName + '>';
  let idx = 0;

  while (true) {
    const start = xml.indexOf(openTag, idx);
    if (start === -1) break;

    // Find the end of the opening tag
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd === -1) break;

    // Check if self-closing
    if (xml[tagEnd - 1] === '/') {
      idx = tagEnd + 1;
      continue;
    }

    const contentStart = tagEnd + 1;
    const end = xml.indexOf(closeTag, contentStart);
    if (end === -1) break;

    results.push(xml.substring(contentStart, end));
    idx = end + closeTag.length;
  }

  return results;
}

function getAttr(xml, startIdx, attrName) {
  const tagEnd = xml.indexOf('>', startIdx);
  const tagStr = xml.substring(startIdx, tagEnd);
  const regex = new RegExp(attrName + '="([^"]*)"');
  const match = tagStr.match(regex);
  return match ? match[1] : null;
}

// ─── Shared Strings parsing ────────────────────────────────────────────────

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siParts = extractTagContent(xml, 'si');

  for (const si of siParts) {
    // Each <si> can contain one <t> or multiple <r><t>...</t></r> elements
    const tParts = extractTagContent(si, 't');
    strings.push(tParts.map(t => decodeXmlEntities(t)).join(''));
  }

  return strings;
}

// ─── Worksheet parsing ─────────────────────────────────────────────────────

function colRefToIndex(ref) {
  // Convert column reference like 'A', 'B', 'AA' to 0-based index
  let idx = 0;
  for (let i = 0; i < ref.length; i++) {
    idx = idx * 26 + (ref.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function parseCellRef(ref) {
  // Parse cell reference like 'A1', 'AB12' into { col: 0-based index, row: 1-based number }
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  return {
    col: colRefToIndex(match[1]),
    row: parseInt(match[2], 10)
  };
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowParts = extractTagContent(xml, 'row');

  for (const rowXml of rowParts) {
    const cells = {};

    // Find all <c> elements within this row
    let idx = 0;
    while (true) {
      const cStart = rowXml.indexOf('<c ', idx);
      if (cStart === -1) break;

      const ref = getAttr(rowXml, cStart, 'r');
      const type = getAttr(rowXml, cStart, 't');

      // Find the end of this <c> element
      const cClose = rowXml.indexOf('</c>', cStart);
      const cSelfClose = rowXml.indexOf('/>', cStart);

      let cellContent = '';
      let nextIdx;

      if (cClose !== -1 && (cSelfClose === -1 || cClose < cSelfClose)) {
        // Has content between <c ...> and </c>
        const cTagEnd = rowXml.indexOf('>', cStart);
        const cellXml = rowXml.substring(cTagEnd + 1, cClose);

        // Extract <v> value
        const vParts = extractTagContent(cellXml, 'v');
        if (vParts.length > 0) {
          const rawValue = vParts[0];
          if (type === 's') {
            // Shared string reference
            const ssIdx = parseInt(rawValue, 10);
            cellContent = sharedStrings[ssIdx] || '';
          } else if (type === 'inlineStr') {
            // Inline string
            const tParts = extractTagContent(cellXml, 't');
            cellContent = tParts.map(t => decodeXmlEntities(t)).join('');
          } else {
            cellContent = decodeXmlEntities(rawValue);
          }
        } else {
          // Check for inline string (<is><t>...</t></is>)
          const isParts = extractTagContent(cellXml, 'is');
          if (isParts.length > 0) {
            const tParts = extractTagContent(isParts[0], 't');
            cellContent = tParts.map(t => decodeXmlEntities(t)).join('');
          }
        }

        nextIdx = cClose + 4; // skip </c>
      } else if (cSelfClose !== -1) {
        // Self-closing <c ... />
        nextIdx = cSelfClose + 2;
      } else {
        break;
      }

      if (ref) {
        const parsed = parseCellRef(ref);
        if (parsed) {
          cells[parsed.col] = cellContent;
        }
      }

      idx = nextIdx;
    }

    rows.push(cells);
  }

  return rows;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

function readXlsx(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = parseZip(buf);

  // Find shared strings
  const ssKey = Object.keys(entries).find(k => k.match(/xl\/sharedStrings\.xml$/i));
  const sharedStrings = ssKey ? parseSharedStrings(entries[ssKey].toString('utf8')) : [];

  // Find first worksheet
  const sheetKey = Object.keys(entries).find(k => k.match(/xl\/worksheets\/sheet1\.xml$/i));
  if (!sheetKey) {
    throw new Error('No worksheet found in xlsx file');
  }

  const sheetXml = entries[sheetKey].toString('utf8');
  const rawRows = parseSheet(sheetXml, sharedStrings);

  if (rawRows.length === 0) return [];

  // First row is headers
  const headerRow = rawRows[0];
  const maxCol = Math.max(...Object.keys(headerRow).map(Number));
  const headers = [];
  for (let i = 0; i <= maxCol; i++) {
    headers.push(headerRow[i] || `col_${i}`);
  }

  // Remaining rows become objects
  const result = [];
  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    const obj = {};
    let hasValue = false;

    for (let c = 0; c < headers.length; c++) {
      const val = row[c] || '';
      obj[headers[c]] = val;
      if (val) hasValue = true;
    }

    // Skip completely empty rows
    if (hasValue) {
      result.push(obj);
    }
  }

  return result;
}

module.exports = { readXlsx };
