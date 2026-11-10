// Request generations keep completed outputs tied to the inputs that produced them.
export function createRunState() {
  let generation = 0;
  let result = null;
  let fresh = false;
  return {
    get result() { return result; },
    begin() { fresh = false; return ++generation; },
    invalidate() { generation++; fresh = false; },
    isCurrent(id) { return id === generation; },
    isFresh() { return fresh; },
    complete(id, next) {
      if (id !== generation) return false;
      result = structuredClone(next);
      fresh = true;
      return true;
    },
  };
}

export function sampleSlug(filename) {
  return filename.replace(/\.ab1$/i, '').replace(/[^\w.-]+/g, '_');
}

async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}

export async function createAnalysisExport(result, parseFasta) {
  const { request, outputs } = result;
  const inputs = {};
  for (const [direction, file] of Object.entries(request.files)) {
    inputs[direction] = { filename: request.filenames[direction], sha256: await sha256(await file.arrayBuffer()) };
  }
  const sequences = {};
  for (const [key, report] of Object.entries(outputs)) {
    const { seq } = parseFasta(report);
    sequences[key] = { length: seq.length, sequence_sha256: await sha256(new TextEncoder().encode(seq)) };
  }
  return {
    schema_version: 1,
    inputs,
    parameters: request.settings,
    primers: request.primers,
    outputs: sequences,
    warnings: result.warnings,
    server_provenance: result.analysis || { available: false, reason: 'The API did not provide software or runtime provenance.' },
  };
}
