// Force Vercel to use the Edge Runtime for zero cold-starts and ultra-low latency
export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  // 1. Extract parameters from the URL
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q');
  const artist = searchParams.get('artist');

  if (!q) {
    return new Response(JSON.stringify({ error: 'Query parameter "q" is required' }), { status: 400 });
  }

  // 2. Break into keywords (Remove special chars, split by space)
  // e.g., 'Sharat(From "Dhurandhar" )' & 'shahswat Sachdev' 
  // becomes -> ['Sharat', 'From', 'Dhurandhar', 'shahswat', 'Sachdev']
  const rawString = `${q} ${artist || ''}`;
  const keywords = rawString
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (keywords.length === 0) {
    return new Response(JSON.stringify({ error: 'Invalid search parameters' }), { status: 400 });
  }

  const firstKeyword = keywords[0].toLowerCase();
  const remainingKeywords = keywords.slice(1).map((k) => k.toLowerCase());

  try {
    // 3. Fetch search results from Gaana search API
    // We search using the initial 'q' parameter to let the upstream API get the best initial pool
    const searchUrl = `https://gaanaayush.vercel.app/api/search/songs?q=${encodeURIComponent(q)}&limit=20`;
    const searchRes = await fetch(searchUrl);
    const searchJson = await searchRes.json();

    if (!searchJson.success || !searchJson.data || searchJson.data.length === 0) {
      return new Response(JSON.stringify({ error: 'No songs found' }), { status: 404 });
    }

    // 4. Implement Keyword Matching & Scoring Algorithm
    let bestMatch = null;
    let highestScore = -1;

    for (const track of searchJson.data) {
      // Create a combined string of title, artists, and album to check against
      const trackText = `${track.title} ${track.artists} ${track.album}`.toLowerCase();

      // RULE 1: First keyword is COMPULSORY. If it's not there, skip this track.
      if (!trackText.includes(firstKeyword)) {
        continue;
      }

      // RULE 2: Score the track based on how many remaining keywords match
      let score = 0;
      for (const keyword of remainingKeywords) {
        if (trackText.includes(keyword)) {
          score++;
        }
      }

      // Keep track of the highest scoring song
      if (score > highestScore) {
        highestScore = score;
        bestMatch = track;
      }
    }

    if (!bestMatch) {
      return new Response(JSON.stringify({ error: 'No tracks matched the compulsory keyword criteria' }), { status: 404 });
    }

    // 5. Fetch stream URL using the best match's track_id
    const streamUrl = `https://gaanaayush.vercel.app/api/stream/${bestMatch.track_id}`;
    const streamRes = await fetch(streamUrl);
    const streamData = await streamRes.json();

    // 6. Return ONLY the final response and Cache it for super low latency!
    return new Response(JSON.stringify(streamData), {
      status: streamRes.status,
      headers: {
        'Content-Type': 'application/json',
        // Cache this exact request at Vercel's Edge nodes for 1 hour. 
        // Subsequent identical requests will return in ~5ms without running the code again!
        'Cache-Control': 's-maxage=3600, stale-while-revalidate',
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', details: error.message }), { status: 500 });
  }
}
