import * as OTPAuth from "otpauth";

// Force Vercel to use the Edge Runtime for maximum performance
export const config = {
  runtime: 'edge',
};

const SECRETS_URL = "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json";
const FETCH_INTERVAL = 60 * 60 * 1000; // 1 hour

// Global variables to store the current TOTP configuration
let currentTotp = null;
let currentTotpVersion = null;
let lastFetchTime = 0;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Edge-compatible string-to-hex converter
function stringToHex(str) {
  let hex = "";
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16);
  }
  return hex;
}

function createTotpSecret(data) {
  const mappedData = data.map((value, index) => value ^ ((index % 33) + 9));
  const hexData = stringToHex(mappedData.join(""));
  return OTPAuth.Secret.fromHex(hexData);
}

function userAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
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
  if (currentTotp && (now - lastFetchTime < FETCH_INTERVAL)) {
    return; // Still valid, no need to fetch
  }

  try {
    const secrets = await fetchSecretsFromGitHub();
    const versions = Object.keys(secrets).map(Number);
    const newestVersion = Math.max(...versions).toString();
    
    if (newestVersion && newestVersion !== currentTotpVersion) {
      const totpSecret = createTotpSecret(secrets[newestVersion]);
      currentTotp = new OTPAuth.TOTP({
        period: 30,
        digits: 6,
        algorithm: "SHA1",
        secret: totpSecret
      });
      currentTotpVersion = newestVersion;
      lastFetchTime = now;
    }
  } catch (error) {
    if (!currentTotp) {
      // Fallback secret if everything fails
      const fallbackData = [99, 111, 47, 88, 49, 56, 118, 65, 52, 67, 50, 104, 117, 101, 55, 94, 95, 75, 94, 49, 69, 36, 85, 64, 74, 60];
      currentTotp = new OTPAuth.TOTP({
        period: 30,
        digits: 6,
        algorithm: "SHA1",
        secret: createTotpSecret(fallbackData)
      });
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
    
    const payload = new URLSearchParams({
      reason: "init",
      productType: "mobile-web-player",
      totp: currentTotp.generate({ timestamp: localTime }),
      totpVer: currentTotpVersion || "19",
      totpServer: currentTotp.generate({ timestamp: Math.floor(serverTime / 30) })
    });

    // 4. FETCH SPOTIFY TOKEN (No SP_DC passed)
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
        // Cache this token globally for 45 mins. Avoids hitting Spotify servers repeatedly.
        'Cache-Control': 'public, s-maxage=2700, stale-while-revalidate=60',
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), { 
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
}
