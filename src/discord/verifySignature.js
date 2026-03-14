const textEncoder = new TextEncoder();

export async function verifyDiscordSignature({ publicKey, signatureHeader, timestampHeader, payloadBuffer }) {
  if (!isHexString(publicKey, 64)) {
    return {
      ok: false,
      verified: false,
      reason: 'DISCORD_PUBLIC_KEY must be a 32-byte hex string'
    };
  }

  if (!isHexString(signatureHeader, 128)) {
    return {
      ok: false,
      verified: false,
      reason: 'missing or invalid x-signature-ed25519 header'
    };
  }

  if (typeof timestampHeader !== 'string' || timestampHeader.trim().length === 0) {
    return {
      ok: false,
      verified: false,
      reason: 'missing x-signature-timestamp header'
    };
  }

  try {
    const publicKeyBytes = hexToBytes(publicKey);
    const signatureBytes = hexToBytes(signatureHeader);
    const message = concatBytes(textEncoder.encode(timestampHeader), toUint8Array(payloadBuffer));
    const key = await crypto.subtle.importKey('raw', publicKeyBytes, 'Ed25519', false, ['verify']);
    const verified = await crypto.subtle.verify('Ed25519', key, signatureBytes, message);

    return {
      ok: verified,
      verified,
      reason: verified ? 'signature verified' : 'signature mismatch'
    };
  } catch (error) {
    return {
      ok: false,
      verified: false,
      reason: `signature verification error: ${error.message}`
    };
  }
}

function isHexString(value, expectedLength) {
  return typeof value === 'string' && value.length === expectedLength && /^[0-9a-f]+$/i.test(value);
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }

  return bytes;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  return new Uint8Array(value);
}

function concatBytes(left, right) {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}
