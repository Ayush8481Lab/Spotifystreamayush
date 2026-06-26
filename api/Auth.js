// Force Vercel to use the Edge Runtime for maximum performance
export const config = {
  runtime: 'edge',
};

const SECRETS_URL = "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json";
const FETCH_INTERVAL = 60 * 60 * 1000; // 1 hour

// Global variables to store the current TOTP configuration
let currentTotpSecretBytes = null;
let currentTotpVersion = null;
let lastFetchTime = 0;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function userAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
}

// 1. Emulate the original string-to-buffer conversion without Node.js Buffer
function getSecretBytes(data) {
  const mappedData = data.map((value, index) => value ^ ((index % 33) + 9));
  const secretString = mappedData.join("");
  // TextEncoder replaces Buffer.from(..., "utf8") perfectly in the Edge Runtime
  return new TextEncoder().encode(secretString); 
}

// 2. Pure Web Crypto TOTP implementation (Completely replaces otpauth)
async function generateTOTP(secretBytes, timestampMs) {
  // Calculate the time step based on 30 second period
  const timeStep = Math.floor((timestampMs / 1000) / 30);
  
  // Convert time step to 8-byte buffer
  const timeBuffer = new ArrayBuffer(8);
  const timeView = new DataView(timeBuffer);
  timeView.setUint32(0, Math.floor(timeStep / 4294967296), false); // High 32 bits
  timeView.setUint32(4, timeStep % 4294967296, false);            // Low 32 bits

  // Generate HMAC-SHA1 signature using Web Crypto API
  const key = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, timeBuffer);
  const hmacArray = new Uint8Array(signature);
  
  // Truncate to get 6-digit code (RFC 6238 standard)
  const offset = hmacArray[hmacArray.length - 1] & 0x0f;
  const code = (
      ((hmacArray[offset] & 0x7f) << 24) |
      ((hmacArray[offset + 1] & 0xff) << 16) |
      ((hmacArray[offset + 2] & 0xff) << 8) |
      (hmacArray[offset + 3] & 0xff)
  ) >>> 0; // unsigned 32-bit

  // Return exactly 6 digits, padded with leading zeros if necessary
  return (code % 1000000).toString().padStart(6, '0');
}

async function fetchSecretsFromGitHub() {
  const response = await fetch(SECRETS_URL, {
    headers: { 'User-Agent': userAgent() }
  });
  if (!response.ok) throw new Error("Failed to fetch secrets");
  return await response.json();
}

async function updateTOTPSecrets() {
  const now = Date.now();
  if (currentTotpSecretBytes && (now - lastFetchTime < FETCH_INTERVAL)) {
    return; // Still valid, no need to fetch
  }

  try {
    const secrets = await fetchSecretsFromGitHub();
    const versions = Object.keys(secrets).map(Number);
    const newestVersion = Math.max(...versions).toString();
    
    if (newestVersion && newestVersion !== currentTotpVersion) {
      currentTotpSecretBytes = getSecretBytes(secrets[newestVersion]);
      currentTotpVersion = newestVersion;
      lastFetchTime = now;
    }
  } catch (error) {
    if (!currentTotpSecretBytes) {
      // Fallback secret if everything fails
      const fallbackData = [99, 111, 47, 88, 49, 56, 118, 65, 52, 67, 50, 104, 117, 101, 55, 94, 95, 75, 94, 49, 69, 36, 85, 64, 74, 60];
      currentTotpSecretBytes = getSecretBytes(fallbackData);
      currentTotpVersion = "19";
    }
  }
}

async function getServerTime() {
  try {
    const response = await fetch("https://open.spotify.com/api/server-time", {
      headers: {
        'User-Agent': userAgent(),
        'Origin': 'https://open.spotify.com/',
        'Referer': 'https://open.spotify.com/'
      },
    });
    const data = await response.json();
    const time = Number(data.serverTime);
    if (isNaN(time)) throw new Error("Invalid server time");
    return time * 1000;
  } catch {
    return Date.now();
  }
}

export default async function handler(req) {
  // 1. INSTANT PREFLIGHT CORS CHECK
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' },
    });
  }

  try {
    // 2. LAZY INITIALIZE / UPDATE TOTP
    await updateTOTPSecrets();

    // 3. GENERATE PAYLOAD
    const localTime = Date.now();
    const serverTime = await getServerTime();
    
    // Asynchronously generate the required TOTP codes using the pure JS implementation
    const localTotp = await generateTOTP(currentTotpSecretBytes, localTime);
    const serverTotp = await generateTOTP(currentTotpSecretBytes, serverTime);
    
    const payload = new URLSearchParams({
      reason: "init",
      productType: "mobile-web-player",
      totp: localTotp,
      totpVer: currentTotpVersion || "19",
      totpServer: serverTotp
    });

    // 4. FETCH SPOTIFY TOKEN
    const tokenUrl = `https://open.spotify.com/api/token?${payload.toString()}`;
    const tokenResponse = await fetch(tokenUrl, {
      headers: {
        'User-Agent': userAgent(),
        'Origin': 'https://open.spotify.com/',
        'Referer': 'https://open.spotify.com/'
      }
    });

    // 5. EXTRACT EXACT RAW TEXT RESPONSE
    const rawResponseBody = await tokenResponse.text();

    // 6. RETURN EXACT SPOTIFY RESPONSE WITH 45 MIN CACHING
    return new Response(rawResponseBody, {
      status: tokenResponse.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
        'Cache-Control': 'public, s-maxage=2700, stale-while-revalidate=60',
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), { 
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
}
