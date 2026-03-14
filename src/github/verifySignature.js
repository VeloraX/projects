const textEncoder = new TextEncoder();

export async function verifyGitHubSignature({ secret, payloadBuffer, signatureHeader }) {
  if (!secret) {
    return {
      ok: true,
      verified: false,
      reason: 'webhook secret not configured'
    };
  }

  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return {
      ok: false,
      verified: false,
      reason: 'missing x-hub-signature-256 header'
    };
  }

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      {
        name: 'HMAC',
        hash: 'SHA-256'
      },
      false,
      ['sign']
    );
    const computedBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, toUint8Array(payloadBuffer)));
    const expectedSignature = `sha256=${bytesToHex(computedBytes)}`;
    const matches = constantTimeEqual(
      textEncoder.encode(expectedSignature),
      textEncoder.encode(signatureHeader)
    );

    return {
      ok: matches,
      verified: true,
      reason: matches ? 'signature verified' : 'signature mismatch'
    };
  } catch (error) {
    return {
      ok: false,
      verified: false,
      reason: `signature verification error: ${error.message}`
    };
  }
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;

  for (let index = 0; index < left.length; index += 1) {
    result |= left[index] ^ right[index];
  }

  return result === 0;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  return new Uint8Array(value);
}
