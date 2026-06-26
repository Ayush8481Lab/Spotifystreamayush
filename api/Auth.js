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

function getSecretBytes(data) {
  const mappedData = data.map((value, index) => value ^ ((index % 33) + 9));
  const secretString = mappedData.join("");
  return new TextEncoder().encode(secretString); 
}

async function generateTOTP(secretBytes, timestampMs) {
  const timeStep = Math.floor((timestampMs / 1000) / 30);
  const timeBuffer = new ArrayBuffer(8);
  const timeView = new DataView(timeBuffer);
  timeView.setUint32(0, Math.floor(timeStep / 4294967296), false); 
  timeView.setUint32(4, timeStep % 4294967296, false);            

  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, timeBuffer);
  const hmacArray = new Uint8Array(signature);
  
  const offset = hmacArray[hmacArray.length - 1] & 0x0f;
  const code = (((hmacArray[offset] & 0x7f) << 24) | ((hmacArray[offset + 1] & 0xff) << 16) | ((hmacArray[offset + 2] & 0xff) << 8) | (hmacArray[offset + 3] & 0xff)) >>> 0; 
  return (code % 1000000).toString().padStart(6, '0');
}

async function fetchSecretsFromGitHub() {
  const response = await fetch(SECRETS_URL, { headers: { 'User-Agent': userAgent() } });
  if (!response.ok) throw new Error("Failed to fetch secrets");
  return await response.json();
}

async function updateTOTPSecrets() {
  const now = Date.now();
  if (currentTotpSecretBytes && (now - lastFetchTime < FETCH_INTERVAL)) return; 

  try {
    const secrets = await fetchSecretsFromGitHub();
    const newestVersion = Math.max(...Object.keys(secrets).map(Number)).toString();
    
    if (newestVersion && newestVersion !== currentTotpVersion) {
      currentTotpSecretBytes = getSecretBytes(secrets[newestVersion]);
      currentTotpVersion = newestVersion;
      lastFetchTime = now;
    }
  } catch (error) {
    if (!currentTotpSecretBytes) {
      const fallbackData = [99, 111, 47, 88, 49, 56, 118, 65, 52, 67, 50, 104, 117, 101, 55, 94, 95, 75, 94, 49, 69, 36, 85, 64, 74, 60];
      currentTotpSecretBytes = getSecretBytes(fallbackData);
      currentTotpVersion = "19";
    }
  }
}

async function getServerTime() {
  try {
    const response = await fetch("https://open.spotify.com/api/server-time", {
      headers: { 'User-Agent': userAgent(), 'Origin': 'https://open.spotify.com/', 'Referer': 'https://open.spotify.com/' },
    });
    const data = await response.json();
    const time = Number(data.serverTime);
    return isNaN(time) ? Date.now() : time * 1000;
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
    // 2. PARALLEL FETCHING
    const [serverTime] = await Promise.all([
      getServerTime(),
      updateTOTPSecrets()
    ]);

    // 3. GENERATE PAYLOAD
    const localTime = Date.now();
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

    // 5. EXTRACT AND MODIFY THE RESPONSE
    const tokenData = await tokenResponse.json();
    tokenData._notes = "Developed By Ayush@8481";

    // 6. DYNAMIC CACHE CALCULATION (Exactly 10 mins before expiry)
    const nowMs = Date.now();
    // Default to 1 hour (3600000ms) ahead if Spotify fails to return the timestamp for some reason
    const expirationMs = tokenData.accessTokenExpirationTimestampMs || (nowMs + 3600000); 
    const remainingTimeMs = expirationMs - nowMs;
    
    // Subtract 10 minutes (600,000 milliseconds) from remaining time
    let cacheDurationSeconds = Math.floor((remainingTimeMs - 600000) / 1000);
    
    // Safety check: if somehow it's expiring very soon, don't cache it (set to 0)
    cacheDurationSeconds = Math.max(0, cacheDurationSeconds);

    // 7. RETURN DYNAMICALLY CACHED RESPONSE
    return new Response(JSON.stringify(tokenData, null, 2), {
      status: tokenResponse.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
        // Set the dynamically calculated cache time!
        'Cache-Control': cacheDurationSeconds > 0 
            ? `public, s-maxage=${cacheDurationSeconds}, stale-while-revalidate=30`
            : 'no-store', // Tell Vercel not to cache if the token is dangerously close to expiring
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), { 
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
}
