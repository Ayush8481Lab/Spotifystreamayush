// Force Vercel to use the Edge Runtime for zero cold-starts
export const config = {
  runtime: 'edge',
};

// Centralized CORS Headers to allow any frontend to consume this API
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  // 1. INSTANT PREFLIGHT (CORS) RESPONSE
  // Browsers send an "OPTIONS" request before a GET request to check CORS.
  // We intercept it and return instantly, saving a massive amount of latency.
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204, // No Content
      headers: {
        ...corsHeaders,
        // Cache the CORS preflight check in the browser for 24 hours
        // This eliminates the double-request latency completely!
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // 2. Extract parameters
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q');
  const artist = searchParams.get('artist');

  if (!q) {
    return new Response(JSON.stringify({ error: 'Query parameter "q" is required' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json', ...corsHeaders } 
    });
  }

  // 3. String formatting and breakdown
  const rawString = `${q} ${artist || ''}`;
  const keywords = rawString
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (keywords.length === 0) {
    return new Response(JSON.stringify({ error: 'Invalid search parameters' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json', ...corsHeaders } 
    });
  }

  const firstKeyword = keywords[0].toLowerCase();
  const remainingKeywords = keywords.slice(1).map((k) => k.toLowerCase());

  try {
    // 4. Fetch search results from Gaana API
    const searchUrl = `https://gaanaayush.vercel.app/api/search/songs?q=${encodeURIComponent(q)}&limit=20`;
    const searchRes = await fetch(searchUrl);
    const searchJson = await searchRes.json();

    if (!searchJson.success || !searchJson.data || searchJson.data.length === 0) {
      return new Response(JSON.stringify({ error: 'No songs found' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders } 
      });
    }

    // 5. Keyword Matching Algorithm
    let bestMatch = null;
    let highestScore = -1;

    for (const track of searchJson.data) {
      const trackText = `${track.title} ${track.artists} ${track.album}`.toLowerCase();

      // COMPULSORY FIRST KEYWORD MATCH
      if (!trackText.includes(firstKeyword)) continue;

      let score = 0;
      for (const keyword of remainingKeywords) {
        if (trackText.includes(keyword)) score++;
      }

      if (score > highestScore) {
        highestScore = score;
        bestMatch = track;
      }
    }

    if (!bestMatch) {
      return new Response(JSON.stringify({ error: 'No tracks matched the compulsory keyword criteria' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders } 
      });
    }

    // 6. Fetch stream URL
    const streamUrl = `https://gaanaayush.vercel.app/api/stream/${bestMatch.track_id}`;
    const streamRes = await fetch(streamUrl);
    const streamData = await streamRes.json();

    // 7. FINAL RESPONSE & 6-HOUR CACHING
    return new Response(JSON.stringify(streamData), {
      status: streamRes.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
        // s-maxage=21600 -> Vercel's edge nodes cache the response for exactly 6 hours (6 hours * 60 * 60 = 21600 seconds)
        // stale-while-revalidate=86400 -> If a user requests after 6 hours, Vercel gives them the old cache INSTANTLY (zero wait), 
        // and updates the cache in the background for the next user. This guarantees permanent low latency.
        'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400',
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json', ...corsHeaders } 
    });
  }
}
